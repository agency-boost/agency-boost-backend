import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { AssetRepository } from './asset.repository';
import { AssetSchema } from './asset.schema';
import { AssetService } from './asset.service';
import { AssetOwner, SignedUpload, StoragePort, StoredObject } from './storage.port';

/** The folder the adapter would use, mirrored so a stub key still reads like a real one. */
const ownerFolder = (o: AssetOwner) => (o.kind === 'kpm' ? o.kpmId : `company/${o.companyId}`);

const NOW = new Date('2026-09-18T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';

class StubStorage extends StoragePort {
  removed: string[] = [];
  async createSignedUpload(p: { owner: AssetOwner; folder: string }): Promise<SignedUpload> {
    return {
      uploadUrl: 'https://upload.test',
      // Unique per call, because `storageKey` is unique across the collection.
      storageKey: `dev/${ownerFolder(p.owner)}/${p.folder}/${Math.random().toString(36).slice(2)}`,
      signature: 'sig',
      fields: { signature: 'sig' },
      expiresAt: NOW,
    };
  }
  async createSignedUrl(key: string): Promise<string> {
    return `https://cdn.test/${key}?sig=abc`;
  }
  async describe(storageKey: string): Promise<StoredObject | null> {
    return { storageKey, mimeType: 'application/pdf', bytes: 1024 };
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

const member = (kpmId: string) => new RequestContext('u1', 'none', {
  membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
});

/**
 * The upload registry's isolation (P4-T11 AC-1, finished 2026-09-18).
 *
 * **`assets` was the one collection P4-T11 named and did not finish.** `AssetService` injected the
 * raw model, so nothing stopped a query from reading across offices, and `Asset` was absent from
 * `TENANT_SCOPED_MODELS` — the structural spec written to catch exactly this never asked about it.
 *
 * It matters more here than almost anywhere else: an asset's whole access control is the signed URL
 * that `urlFor` hands out, so one forgotten filter is one office reading another's document.
 */
describe('the asset registry’s tenant boundary', () => {
  let service: AssetService;
  let storage: StubStorage;

  beforeAll(async () => {
    await startMongo();
    const model = mongoose.model('AssetModelForTenancy', AssetSchema);
    storage = new StubStorage();
    service = new AssetService(
      new AssetRepository(model as never), storage, new FixedClock(NOW),
    );
  });
  afterAll(stopMongo);
  beforeEach(clearCollections);

  const upload = (ctx: RequestContext) => service.requestUpload(ctx, {
    folder: 'training', filename: 'module.pdf', mimeType: 'application/pdf', bytes: 1024,
  });

  /** A deliverable asset is a confirmed one (ADR-0040), and confirming is itself scoped. */
  const confirm = (ctx: RequestContext, storageKey: string) =>
    service.confirmUpload(ctx, storageKey);

  it('stamps the uploader’s office on the row, without the service naming it', async () => {
    const signed = await upload(member(KPM_A));

    const row = await mongoose.model('AssetModelForTenancy')
      .findOne({ storageKey: signed.storageKey }).lean().exec();
    expect(row).toMatchObject({ kpmId: KPM_A, refCount: 0, uploadState: 'pending' });
  });

  it('refuses another office’s asset as a 404, not a 403', async () => {
    const signed = await upload(member(KPM_A));
    await confirm(member(KPM_A), signed.storageKey);

    // A 403 would confirm the storage key exists, which is the thing the boundary hides.
    await expect(service.urlFor(member(KPM_B), signed.storageKey))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.urlFor(member(KPM_A), signed.storageKey))
      .resolves.toContain('sig=abc');
  });

  it('will not let another office confirm an upload it cannot see', async () => {
    const signed = await upload(member(KPM_A));

    await expect(confirm(member(KPM_B), signed.storageKey))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });

    // And it stayed undeliverable rather than being quietly confirmed by the wrong office.
    await expect(service.urlFor(member(KPM_A), signed.storageKey))
      .rejects.toMatchObject({ code: 'ASSET_NOT_CONFIRMED' });
  });

  it('will not let another office move the reference count', async () => {
    const signed = await upload(member(KPM_A));
    const count = async () => (await mongoose.model('AssetModelForTenancy')
      .findOne({ storageKey: signed.storageKey })
      .lean()
      .exec() as unknown as { refCount: number }).refCount;

    await service.retain(member(KPM_B), signed.storageKey);
    expect(await count()).toBe(0);

    await service.retain(member(KPM_A), signed.storageKey);
    expect(await count()).toBe(1);
  });

  it('never takes the reference count below zero', async () => {
    const signed = await upload(member(KPM_A));

    await service.release(member(KPM_A), signed.storageKey);
    await service.release(member(KPM_A), signed.storageKey);

    const row = await mongoose.model('AssetModelForTenancy')
      .findOne({ storageKey: signed.storageKey }).lean().exec();
    expect(row).toMatchObject({ refCount: 0 });
  });

  it('fails closed for a caller who is in no office at all', async () => {
    // The repository throws rather than querying without a filter — an absent `kpmId` must
    // never mean "every tenant" (invariant §1).
    await expect(service.urlFor(new RequestContext('u2', 'none', null), 'dev/x/y/1'))
      .rejects.toThrow(MissingTenantContextError);
  });

  it('sweeps orphans across every office, and only for a Super Admin', async () => {
    const a = await upload(member(KPM_A));
    const b = await upload(member(KPM_B));
    await service.retain(member(KPM_B), b.storageKey);
    // Backdated rather than waiting: `createdAt` is Mongoose's own stamp off the wall clock,
    // and the window is measured against the service's injected clock.
    // Through the driver, not the model: Mongoose owns `createdAt` under `timestamps`.
    await mongoose.connection.collection('assets')
      .updateMany({}, { $set: { createdAt: new Date('2026-01-01T00:00:00Z') } });

    const orphans = await service.findOrphans(RequestContext.platform('root'), 30);

    expect(orphans.map((o) => o.storageKey)).toEqual([a.storageKey]);
    // Reported, never removed: deleting somebody's file is a human decision.
    expect(storage.removed).toEqual([]);
    await expect(service.findOrphans(member(KPM_A), 30)).rejects.toThrow(MissingTenantContextError);
  });

  describe('a file duplicated into a company (P13.2-T7 AC-3, AC-5)', () => {
    const COMPANY = '66f00000000000000000c0c2';

    it('registers the copy as the company\u2019s own, confirmed and referenced by nothing, until retained', async () => {
      const source = await upload(member(KPM_A));
      const copy = await service.duplicateIntoCompany(COMPANY, {
        storageKey: source.storageKey, originalFilename: 'module.pdf',
      });

      // The destination company's folder: one owner per asset (ADR-0032).
      expect(copy.storageKey.startsWith(`dev/company/${COMPANY}/training/`)).toBe(true);
      const row = await service.companyAsset(COMPANY, copy.storageKey);
      expect(row).toMatchObject({
        companyId: COMPANY, kpmId: null, uploadState: 'confirmed', refCount: 0, originalFilename: 'module.pdf',
      });
      // No office reads it through its own repository: it is not any office's.
      await expect(service.urlFor(member(KPM_A), copy.storageKey)).rejects.toMatchObject({ status: 404 });

      // Not yet named by a template: what the orphan sweep reports, once it has waited.
      await mongoose.connection.collection('assets')
        .updateMany({}, { $set: { createdAt: new Date('2026-01-01T00:00:00Z') } });
      const before = await service.findOrphans(RequestContext.platform('root'), 30);
      expect(before.map((o) => o.storageKey)).toContain(copy.storageKey);

      await service.retainCompanyCopies(COMPANY, [copy.storageKey]);
      expect(await service.companyAsset(COMPANY, copy.storageKey)).toMatchObject({ refCount: 1 });
      const after = await service.findOrphans(RequestContext.platform('root'), 30);
      expect(after.map((o) => o.storageKey)).not.toContain(copy.storageKey);
      // Retaining nothing writes nothing.
      await service.retainCompanyCopies(COMPANY, []);
    });

    it('retains only the named company\u2019s copies', async () => {
      const source = await upload(member(KPM_A));
      const copy = await service.duplicateIntoCompany(COMPANY, { storageKey: source.storageKey, originalFilename: null });
      await service.retainCompanyCopies('66f00000000000000000c0c9', [copy.storageKey]);
      expect(await service.companyAsset(COMPANY, copy.storageKey)).toMatchObject({ refCount: 0 });
    });
  });
});
