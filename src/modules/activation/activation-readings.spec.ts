import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import {
  KPM_A, KPM_B, startActivationHarness, stopActivationHarness, TODAY, type ActivationHarness,
} from '../../../test/activation-office';
import { ActivationReadings } from './activation-readings';

/**
 * **`ActivationReadings.ofMembers` — its shape pinned** (P18.3-T1 AC-7): every activation of the members asked, in
 * every state, the newest per membership, in one read; the open ones through `resolve`, which writes a newly met
 * link unless the session is read-only. Over `test/activation-office.ts` (Monday 14 September 2026, Jakarta).
 */
describe('ActivationReadings.ofMembers (P18.3-T1 AC-7)', () => {
  let h: ActivationHarness;
  let readings: ActivationReadings;
  const office = (ctx: RequestContext) => new TenantDay(h.wired.kpms as never, h.wired.clock).office(ctx);
  const read = async (ctx: RequestContext, ids: string[]) => readings.ofMembers(ctx, ids, await office(ctx));

  beforeAll(async () => {
    h = await startActivationHarness();
    readings = new ActivationReadings(h.wired.activationRows, h.wired.activationProgress, h.wired.clock);
  }, 120_000);

  afterAll(() => stopActivationHarness(h));

  beforeEach(() => h.reset());

  it('P18.3-T1 AC-7 answers every state, its day 1, its end, overdue and the graduation day — and nobody without one', async () => {
    await h.start('RINA', '2026-08-01');
    await h.start('BUDI', '2026-05-01');
    await h.start('DODI', '2026-03-01', { graduatedAt: new Date('2026-05-20T17:30:00Z'), graduatedByMembershipId: h.id('DODI') });
    await h.start('TARI', '2026-01-02');
    const ctx = h.office.as('OWNER');
    const out = await read(ctx, ['RINA', 'BUDI', 'DODI', 'TARI', 'LUKAS'].map((who) => h.id(who as never)));
    expect([...out.keys()].sort()).toEqual([h.id('RINA'), h.id('BUDI'), h.id('DODI'), h.id('TARI')].sort());
    expect(out.get(h.id('RINA'))).toEqual({
      membershipId: h.id('RINA'), startDate: '2026-08-01', state: 'open', endsOn: '2027-02-01', overdue: false, graduatedOn: null,
    });
    expect(out.get(h.id('BUDI'))).toEqual({
      membershipId: h.id('BUDI'), startDate: '2026-05-01', state: 'open', endsOn: '2026-11-01', overdue: true, graduatedOn: null,
    });
    // Graduated at 17:30 UTC on 20 May: 00:30 on the 21st in Jakarta — the office's day.
    expect(out.get(h.id('DODI'))).toEqual({
      membershipId: h.id('DODI'), startDate: '2026-03-01', state: 'graduated', endsOn: '2026-09-01', overdue: false,
      graduatedOn: '2026-05-21',
    });
    expect(out.get(h.id('TARI'))).toEqual({
      membershipId: h.id('TARI'), startDate: '2026-01-02', state: 'expired', endsOn: '2026-07-02', overdue: false, graduatedOn: null,
    });
  });

  it('P18.3-T1 AC-7 each standing equals the leader’s detail for that hire', async () => {
    await h.start('RINA', '2026-08-01');
    await h.start('BUDI', '2026-05-01');
    await h.start('DODI', '2026-03-01', { graduatedAt: new Date('2026-05-20T03:00:00Z'), graduatedByMembershipId: h.id('DODI') });
    const out = await read(h.office.as('OWNER'), [h.id('RINA'), h.id('BUDI'), h.id('DODI')]);
    for (const who of ['RINA', 'BUDI', 'DODI'] as const) {
      const detail = await h.wired.newHires.detail(h.office.as('AGUS'), h.id(who));
      expect(out.get(h.id(who))).toMatchObject({ state: detail.state, overdue: detail.overdue, endsOn: detail.endsOn, startDate: detail.startDate });
    }
  });

  it('P18.3-T1 AC-7 one per membership, the newest; a removed row is no activation', async () => {
    await h.start('RINA', '2026-01-02', {
      graduatedAt: new Date('2026-03-01T03:00:00Z'), graduatedByMembershipId: h.id('RINA'), createdAt: new Date('2026-01-02T03:00:00Z'),
    });
    await h.start('RINA', '2026-08-01', { createdAt: new Date('2026-08-01T03:00:00Z') });
    const removed = await h.start('BUDI', '2026-08-01');
    await h.col('activationProgress').updateOne({ _id: removed._id }, { $set: { deletedAt: new Date('2026-08-02T03:00:00Z') } });
    const out = await read(h.office.as('OWNER'), [h.id('RINA'), h.id('BUDI')]);
    expect([...out.values()].map((s) => [s.membershipId, s.state, s.startDate])).toEqual([[h.id('RINA'), 'open', '2026-08-01']]);
  });

  it('P18.3-T1 AC-7 reads within the office: another office’s activation, asked by id, is not there', async () => {
    await h.start('B_AGENT', '2026-08-01');
    expect((await read(h.office.as('OWNER'), [h.id('B_AGENT')])).size).toBe(0);
    expect((await read(h.office.as('B_AB'), [h.id('B_AGENT')])).size).toBe(1);
    expect(h.office.as('B_AB').kpmId).toBe(KPM_B);
    expect(h.office.as('OWNER').kpmId).toBe(KPM_A);
  });

  it('P18.3-T1 AC-7 one query for any number of closed activations, none for nobody', async () => {
    for (const who of ['RINA', 'BUDI', 'DODI', 'TARI'] as const) {
      await h.start(who, '2026-01-02', { graduatedAt: new Date('2026-03-01T03:00:00Z'), graduatedByMembershipId: h.id(who) });
    }
    const ctx = h.office.as('OWNER');
    const at = await office(ctx);
    const queries: string[] = [];
    mongoose.set('debug', (collection: string, method: string) => { queries.push(`${collection}.${method}`); });
    try {
      await readings.ofMembers(ctx, [], at);
      expect(queries).toEqual([]);
      await readings.ofMembers(ctx, ['RINA', 'BUDI', 'DODI', 'TARI'].map((who) => h.id(who as never)), at);
    } finally {
      mongoose.set('debug', false);
    }
    expect(queries).toEqual(['activationProgress.find']);
  });

  it('P18.3-T1 AC-7 the open ones through resolve: a newly met link is written — but never by a read-only support session', async () => {
    // Rina's goal (the coaching office's) meets `feature:goals`.
    const doc = await h.start('RINA', '2026-08-01');
    const stored = () => h.col('activationProgress').findOne({ _id: doc._id });
    const goalItem = async () => (await stored())!.items.find((i: { code: string }) => i.code === 'GOAL_SETTING');

    await read(h.supporting('OWNER', true), [h.id('RINA')]);
    expect(await goalItem()).toMatchObject({ done: false });

    await read(h.office.as('OWNER'), [h.id('RINA')]);
    expect(await goalItem()).toMatchObject({ done: true, source: 'link' });
  });

  it('answers today’s state in the office’s day: an activation ends on its end day', async () => {
    await h.start('RINA', '2026-03-14');
    expect((await read(h.office.as('OWNER'), [h.id('RINA')])).get(h.id('RINA'))).toMatchObject({ state: 'expired', endsOn: TODAY });
  });
});
