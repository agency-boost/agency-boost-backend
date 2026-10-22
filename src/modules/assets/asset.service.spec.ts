import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AssetService } from './asset.service';
import { ASSET_LIMITS, DOCUMENT_MIME_TYPES } from '@/domain/constants';
import {
  AssetOwner, SignedUpload, StoragePort, StoredObject,
} from './storage.port';

/** The folder the adapter would use, mirrored so a stub key still reads like a real one. */
const ownerFolder = (o: AssetOwner) => (o.kind === 'kpm' ? o.kpmId : `company/${o.companyId}`);

class StubStorage extends StoragePort {
  removed: string[] = [];
  async createSignedUpload(p: { owner: AssetOwner; folder: string }): Promise<SignedUpload> {
    return {
      uploadUrl: 'https://upload.test',
      storageKey: `dev/${ownerFolder(p.owner)}/${p.folder}/01ABC`,
      signature: 'sig',
      fields: { signature: 'sig' },
      expiresAt: new Date('2026-09-04T00:10:00Z'),
    };
  }
  async createSignedUrl(key: string): Promise<string> {
    return `https://cdn.test/${key}?sig=abc`;
  }
  /** What storage says it holds. `null` is "the bytes never came". */
  stored: StoredObject | null = { storageKey: 'k', mimeType: 'application/pdf', bytes: 2048 };
  async describe(): Promise<StoredObject | null> {
    return this.stored;
  }
  async remove(key: string): Promise<void> {
    this.removed.push(key);
  }
  /** A copy into another owner's folder (P13.2-T7). */
  async copy(p: { storageKey: string; owner: AssetOwner; folder: string }): Promise<StoredObject> {
    return { storageKey: `dev/${ownerFolder(p.owner)}/${p.folder}/copy-of-${p.storageKey.split('/').pop()}`, mimeType: 'application/pdf', bytes: 1024 };
  }
  /** A server-held file (Phase 17's seed); nothing here stores one. */
  async putObject(p: { owner: AssetOwner; folder: string; name: string; mimeType: string; body: Buffer }) {
    return { storageKey: `dev/${ownerFolder(p.owner)}/${p.folder}/${p.name}`, mimeType: p.mimeType, bytes: p.body.length, sent: true };
  }
}

const ctx = new RequestContext('u1', 'none', {
  membershipId: 'mem-1', kpmId: 'kpm-a', orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
});
/** The orphan sweep is a platform job, and the unscoped read refuses anybody else. */
const superAdmin = RequestContext.platform('root');

/**
 * The repository, doubled at its own interface rather than at Mongoose's.
 *
 * `AssetService` used to inject the raw model, so this file doubled `find().exec()` chains — and a
 * double shaped like a model is one that cannot tell you whether `kpmId` was applied, because
 * applying it was the caller's job. It is the repository's now, so these tests assert what the
 * service asks for and `asset.tenancy.spec.ts` asserts the boundary itself, over a real database.
 */
function makeService(findOneResult: unknown = null) {
  const created: Record<string, unknown>[] = [];
  const assets = {
    create: jest.fn(async (_c: unknown, d: Record<string, unknown>) => { created.push(d); return d; }),
    findOne: jest.fn(async () => findOneResult),
    updateById: jest.fn(async (_c: unknown, _id: string, u: Record<string, unknown>) => u.$set),
    updateMany: jest.fn(async () => 1),
    findAcrossAllTenants: jest.fn(async () => []),
  };
  const storage = new StubStorage();
  const service = new AssetService(
    assets as never, storage, new FixedClock(new Date('2026-09-04T00:00:00Z')),
  );
  return { service, created, assets, storage };
}

