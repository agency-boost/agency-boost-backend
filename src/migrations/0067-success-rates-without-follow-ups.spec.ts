import mongoose from 'mongoose';
import { SEED_RATIO_DEFINITIONS } from '@/domain/constants/activity-taxonomy';
import { startMongo, stopMongo } from '../../test/mongo';
import { up } from './0067-success-rates-without-follow-ups';

const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const KPM_C = '66f0000000000000000000c1';

const OLD_SELL = { numerator: ['SELL_SUBMISSION'], denominator: ['SELL_PRESENTATION', 'SELL_FOLLOWUP'] };
const NEW_SELL = { numerator: ['SELL_SUBMISSION'], denominator: ['SELL_PRESENTATION'] };
const OLD_RECRUIT = { numerator: ['RECRUIT_AGENT_CODE'], denominator: ['RECRUIT_PRESENTATION', 'RECRUIT_FOLLOWUP'] };
const NEW_RECRUIT = { numerator: ['RECRUIT_AGENT_CODE'], denominator: ['RECRUIT_PRESENTATION'] };

/**
 * **The success rates count no follow-up** (P19.17-T1 AC-6; ADR-0267 §6; the owner's part D): every office ratio still on
 * the standard formula moves with its standard, an Owner's own formula is kept, and each office's newest snapshot and every
 * `ratio_set` template move the same way. No version moves; a second run, and an Owner who puts follow-ups back later,
 * are left alone.
 */
