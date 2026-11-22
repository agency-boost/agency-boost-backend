import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { ProductDataAccess } from './product-data-access.service';
import { ProductDataCompaniesService } from './product-data-companies.service';

const PRU = '66f0000000000000000000c1';
const MANU = '66f0000000000000000000c2';
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** An Admin of `kpmId`, with the companies her *Kelola data produk* ticks. */
function adminOf(kpmId: string, companies: string[] = []) {
  return new RequestContext(
    `admin-${kpmId}`, 'none',
    {
      membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
      isKpmOwner: false, isKpmAdmin: true, directCount: 0,
    },
    null, null, false, false, undefined, companies,
  );
}

/**
 * **P19.15-T4 AC-3 — *Data produk* across KPMs and companies** (ADR-0260 §3, §5): an insurer's proposal data is the
 * company's, so the boundary is the company. KPM A (Prudential)'s Admin reads Prudential's, never Manulife's — KPM B's
 * company — which is `404` to her, existence unconfirmed; only a *Kelola data produk* that ticks Manulife opens it, and
 * that grant is hers, read by her own user, never another KPM's Admin's.
 */
describe('P19.15-T4 Data produk across KPMs', () => {
  let access: ProductDataAccess;
  let companies: ProductDataCompaniesService;

  beforeAll(async () => {
    await startMongo();
    const companyModel = mongoose.model(Company.name, CompanySchema) as never;
    const kpmModel = mongoose.model(Kpm.name, KpmSchema) as never;
    access = new ProductDataAccess(companyModel, kpmModel);
    companies = new ProductDataCompaniesService(companyModel, kpmModel, access);
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    const db = mongoose.connection.db!;
    for (const name of ['companies', 'kpms']) await db.collection(name).deleteMany({});
    await db.collection('companies').insertMany([
      { _id: oid(PRU), name: 'Prudential', slug: 'prudential', kind: 'insurer', deletedAt: null },
      { _id: oid(MANU), name: 'Manulife', slug: 'manulife', kind: 'insurer', deletedAt: null },
    ]);
    await db.collection('kpms').insertMany([
      { _id: oid(KPM_A), companyId: PRU, code: '0417', deletedAt: null },
      { _id: oid(KPM_B), companyId: MANU, code: '0900', deletedAt: null },
    ]);
  });

  it('P19.15-T4 AC-3 KPM A\'s Admin reads her own company only; KPM B\'s company is 404 to her', async () => {
    expect((await companies.readable(adminOf(KPM_A))).items.map((c) => c.companyId)).toEqual([PRU]);
    await expect(access.assertRead(adminOf(KPM_A), MANU)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await companies.readable(adminOf(KPM_B))).items.map((c) => c.companyId)).toEqual([MANU]);
    await expect(access.assertRead(adminOf(KPM_B), PRU)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('P19.15-T4 AC-2 only her own grant opens another company — and only the one it ticks', async () => {
    const holder = adminOf(KPM_A, [MANU]);
    expect((await companies.readable(holder)).items.map((c) => [c.companyId, c.canManage]))
      .toEqual([[PRU, false], [MANU, true]]);
    // KPM B's Admin holds no grant of her own: KPM A's grant is not hers.
    expect((await companies.readable(adminOf(KPM_B))).items.map((c) => c.canManage)).toEqual([false]);
  });
});
