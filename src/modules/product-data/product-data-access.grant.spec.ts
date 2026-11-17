import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { ProductDataAccess } from './product-data-access.service';

const PRU = '66f0000000000000000000c1';
const MANU = '66f0000000000000000000c2';
const ALLIANZ = '66f0000000000000000000c3';
const KPM = '66f0000000000000000000a1';

/** A KPM Admin of a Prudential KPM, with the companies her *Kelola data produk* ticks. */
function maya(companies: string[], over: { status?: 'active' | 'pending'; admin?: boolean; session?: boolean } = {}) {
  return new RequestContext(
    'maya', 'none',
    {
      membershipId: 'mem-maya', kpmId: KPM, orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: over.status ?? 'active',
      isKpmOwner: false, isKpmAdmin: over.admin ?? true, directCount: 0,
    },
    over.session ? 'root' : null, null, false, over.session ?? false, undefined, companies,
  );
}

/**
 * **P19.15-T4 AC-2, AC-3 — `ProductDataAccess` for a product data manager** (ADR-0260 §2, §3): a holder reads and
 * manages **the companies ticked**, reads her own company read-only when it is not ticked, and another company not
 * ticked is `404`; a grant on record holds nothing once she is no longer an active Admin; a support session only looks.
 */
describe('P19.15-T4 ProductDataAccess — a Kelola data produk holder', () => {
  let access: ProductDataAccess;

  beforeAll(async () => {
    await startMongo();
    access = new ProductDataAccess(
      mongoose.model(Company.name, CompanySchema) as never, mongoose.model(Kpm.name, KpmSchema) as never,
    );
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    const db = mongoose.connection.db!;
    await db.collection('companies').deleteMany({});
    await db.collection('kpms').deleteMany({});
    await db.collection('companies').insertMany([PRU, MANU, ALLIANZ].map((id, i) => ({
      _id: new mongoose.Types.ObjectId(id), name: ['Prudential', 'Manulife', 'Allianz'][i], slug: `c${i}`, deletedAt: null,
    })));
    await db.collection('kpms').insertOne({ _id: new mongoose.Types.ObjectId(KPM), companyId: PRU, code: '0417', deletedAt: null });
  });

  it('P19.15-T4 AC-2 a ticked company: read and manage', async () => {
    expect(await access.canRead(maya([MANU]), MANU)).toBe(true);
    expect(await access.canManage(maya([MANU]), MANU)).toBe(true);
    await expect(access.assertManage(maya([MANU]), MANU)).resolves.toBeUndefined();
    expect(await access.canManage(maya([PRU]), PRU)).toBe(true);
  });

  it('P19.15-T4 AC-2 a company not ticked: her own read-only (403 on a write), any other 404', async () => {
    expect(await access.canRead(maya([MANU]), PRU)).toBe(true);
    expect(await access.canManage(maya([MANU]), PRU)).toBe(false);
    await expect(access.assertManage(maya([MANU]), PRU)).rejects.toMatchObject({ code: 'PERM_DENIED' });
    expect(await access.canRead(maya([MANU]), ALLIANZ)).toBe(false);
    await expect(access.assertRead(maya([MANU]), ALLIANZ)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(access.assertManage(maya([MANU]), ALLIANZ)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('P19.15-T4 AC-2 a grant on record holds nothing for somebody no longer an active Admin', async () => {
    expect(await access.canRead(maya([MANU], { admin: false }), MANU)).toBe(false);
    expect(await access.canManage(maya([MANU], { status: 'pending' }), MANU)).toBe(false);
  });

  it('P19.15-T4 AC-2 a support session as the holder reads the ticked company and manages nothing', async () => {
    const session = maya([MANU], { session: true });
    expect(await access.canRead(session, MANU)).toBe(true);
    expect(await access.canManage(session, MANU)).toBe(false);
  });
});
