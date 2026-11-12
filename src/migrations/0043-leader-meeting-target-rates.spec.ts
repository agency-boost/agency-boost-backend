import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../test/mongo';
import { rateCellOf, up } from './0043-leader-meeting-target-rates';

/** Rp 1 *miliar* in sen: *APE (Rp M)*'s rate is typed in the row's unit and kept in minor units. */
const MILIAR = 1_000_000_000 * 100;

/**
 * **P18.9-T1 AC-11 — migration `0043`, the forum's typed targets as rates** (ADR-0175 §4; parity I-487). *"{n} ({r} @
 * unit)"* is the rate *r*, *TBD* is no target, any other text is kept as typed; a *New AA* cell, and everything else on
 * the meeting, is left as it was. Run twice, it changes nothing.
 */
describe('P18.9-T1 AC-11 migration 0043 — the forum’s typed targets, as rates per unit', () => {
  const db = () => mongoose.connection.db as mongoose.mongo.Db;
  const meetings = () => db().collection('leaderMeetings');

  beforeAll(startMongo);
  afterAll(stopMongo);
  // `clearCollections` empties the collections a model registered; this spec writes through the driver alone.
  beforeEach(async () => {
    await clearCollections();
    await meetings().deleteMany({});
  });
  const oid = () => new mongoose.Types.ObjectId();

  /** A meeting as Phase 18.1 wrote it: the prototype's targets typed (`KPM_Owner.html:2462-2471`). */
  const meeting = (kpmId: string, monthlyTargets: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    _id: oid(), kpmId, number: 14, title: 'Strategic Check-in — #14', date: '2026-10-27', monthlyTargets,
    agenda: { preparation: [], during: [], post: [] }, actionItems: [], writtenAt: new Date('2026-10-20T02:00:00Z'),
    frozenScorecard: null, frozenAt: null, frozenCoeditors: null, version: 3, deletedAt: null,
    updatedAt: new Date('2026-10-20T02:00:00Z'), ...extra,
  });

  it('P18.9-T1 AC-11 the migration reads "{n} ({r} @ unit)" as the rate r: APE in sen, a count to two places', () => {
    expect(rateCellOf('flc', '8 (1 @ unit)', 2)).toEqual({ cell: { rate: 1, typed: null, version: 2 }, read: 'rate' });
    expect(rateCellOf('avg_monthly_aa', ' 22 (3 @ unit) ', 1).cell.rate).toBe(3);
    // A comma or a point; spaces around the parts; a different case.
    expect(rateCellOf('manpower', '13,5 (1,5 @ Unit)', 1).cell.rate).toBe(1.5);
    expect(rateCellOf('case_submission', '27(3@unit)', 1).cell.rate).toBe(3);
    expect(rateCellOf('ape', '1,2 (0.15 @ unit)', 1).cell).toEqual({ rate: 15 * MILIAR / 100, typed: null, version: 1 });
    expect(Number.isInteger(rateCellOf('ape', '1,2 (0.15 @ unit)', 1).cell.rate)).toBe(true);
    // A rate typed past the hundredth is held to the places a rate takes.
    expect(rateCellOf('flc', '1 (0.125 @ unit)', 1).cell.rate).toBe(0.13);
  });

  it('P18.9-T1 AC-11 the migration reads TBD and an empty cell as no target, and keeps any other text as typed', () => {
    for (const none of ['TBD', 'tbd', '  ', '']) {
      expect(rateCellOf('ape', none, 4)).toEqual({ cell: { rate: null, typed: null, version: 4 }, read: 'none' });
    }
    for (const text of ['8', 'About 8', '8 per unit', 'Rp 1,2 M (Rp 150 Jt @ unit)', '<b>9</b>']) {
      expect(rateCellOf('flc', text, 1)).toEqual({ cell: { rate: null, typed: text, version: 1 }, read: 'kept' });
    }
  });

  it('P18.9-T1 AC-11 the migration on an empty database does nothing, and creates nothing', async () => {
    expect(await up(db())).toEqual({ meetings: 0, rates: 0, none: 0, kept: 0, current: 0 });
    expect(await meetings().countDocuments({})).toBe(0);
  });

  it('P18.9-T1 AC-11 the migration: rates, no target and text kept, every office’s; New AA and the rest of the meeting untouched; run twice, nothing more', async () => {
    const frozen = { periods: { fy: '2025' }, rows: [{ key: 'new_aa', cells: {} }] };
    const a = meeting('kpm-0417', {
      ape: { value: 'TBD', version: 2 },
      manpower: { value: '', version: 1 },
      flc: { value: '8 (1 @ unit)', version: 3 },
      new_aa: { value: 'TBD', version: 1 },
      avg_monthly_aa: { value: '22 (3 @ unit)', version: 1 },
      case_submission: { value: 'Ask Hellen', version: 1 },
    }, { frozenScorecard: frozen, frozenAt: new Date('2026-10-28T02:00:00Z') });
    const b = meeting('kpm-0555', { ape: { value: '1,5 (0,2 @ unit)', version: 1 } });
    // Already read: a write since 0043 ran, which a second run must leave.
    const c = meeting('kpm-0701', { flc: { rate: 2, typed: null, version: 5 } });
    const empty = meeting('kpm-0602', {});
    await meetings().insertMany([a, b, c, empty]);

    expect(await up(db())).toEqual({ meetings: 2, rates: 3, none: 2, kept: 1, current: 1 });

    const after = await meetings().findOne({ _id: a._id });
    expect(after!.monthlyTargets).toEqual({
      ape: { rate: null, typed: null, version: 2 },
      manpower: { rate: null, typed: null, version: 1 },
      flc: { rate: 1, typed: null, version: 3 },
      // Not a rate's row: its data stays as typed (AC-6).
      new_aa: { value: 'TBD', version: 1 },
      avg_monthly_aa: { rate: 3, typed: null, version: 1 },
      case_submission: { rate: null, typed: 'Ask Hellen', version: 1 },
    });
    // Nothing else on the meeting moves: not its version, its writing, its frozen scorecard or its timestamp.
    expect({ ...after, monthlyTargets: null }).toEqual({ ...a, monthlyTargets: null });
    expect((await meetings().findOne({ _id: b._id }))!.monthlyTargets).toEqual({ ape: { rate: 2 * MILIAR / 10, typed: null, version: 1 } });
    expect((await meetings().findOne({ _id: c._id }))!.monthlyTargets).toEqual({ flc: { rate: 2, typed: null, version: 5 } });
    expect((await meetings().findOne({ _id: empty._id }))!.monthlyTargets).toEqual({});

    // Run twice, it changes nothing: every cell it reads is a rate now.
    const before = await meetings().find({}).sort({ _id: 1 }).toArray();
    expect(await up(db())).toEqual({ meetings: 0, rates: 0, none: 0, kept: 0, current: 7 });
    expect(await meetings().find({}).sort({ _id: 1 }).toArray()).toEqual(before);
  });

  it('P18.9-T1 AC-11 the migration leaves what is no typed target, reads a cell with no version as 1, and never writes over a cell changed since it read it', async () => {
    const noField = meeting('kpm-0417', {});
    delete (noField as Record<string, unknown>).monthlyTargets;
    const odd = meeting('kpm-0417', { ape: null, manpower: 'TBD', flc: { value: 8, version: 2 }, avg_monthly_aa: { value: '22 (3 @ unit)' } });
    const raced = meeting('kpm-0555', { case_submission: { value: '27 (3 @ unit)', version: 4 } });
    await meetings().insertMany([noField, odd, raced]);

    // Another editor's rate lands on #raced between the migration's read and its write.
    const theirs = { rate: 5, typed: null, version: 5 };
    const racing = {
      collection: (name: string) => {
        const real = db().collection(name);
        return new Proxy(real, {
          get(target, prop) {
            if (prop === 'updateOne') {
              return async (
                filter: mongoose.mongo.Filter<mongoose.mongo.Document>, update: mongoose.mongo.UpdateFilter<mongoose.mongo.Document>,
              ) => {
                if (String(filter._id) === String(raced._id)) {
                  await real.updateOne({ _id: raced._id }, { $set: { 'monthlyTargets.case_submission': theirs } });
                }
                return real.updateOne(filter, update);
              };
            }
            const value = Reflect.get(target, prop) as unknown;
            return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        });
      },
    } as unknown as mongoose.mongo.Db;

    expect(await up(racing)).toEqual({ meetings: 1, rates: 1, none: 0, kept: 0, current: 0 });
    expect((await meetings().findOne({ _id: noField._id }))!.monthlyTargets).toBeUndefined();
    // A cell that is no text, or no cell at all, is not a typed target: left as it is. One with no version reads 1.
    expect((await meetings().findOne({ _id: odd._id }))!.monthlyTargets).toEqual({
      ape: null, manpower: 'TBD', flc: { value: 8, version: 2 }, avg_monthly_aa: { rate: 3, typed: null, version: 1 },
    });
    // The other editor's rate stands; the next run reads it as current.
    expect((await meetings().findOne({ _id: raced._id }))!.monthlyTargets).toEqual({ case_submission: theirs });
    expect(await up(db())).toEqual({ meetings: 0, rates: 0, none: 0, kept: 0, current: 2 });
  });
});
