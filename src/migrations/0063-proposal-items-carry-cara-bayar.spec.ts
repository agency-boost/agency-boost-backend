import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { down, up } from './0063-proposal-items-carry-cara-bayar';

const KPM = '66f0000000000000000000a1';

/**
 * **P19.14-T1, T2 — every proposal in the shape of 11 November** (ADR-0254 §1, ADR-0255 §1, §2): the proposal-wide
 * `channel` and `payFrequency` moved onto each item, a Syariah proposal's items syariah under the name they showed, the
 * client given its day and empty details, nothing written to a lead, a second run a no-op — and `down` the way back.
 */
describe('0063 — a proposal’s items carry their own Cara bayar (ADR-0255 §2)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const item = (itemId: string, over: Record<string, unknown> = {}) => ({
    itemId, productId: 'p-' + itemId, productCode: 'C' + itemId, productVersion: 1,
    snapshot: {
      name: 'PRUCinta', syariahName: 'PRUCinta Syariah', typeLabel: 'JIWA', category: 'life', currencies: ['IDR'],
      fields: [], benefits: [], pdfDetail: [],
    },
    insured: { relation: 'client', name: null, age: null },
    fieldValues: {},
    premium: { amountMinor: 1_000_00, currency: 'IDR' },
    choice: null,
    ...over,
  });
  const proposal = (id: string, over: Record<string, unknown>) => ({
    _id: new mongoose.Types.ObjectId(id), kpmId: KPM, ownerMembershipId: 'm1', leadId: 'l1',
    client: { name: 'Ibu Rosa', age: 42, gender: 'female' },
    showTotal: false, status: 'draft', version: 3, deletedAt: null,
    createdAt: new Date('2026-11-05T20:00:00Z'), updatedAt: new Date('2026-11-06T01:00:00Z'),
    ...over,
  });
  const read = (id: string) => db().collection('proposals').findOne({ _id: new mongoose.Types.ObjectId(id) });

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    for (const name of ['proposals', 'kpms', 'leads']) await db().collection(name).deleteMany({});
    await db().collection('kpms').insertOne({ _id: new mongoose.Types.ObjectId(KPM), timezone: 'Asia/Jakarta' });
    await db().collection('proposals').insertMany([
      proposal('66f0000000000000000005a1', {
        channel: 'syariah', payFrequency: 'annual',
        items: [item('a'), item('b', { snapshot: { ...item('b').snapshot, name: 'PRUWell', syariahName: null, category: 'health' }, premium: { amountMinor: null, currency: 'IDR' } })],
      }),
      proposal('66f0000000000000000005a2', {
        channel: 'conventional', payFrequency: 'monthly', deletedAt: new Date(), items: [item('c', { insured: { relation: 'child', name: 'Nadia', age: 8 } })],
      }),
      // Already in the new shape: never touched.
      proposal('66f0000000000000000005a3', {
        client: { name: 'X', age: 30, ageSetOn: '2026-11-12', gender: 'male', details: { status: null, dependants: null, occupation: null, city: 'Solo', needs: [], needsOther: null } },
        items: [],
      }),
    ]);
    await db().collection('leads').insertOne({ _id: new mongoose.Types.ObjectId(), kpmId: KPM, name: 'Ibu Rosa', age: 42, gender: 'female' });
  });

  it('P19.14-T2 AC-1 moves channel and Cara bayar onto each item, under the name each showed, and keeps the old for down', async () => {
    expect(await up(db())).toEqual({ proposals: 2, items: 3, renamed: 1 });
    const syariah = await read('66f0000000000000000005a1');
    expect(syariah).not.toHaveProperty('channel');
    expect(syariah).not.toHaveProperty('payFrequency');
    expect(syariah!.items[0]).toMatchObject({
      payFrequency: 'annual', smoker: null, payTerm: null, up: null, fixedField: 'none', rateTableVersionId: null,
      rateTableEffectiveFrom: null, calcNote: null, premium: { amountMinor: 1_000_00, currency: 'IDR' },
      insured: { relation: 'client', name: null, age: null, gender: null },
      snapshot: {
        name: 'PRUCinta Syariah', isSyariah: true, needTag: 'FAMILY', calcType: 'manual', payTerms: [], planRule: null,
        frequencies: ['monthly', 'quarterly', 'semiannual', 'annual'], smokerRated: false, entryAge: null,
        limits: { upStep: null, upMin: null, upMax: null, premiumMin: null, premiumMax: null },
      },
    });
    // A premium never typed is null; a product without a syariah name keeps its own.
    expect(syariah!.items[1]).toMatchObject({ premium: null, snapshot: { name: 'PRUWell', isSyariah: true, needTag: 'HOSPITAL' } });
    expect(syariah!.migrated0063).toEqual({ channel: 'syariah', payFrequency: 'annual', names: { a: 'PRUCinta' } });
  });

  it('P19.14-T1 AC-4 gives the client its day on the KPM’s calendar and empty details, and writes nothing to a lead', async () => {
    const lead = await db().collection('leads').findOne({});
    await up(db());
    expect((await read('66f0000000000000000005a1'))!.client).toEqual({
      name: 'Ibu Rosa', age: 42, ageSetOn: '2026-11-06', gender: 'female',
      details: { status: null, dependants: null, occupation: null, city: null, needs: [], needsOther: null },
    });
    expect(await db().collection('leads').findOne({})).toEqual(lead);
  });

  it('P19.14-T2 AC-1 writes a soft-deleted proposal too, a conventional one’s items not syariah, and leaves a new one alone', async () => {
    const fresh = await read('66f0000000000000000005a3');
    await up(db());
    expect((await read('66f0000000000000000005a2'))!.items[0]).toMatchObject({
      payFrequency: 'monthly', snapshot: { name: 'PRUCinta', isSyariah: false }, insured: { relation: 'child', name: 'Nadia', age: 8, gender: null },
    });
    expect(await read('66f0000000000000000005a3')).toEqual(fresh);
  });

  it('P19.14-T2 AC-1 runs twice as a no-op', async () => {
    await up(db());
    const after = await db().collection('proposals').find({}).toArray();
    expect(await up(db())).toEqual({ proposals: 0, items: 0, renamed: 0 });
    expect(await db().collection('proposals').find({}).toArray()).toEqual(after);
  });

  it('P19.14-T2 AC-1 down puts the 3 November shape back', async () => {
    const before = await read('66f0000000000000000005a1');
    await up(db());
    expect((await down(db())).proposals).toBe(3);
    const back = await read('66f0000000000000000005a1');
    expect(back).toMatchObject({ channel: 'syariah', payFrequency: 'annual', client: { name: 'Ibu Rosa', age: 42, gender: 'female' } });
    expect(back!.items).toEqual(before!.items);
    expect(back).not.toHaveProperty('migrated0063');
    // A proposal made since: syariah where an item is, its first item's Cara bayar, else monthly.
    expect(await read('66f0000000000000000005a3')).toMatchObject({ channel: 'conventional', payFrequency: 'monthly', client: { name: 'X', age: 30, gender: 'male' } });
  });
});