describe('0067 — Selling and Recruitment success rates without follow-ups (ADR-0267 §6)', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const id = () => new mongoose.Types.ObjectId();
  const ratio = (kpmId: string, code: string, formula: { numerator: string[]; denominator: string[] }, extra: Record<string, unknown> = {}) => ({
    _id: id(), kpmId, code, label: code, ...formula, benchmark: 0.3, comparison: 'gte', displayUnit: 'percent',
    origin: 'platform', standardNumerator: formula.numerator, standardDenominator: formula.denominator,
    version: 3, status: 'active', deletedAt: null, ...extra,
  });
  const read = async (collection: string, _id: mongoose.Types.ObjectId) => db().collection(collection).findOne({ _id });

  beforeAll(startMongo);
  afterAll(stopMongo);
  beforeEach(async () => {
    for (const { name } of await db().listCollections({}, { nameOnly: true }).toArray()) await db().collection(name).drop();
  });

  it('P19.17-T1 AC-6 the seed’s two success rates count presentations alone', () => {
    const byCode = new Map(SEED_RATIO_DEFINITIONS.map((r) => [r.code, r]));
    expect(byCode.get('SELLING_SUCCESS_RATE')).toMatchObject(NEW_SELL);
    expect(byCode.get('RECRUITMENT_SUCCESS_RATE')).toMatchObject(NEW_RECRUIT);
  });

  it('P19.17-T1 AC-6 moves every office row still on the standard formula, its standard with it, and keeps an Owner’s own', async () => {
    const rows = {
      sell: ratio(KPM_A, 'SELLING_SUCCESS_RATE', OLD_SELL),
      recruit: ratio(KPM_A, 'RECRUITMENT_SUCCESS_RATE', OLD_RECRUIT),
      // Order is display, never meaning: the same set of codes is the standard formula.
      reordered: ratio(KPM_B, 'SELLING_SUCCESS_RATE', { numerator: ['SELL_SUBMISSION'], denominator: ['SELL_FOLLOWUP', 'SELL_PRESENTATION'] }),
      archived: ratio(KPM_C, 'SELLING_SUCCESS_RATE', OLD_SELL, { status: 'archived' }),
      // An Owner who changed the formula keeps it, and keeps the standard it diverged from.
      owners: ratio(KPM_B, 'RECRUITMENT_SUCCESS_RATE', { numerator: ['RECRUIT_AGENT_CODE'], denominator: ['RECRUIT_FOLLOWUP'] }, {
        standardNumerator: OLD_RECRUIT.numerator, standardDenominator: OLD_RECRUIT.denominator,
      }),
      // An office's own ratio under the code, a soft-deleted row and another ratio are not the seed's to move.
      office: ratio(KPM_C, 'RECRUITMENT_SUCCESS_RATE', OLD_RECRUIT, { origin: 'office', standardNumerator: null, standardDenominator: null }),
      deleted: ratio(KPM_C, 'SELLING_SUCCESS_RATE', OLD_SELL, { deletedAt: new Date('2026-11-01T00:00:00Z') }),
      balance: ratio(KPM_A, 'SELLING_VS_RECRUITMENT', { numerator: ['SELL_FOLLOWUP'], denominator: ['RECRUIT_FOLLOWUP'] }),
    };
    await db().collection('ratioDefinitions').insertMany(Object.values(rows));

    expect(await up(db())).toEqual({ ratios: 4, kept: 1, snapshots: 0, templates: 0 });

    for (const [key, formula] of [['sell', NEW_SELL], ['recruit', NEW_RECRUIT], ['reordered', NEW_SELL], ['archived', NEW_SELL]] as const) {
      const row = await read('ratioDefinitions', rows[key]._id);
      expect({ key, numerator: row?.numerator, denominator: row?.denominator, standardDenominator: row?.standardDenominator, version: row?.version })
        .toEqual({ key, ...formula, standardDenominator: formula.denominator, version: 3 });
    }
    expect(await read('ratioDefinitions', rows.owners._id)).toMatchObject({
      denominator: ['RECRUIT_FOLLOWUP'], standardDenominator: OLD_RECRUIT.denominator,
    });
    expect(await read('ratioDefinitions', rows.office._id)).toMatchObject({ denominator: OLD_RECRUIT.denominator });
    expect(await read('ratioDefinitions', rows.deleted._id)).toMatchObject({ denominator: OLD_SELL.denominator });
    expect(await read('ratioDefinitions', rows.balance._id)).toMatchObject({ numerator: ['SELL_FOLLOWUP'] });
    // The office is kept on every write (invariant §1).
    expect((await read('ratioDefinitions', rows.reordered._id))?.kpmId).toBe(KPM_B);

    expect(await up(db())).toEqual({ ratios: 0, kept: 1, snapshots: 0, templates: 0 });
  });

  it('P19.17-T1 AC-6 leaves an Owner who puts follow-ups back after the move alone, on every deploy after', async () => {
    const row = ratio(KPM_A, 'SELLING_SUCCESS_RATE', OLD_SELL);
    await db().collection('ratioDefinitions').insertOne(row);
    await up(db());
    await db().collection('ratioDefinitions').updateOne({ _id: row._id }, { $set: { denominator: OLD_SELL.denominator } });

    expect(await up(db())).toEqual({ ratios: 0, kept: 1, snapshots: 0, templates: 0 });
    expect(await read('ratioDefinitions', row._id)).toMatchObject({
      denominator: OLD_SELL.denominator, standardDenominator: NEW_SELL.denominator,
    });
  });

  it('P19.17-T1 AC-6 moves each office’s newest snapshot and every ratio_set template, element by element', async () => {
    const view = (formula: typeof OLD_SELL, code: string, extra: Record<string, unknown> = {}) => ({
      id: String(id()), code, ...formula, standardNumerator: formula.numerator, standardDenominator: formula.denominator,
      origin: 'platform', version: 2, ...extra,
    });
    const older = { _id: id(), kpmId: KPM_A, version: 1, deletedAt: null, payload: { ratios: [view(OLD_SELL, 'SELLING_SUCCESS_RATE')] } };
    const newest = {
      _id: id(), kpmId: KPM_A, version: 2, deletedAt: null,
      payload: { activity: { kept: true }, ratios: [
        view(OLD_SELL, 'SELLING_SUCCESS_RATE'),
        view(OLD_RECRUIT, 'RECRUITMENT_SUCCESS_RATE', { origin: 'office' }),
        view({ numerator: ['SELL_PRESENTATION'], denominator: ['LEADS_CONTACTED'] }, 'MEETING_PER_APPROACH'),
      ] },
    };
    // A snapshot written before ADR-0024 carries no standard: on the old formula, it moves.
    const officeB = {
      _id: id(), kpmId: KPM_B, version: 4, deletedAt: null,
      payload: { ratios: [{ code: 'RECRUITMENT_SUCCESS_RATE', ...OLD_RECRUIT }] },
    };
    await db().collection('configSnapshots').insertMany([older, newest, officeB]);
    const template = (kind: string, ratios: unknown[]) => ({ _id: id(), companyId: 'c1', kind, status: 'published', version: 1, payload: { ratios } });
    const templates = {
      published: template('ratio_set', [{ code: 'SELLING_SUCCESS_RATE', ...OLD_SELL }, { code: 'RECRUITMENT_SUCCESS_RATE', ...OLD_RECRUIT }]),
      current: template('ratio_set', [{ code: 'SELLING_SUCCESS_RATE', ...NEW_SELL }]),
      otherKind: template('activity_taxonomy', [{ code: 'SELLING_SUCCESS_RATE', ...OLD_SELL }]),
    };
    await db().collection('companyTemplates').insertMany(Object.values(templates));

    expect(await up(db())).toEqual({ ratios: 0, kept: 0, snapshots: 2, templates: 1 });

    const ratiosOf = async (collection: string, _id: mongoose.Types.ObjectId) =>
      ((await read(collection, _id))?.payload as { ratios: Record<string, unknown>[] }).ratios;
    const [sell, ownRecruit, meeting] = await ratiosOf('configSnapshots', newest._id);
    expect(sell).toMatchObject({ ...NEW_SELL, standardDenominator: NEW_SELL.denominator, version: 2 });
    expect(ownRecruit).toMatchObject({ denominator: OLD_RECRUIT.denominator });
    expect(meeting).toMatchObject({ denominator: ['LEADS_CONTACTED'] });
    expect((await read('configSnapshots', newest._id))?.payload).toMatchObject({ activity: { kept: true } });
    // Only the newest is the one agents read: an older version is history.
    expect((await ratiosOf('configSnapshots', older._id))[0]).toMatchObject({ denominator: OLD_SELL.denominator });
    expect((await ratiosOf('configSnapshots', officeB._id))[0]).toEqual({ code: 'RECRUITMENT_SUCCESS_RATE', ...NEW_RECRUIT });

    expect(await ratiosOf('companyTemplates', templates.published._id)).toEqual([
      { code: 'SELLING_SUCCESS_RATE', ...NEW_SELL }, { code: 'RECRUITMENT_SUCCESS_RATE', ...NEW_RECRUIT },
    ]);
    expect((await ratiosOf('companyTemplates', templates.otherKind._id))[0]).toMatchObject({ denominator: OLD_SELL.denominator });

    expect(await up(db())).toEqual({ ratios: 0, kept: 0, snapshots: 0, templates: 0 });
  });

  it('P19.17-T1 AC-6 on an empty database it reads nothing and creates no collection', async () => {
    expect(await up(db())).toEqual({ ratios: 0, kept: 0, snapshots: 0, templates: 0 });
    expect(await db().listCollections({}, { nameOnly: true }).toArray()).toEqual([]);
  });
});
