import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AssetService } from './asset.service';
import { ASSET_LIMITS, SignedUpload, StoragePort } from './storage.port';

class StubStorage extends StoragePort {
  removed: string[] = [];
  async createSignedUpload(p: { kpmId: string; folder: string }): Promise<SignedUpload> {
    return {
      uploadUrl: 'https://upload.test',
      storageKey: `dev/${p.kpmId}/${p.folder}/01ABC`,
      signature: 'sig',
      expiresAt: new Date('2026-09-04T00:10:00Z'),
    };
  }
  async createSignedUrl(key: string): Promise<string> {
    return `https://cdn.test/${key}?sig=abc`;
  }
  async remove(key: string): Promise<void> {
    this.removed.push(key);
  }
}

const ctx = new RequestContext('u1', 'none', {
  membershipId: 'mem-1', kpmId: 'kpm-a', orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
});

function makeService(findOneResult: unknown = null) {
  const created: Record<string, unknown>[] = [];
  const assets = {
    create: jest.fn(async (d: Record<string, unknown>) => { created.push(d); return d; }),
    findOne: () => ({ exec: async () => findOneResult }),
    updateOne: jest.fn(() => ({ exec: async () => ({}) })),
    find: () => ({ exec: async () => [] }),
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
    expect(created[0]).toMatchObject({
      kpmId: 'kpm-a', refCount: 0, scanStatus: 'pending',
      uploadedByMembershipId: 'mem-1', originalFilename: 'module.pdf',
    });
  });

  describe('delivery URLs', () => {
    it('refuses a file that has not been scanned yet', async () => {
      const { service } = makeService({ scanStatus: 'pending' });
      await expect(service.urlFor(ctx, 'dev/kpm-a/x/1')).rejects.toMatchObject({
        code: 'ASSET_SCAN_PENDING',
      });
    });

    it('404s an asset belonging to another tenant', async () => {
      const { service } = makeService(null);
      await expect(service.urlFor(ctx, 'dev/kpm-b/x/1')).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('returns a signed URL for a clean asset', async () => {
      const { service } = makeService({ scanStatus: 'clean' });
      await expect(service.urlFor(ctx, 'dev/kpm-a/x/1')).resolves.toContain('sig=abc');
    });
  });

  describe('orphan reporting', () => {
    it('finds assets referenced by nothing, older than the retention window', async () => {
      const queries: Record<string, unknown>[] = [];
      const assets = {
        create: jest.fn(),
        findOne: () => ({ exec: async () => null }),
        updateOne: jest.fn(() => ({ exec: async () => ({}) })),
        find: jest.fn((q: Record<string, unknown>) => {
          queries.push(q);
          return { exec: async () => [{ storageKey: 'dev/kpm-a/x/1' }] };
        }),
      };
      const service = new AssetService(
        assets as never,
        new StubStorage(),
        new FixedClock(new Date('2026-09-04T00:00:00Z')),
      );

      const orphans = await service.findOrphans(30);

      expect(orphans).toHaveLength(1);
      expect(queries[0]).toMatchObject({ refCount: 0, deletedAt: null });
      // 30 days before the injected clock, not before the real one.
      expect((queries[0].createdAt as { $lt: Date }).$lt.toISOString()).toBe(
        '2026-08-05T00:00:00.000Z',
      );
    });

    it('reports orphans rather than deleting them — deletion is a human decision', async () => {
      const { service, storage } = makeService();
      await service.findOrphans();
      expect(storage.removed).toEqual([]);
    });
  });

  describe('reference counting', () => {
    it('never decrements below zero', async () => {
      const { service, assets } = makeService();
      await service.release(ctx, 'dev/kpm-a/x/1');
      const filter = (assets.updateOne as jest.Mock).mock.calls[0][0];
      expect(filter.refCount).toEqual({ $gt: 0 });
    });

    it('scopes retain and release to the caller’s tenant', async () => {
      const { service, assets } = makeService();
      await service.retain(ctx, 'dev/kpm-a/x/1');
      expect((assets.updateOne as jest.Mock).mock.calls[0][0].kpmId).toBe('kpm-a');
    });
  });
});
