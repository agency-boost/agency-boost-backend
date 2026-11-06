import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { up } from './0042-membership-first-sale';

const db = () => mongoose.connection.db as mongoose.mongo.Db;
const col = (name: string) => db().collection(name);

/**
 * P18.8-T4 AC-1 (ADR-0171 §1). Every membership is given its first sale from what the office already holds: its sales
 * leads' first day at *Paid and issued*, a checklist-logged closing as `manual`, and — failing both — the production
 * file's first month with a policy. Office by office, in the office's zone, earlier only, and once.
 */
describe('0042 — every membership’s first sale (ADR-0171 §1)', () => {
  beforeAll(startMongo);
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    for (const name of ['kpms', 'memberships', 'leads', 'monthlyAgentData']) await col(name).deleteMany({});
  });

  const office = async (over: Record<string, unknown> = {}) =>
    String((await col('kpms').insertOne({ code: '0417', timezone: 'Asia/Jakarta', deletedAt: null, ...over })).insertedId);
  const member = async (kpmId: string, over: Record<string, unknown> = {}) => String((await col('memberships').insertOne({
    kpmId, role: 'agent', status: 'active', joinDate: '2026-07-15', joinedAs: 'new_hire', deletedAt: null, ...over,
  })).insertedId);
  const lead = (kpmId: string, owner: string, at: string, over: Record<string, unknown> = {}) => col('leads').insertOne({
    kpmId, ownerMembershipId: owner, name: 'Ibu Ratna', type: 'sales', statusCode: 'PAID_AND_ISSUED', loggedFrom: null,
    transitions: [
      { fromStatusCode: null, toStatusCode: 'POLICY_SUBMITTED', at: new Date('2026-07-20T03:00:00Z'), byMembershipId: owner },
      { fromStatusCode: 'POLICY_SUBMITTED', toStatusCode: 'PAID_AND_ISSUED', at: new Date(at), byMembershipId: owner },
    ],
    deletedAt: null, ...over,
  });
  const month = (kpmId: string, membershipId: string, m: string, policies: number, over: Record<string, unknown> = {}) =>
    col('monthlyAgentData').insertOne({
      kpmId, membershipId, month: m, agentCode: 'A', deletedAt: null,
      policyCountMonthly: { value: policies, provenance: 'imported', sourceBatchId: null }, ...over,
    });
  const saleOf = async (id: string) => {
    const row = await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id) });
    return { date: row?.firstSaleDate ?? null, source: row?.firstSaleSource ?? null, collection: row?.firstSaleRecordCollection ?? null };
  };

  it('P18.8-T4 AC-1 is a no-op on an empty database, twice', async () => {
    expect(await up(db())).toEqual({ written: 0, unchanged: 0 });
    expect(await up(db())).toEqual({ written: 0, unchanged: 0 });
    expect(await col('memberships').countDocuments({})).toBe(0);
  });

  it('P18.8-T4 AC-1 gives each member the earliest closing since joining, from the lead, on the office’s day', async () => {
    const kpmId = await office();
    const dimas = await member(kpmId);
    await lead(kpmId, dimas, '2026-08-20T23:30:00Z');
    await lead(kpmId, dimas, '2026-09-02T03:00:00Z');
    expect(await up(db())).toEqual({ written: 1, unchanged: 0 });
    // 23:30 UTC on 20 August is 21 August in Jakarta.
    expect(await saleOf(dimas)).toEqual({ date: '2026-08-21', source: 'lead', collection: 'leads' });
  });

  it('P18.8-T4 AC-1 a checklist-logged closing is manual; failing both, the file’s first month — never before the join date', async () => {
    const kpmId = await office();
    const logged = await member(kpmId);
    await lead(kpmId, logged, '2026-08-05T03:00:00Z', { loggedFrom: 'activation_checklist' });
    const filed = await member(kpmId);
    await month(kpmId, filed, '2026-06', 4);
    await month(kpmId, filed, '2026-07', 1);
    await month(kpmId, filed, '2026-08', 2);
    expect(await up(db())).toEqual({ written: 2, unchanged: 0 });
    expect(await saleOf(logged)).toEqual({ date: '2026-08-05', source: 'manual', collection: 'leads' });
    // June is before the join month; July is the join month, read as the join date.
    expect(await saleOf(filed)).toEqual({ date: '2026-07-15', source: 'monthly_file', collection: 'monthlyAgentData' });
  });

  it('P18.8-T4 AC-1 leaves out a recruitment lead, a deleted lead, a lead short of Paid and issued, a deleted month and a month of none', async () => {
    const kpmId = await office();
    const none = await member(kpmId);
    await lead(kpmId, none, '2026-08-05T03:00:00Z', { type: 'recruitment' });
    await lead(kpmId, none, '2026-08-06T03:00:00Z', { deletedAt: new Date() });
    await col('leads').insertOne({
      kpmId, ownerMembershipId: none, name: 'Short', type: 'sales', statusCode: 'APPROVED_NOT_PAID', loggedFrom: null, deletedAt: null,
      transitions: [{ fromStatusCode: null, toStatusCode: 'APPROVED_NOT_PAID', at: new Date('2026-08-07T03:00:00Z'), byMembershipId: none }],
    });
    await month(kpmId, none, '2026-08', 3, { deletedAt: new Date() });
    await month(kpmId, none, '2026-09', 0);
    expect(await up(db())).toEqual({ written: 0, unchanged: 1 });
    expect((await saleOf(none)).date).toBeNull();
  });

  it('P18.8-T4 AC-1 moves a held date only earlier, and running it twice changes nothing', async () => {
    const kpmId = await office();
    const held = await member(kpmId, { firstSaleDate: '2026-08-10', firstSaleSource: 'lead', firstSaleRecordCollection: 'leads', firstSaleRecordId: 'x' });
    await lead(kpmId, held, '2026-08-20T03:00:00Z');
    const earlier = await member(kpmId, { firstSaleDate: '2026-09-10', firstSaleSource: 'monthly_file', firstSaleRecordCollection: 'monthlyAgentData', firstSaleRecordId: 'y' });
    await lead(kpmId, earlier, '2026-08-20T03:00:00Z');

    expect(await up(db())).toEqual({ written: 1, unchanged: 1 });
    expect(await saleOf(held)).toEqual({ date: '2026-08-10', source: 'lead', collection: 'leads' });
    expect(await saleOf(earlier)).toEqual({ date: '2026-08-20', source: 'lead', collection: 'leads' });
    expect(await up(db())).toEqual({ written: 0, unchanged: 2 });
  });

  it('P18.8-T4 AC-1 is tenant-safe: another office’s lead or month never names this office’s member', async () => {
    const a = await office();
    const b = await office({ code: '0555' });
    const rina = await member(a);
    await lead(b, rina, '2026-08-20T03:00:00Z');
    await month(b, rina, '2026-08', 1);
    expect(await up(db())).toEqual({ written: 0, unchanged: 1 });
    expect((await saleOf(rina)).date).toBeNull();
  });
});