describe('AssetService', () => {
  describe('limits are enforced before a signature is issued', () => {
    it('rejects an oversized file without calling storage', async () => {
      const { service, created } = makeService();
      await expect(
        service.requestUpload(ctx, {
          folder: 'training', filename: 'big.pdf', mimeType: 'application/pdf',
          bytes: ASSET_LIMITS.MAX_BYTES + 1,
        }),
      ).rejects.toMatchObject({ code: 'ASSET_TOO_LARGE' });
      expect(created).toHaveLength(0);
    });

    it('rejects a disallowed type', async () => {
      const { service } = makeService();
      await expect(
        service.requestUpload(ctx, {
          folder: 'training', filename: 'x.exe',
          mimeType: 'application/x-msdownload', bytes: 10,
        }),
      ).rejects.toMatchObject({ code: 'ASSET_TYPE_NOT_ALLOWED' });
    });

    it('refuses a user with no membership', async () => {
      const { service } = makeService();
      const noTenant = new RequestContext('u2', 'none', null);
      await expect(
        service.requestUpload(noTenant, {
          folder: 'x', filename: 'a.pdf', mimeType: 'application/pdf', bytes: 10,
        }),
      ).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
    });
  });

  it('folders the key by environment and tenant, and registers the asset', async () => {
    const { service, created } = makeService();
    const signed = await service.requestUpload(ctx, {
      folder: 'training', filename: 'module.pdf', mimeType: 'application/pdf', bytes: 1024,
    });
    expect(signed.storageKey).toBe('dev/kpm-a/training/01ABC');
    // No `kpmId` here any more, and that is the change: the repository injects it, so the
    // service cannot forget it and a test cannot prove it did by inspecting the document.
    expect(created[0]).toMatchObject({
      refCount: 0, uploadState: 'pending',
      uploadedByMembershipId: 'mem-1', originalFilename: 'module.pdf',
    });
    expect(created[0]).not.toHaveProperty('kpmId');
  });

  describe('delivery URLs', () => {
    it('refuses a file whose bytes are not known to have arrived', async () => {
      const { service } = makeService({ uploadState: 'pending' });
      await expect(service.urlFor(ctx, 'dev/kpm-a/x/1')).rejects.toMatchObject({
        code: 'ASSET_NOT_CONFIRMED',
      });
    });

    it('404s an asset belonging to another tenant', async () => {
      const { service } = makeService(null);
      await expect(service.urlFor(ctx, 'dev/kpm-b/x/1')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('returns a signed URL for a confirmed asset', async () => {
      const { service } = makeService({ uploadState: 'confirmed' });
      await expect(service.urlFor(ctx, 'dev/kpm-a/x/1')).resolves.toContain('sig=abc');
    });
  });

  describe('confirming an upload (ADR-0040)', () => {
    it('records what storage reports, not what the client claimed', async () => {
      // `requestUpload` wrote 'image/png' and 10 bytes before a single byte was sent.
      const { service, assets, storage } = makeService({ _id: 'a1', uploadState: 'pending' });
      storage.stored = { storageKey: 'k', mimeType: 'application/pdf', bytes: 2048 };

      await service.confirmUpload(ctx, 'dev/kpm-a/x/1');

      expect((assets.updateById as jest.Mock).mock.calls[0][2].$set).toEqual({
        mimeType: 'application/pdf', bytes: 2048, uploadState: 'confirmed',
      });
    });

    it('refuses when the bytes never arrived', async () => {
      const { service, storage } = makeService({ _id: 'a1', uploadState: 'pending' });
      storage.stored = null;

      await expect(service.confirmUpload(ctx, 'dev/kpm-a/x/1'))
        .rejects.toMatchObject({ code: 'ASSET_NOT_UPLOADED' });
    });

    it('re-checks the limits against what really landed', async () => {
      // The allow-list is enforced twice on purpose: a file that got past the first check by
      // mis-declaring its type does not get past the second.
      const { service, storage } = makeService({ _id: 'a1', uploadState: 'pending' });
      storage.stored = { storageKey: 'k', mimeType: 'application/x-msdownload', bytes: 10 };

      await expect(service.confirmUpload(ctx, 'dev/kpm-a/x/1'))
        .rejects.toMatchObject({ code: 'ASSET_TYPE_NOT_ALLOWED' });

      storage.stored = {
        storageKey: 'k', mimeType: 'application/pdf', bytes: ASSET_LIMITS.MAX_BYTES + 1,
      };
      await expect(service.confirmUpload(ctx, 'dev/kpm-a/x/1'))
        .rejects.toMatchObject({ code: 'ASSET_TOO_LARGE' });
    });

    /*
     * P18.7-T2 (the code review's L6): storage reports the type the bytes are (`content-sniff.ts`), which may differ
     * from the claim — a PNG saved as `.jpg` — and the route's own list is what decides whether the file stays.
     */
    it('P18.7-T2 a PNG claimed as a JPEG, on an image route: accepted, and recorded as image/png', async () => {
      const { service, assets, storage } = makeService({ _id: 'a1', uploadState: 'pending', mimeType: 'image/jpeg' });
      storage.stored = { storageKey: 'k', mimeType: 'image/png', bytes: 2048 };

      const confirmed = await service.confirmUpload(ctx, 'dev/kpm-a/events/1');

      expect(confirmed).toMatchObject({ mimeType: 'image/png', uploadState: 'confirmed' });
      expect((assets.updateById as jest.Mock).mock.calls[0][2].$set).toEqual({
        mimeType: 'image/png', bytes: 2048, uploadState: 'confirmed',
      });
    });

    it('P18.7-T2 a JPEG on a PDF-only route: refused 415 by the route’s list, and nothing recorded', async () => {
      const { service, assets, storage } = makeService({ _id: 'a1', uploadState: 'pending', mimeType: 'application/pdf' });
      storage.stored = { storageKey: 'k', mimeType: 'image/jpeg', bytes: 2048 };

      await expect(service.confirmUpload(ctx, 'dev/kpm-a/products/1', DOCUMENT_MIME_TYPES))
        .rejects.toMatchObject({ code: 'ASSET_TYPE_NOT_ALLOWED', status: 415, details: { mimeType: 'image/jpeg' } });
      expect(assets.updateById).not.toHaveBeenCalled();
    });

    it.each([
      ['the whole allow-list', ASSET_LIMITS.ALLOWED_MIME_TYPES],
      ['a PDF-only route', DOCUMENT_MIME_TYPES],
    ])('P18.7-T2 an .exe claimed as a PDF — storage reports octet-stream — on %s: refused, and nothing recorded', async (_route, allowed) => {
      const { service, assets, storage } = makeService({ _id: 'a1', uploadState: 'pending', mimeType: 'application/pdf' });
      storage.stored = { storageKey: 'k', mimeType: 'application/octet-stream', bytes: 4096 };

      await expect(service.confirmUpload(ctx, 'dev/kpm-a/recruitment-pitch/1', allowed))
        .rejects.toMatchObject({ code: 'ASSET_TYPE_NOT_ALLOWED', status: 415 });
      expect(assets.updateById).not.toHaveBeenCalled();
    });

    it('404s an asset belonging to another tenant, without asking storage', async () => {
      const { service, storage } = makeService(null);
      const asked = jest.spyOn(storage, 'describe');

      await expect(service.confirmUpload(ctx, 'dev/kpm-b/x/1'))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(asked).not.toHaveBeenCalled();
    });
  });

  describe('orphan reporting', () => {
    it('finds assets referenced by nothing, older than the retention window', async () => {
      const queries: Record<string, unknown>[] = [];
      const assets = {
        create: jest.fn(),
        findOne: jest.fn(async () => null),
        updateMany: jest.fn(async () => 1),
        findAcrossAllTenants: jest.fn(async (_c: unknown, q: Record<string, unknown>) => {
          queries.push(q);
          return [{ storageKey: 'dev/kpm-a/x/1' }];
        }),
      };
      const service = new AssetService(
        assets as never,
        new StubStorage(),
        new FixedClock(new Date('2026-09-04T00:00:00Z')),
      );

      const orphans = await service.findOrphans(superAdmin, 30);

      expect(orphans).toHaveLength(1);
      expect(queries[0]).toMatchObject({ refCount: 0 });
      // 30 days before the injected clock, not before the real one.
      expect((queries[0].createdAt as { $lt: Date }).$lt.toISOString()).toBe(
        '2026-08-05T00:00:00.000Z',
      );
    });

    it('sweeps every tenant, through the named unscoped read', async () => {
      // Storage accounting is a platform job: a per-office sweep would never see the
      // office that has been archived, which is where orphans collect.
      const { service, assets } = makeService();
      await service.findOrphans(superAdmin);
      expect(assets.findAcrossAllTenants).toHaveBeenCalled();
    });

    it('reports orphans rather than deleting them — deletion is a human decision', async () => {
      const { service, storage } = makeService();
      await service.findOrphans(superAdmin);
      expect(storage.removed).toEqual([]);
    });
  });

  describe('reference counting', () => {
    it('never decrements below zero', async () => {
      const { service, assets } = makeService();
      await service.release(ctx, 'dev/kpm-a/x/1');
      const filter = (assets.updateMany as jest.Mock).mock.calls[0][1];
      expect(filter.refCount).toEqual({ $gt: 0 });
    });

    it('sends the caller’s context, so the repository scopes retain and release', async () => {
      const { service, assets } = makeService();
      await service.retain(ctx, 'dev/kpm-a/x/1');
      expect((assets.updateMany as jest.Mock).mock.calls[0][0]).toBe(ctx);
    });
  });
});
