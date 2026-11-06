import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import { checkFields } from '@/domain/branding/branding-fields';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { KpmBrandingRepository } from './kpm-branding.repository';
import { KpmBranding, KpmBrandingSchema } from './kpm-branding.schema';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b2';
const member = (kpmId: string) => new RequestContext(`u-${kpmId}`, 'none', {
  membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);

/**
 * **A KPM's branding stays its own** (P19.6-T1 AC-12; invariant §1; ADR-0218 §1): KPM B never reads, writes or resets KPM
 * A's row through the repository, a context with no KPM is refused before any query, and B cannot name A's pictures in its
 * own *Simpan*. The HTTP half — 200 for B with nothing of A's, 400 for A's picture — is `branding.int.spec.ts`'s.
 */
describe('P19.6-T1 AC-12 kpmBranding is tenant-scoped', () => {
  let repo: KpmBrandingRepository;

  beforeAll(async () => {
    await startMongo();
    repo = new KpmBrandingRepository((mongoose.models[KpmBranding.name] ?? mongoose.model(KpmBranding.name, KpmBrandingSchema)) as never);
  }, 60_000);
  afterAll(async () => { await stopMongo(); });
  beforeEach(async () => { await clearCollections(); });

  it('P19.6-T1 AC-12 another KPM reads nothing of this one’s, and its write and reset reach no row of it', async () => {
    const a = await repo.insert(member(KPM_A), { primary: '#0a6e5c', secondary: '#1b2b4b' });
    expect(await repo.live(member(KPM_B))).toBeNull();
    expect(await repo.findById(member(KPM_B), String(a._id))).toBeNull();
    expect(await repo.writeAt(member(KPM_B), String(a._id), 1, { primary: '#808080' })).toBeNull();
    expect(await repo.softDeleteAt(member(KPM_B), String(a._id), 1, new Date())).toBeNull();
    const still = await repo.live(member(KPM_A));
    expect(still).toMatchObject({ primary: '#0a6e5c', version: 1, deletedAt: null });
  });

  it('P19.6-T1 AC-12 the public read names the link’s KPM, never an absent filter; no KPM is refused before a query', async () => {
    await repo.insert(member(KPM_A), { primary: '#0a6e5c', secondary: '#1b2b4b' });
    expect(await repo.live(RequestContext.tenantRead(KPM_A, 'kpm-branding'))).not.toBeNull();
    expect(await repo.live(RequestContext.tenantRead(KPM_B, 'kpm-branding'))).toBeNull();
    await expect(repo.live(RequestContext.platform('root'))).rejects.toBeInstanceOf(MissingTenantContextError);
  });

  it('P19.6-T1 AC-12 a KPM cannot name another KPM’s, or a company’s, picture in its own branding', () => {
    const theirs = `production/${KPM_A}/branding/01JC0000000000000000000001`;
    expect(checkFields({ logo: { key: theirs } }, KPM_B)).toMatchObject({ ok: false, problem: { problem: 'notYours', field: 'logo' } });
    expect(checkFields({ logo: { key: theirs } }, KPM_A)).toMatchObject({ ok: true });
    expect(checkFields({ mascot: { default: 'production/company/c1/branding/01JC0000000000000000000002' } }, KPM_A))
      .toMatchObject({ ok: false, problem: { field: 'mascot.default' } });
  });
});
