import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildCoachingOffice, KPM_A, KPM_B, ROSTER_NOW, type CoachingOffice, type Who } from '../../../test/coaching-office';
import { fromFrozen } from './campaign-evaluation';
import type { CampaignStanding } from './campaign-standing.schema';
import { checkStandingOverride, checkStandingOverrideClear, FREEZE_WAIT, OVERRIDE_REASON } from './campaign-standing-overrides';

const wib = (local: string) => new Date(`${local}+07:00`).toISOString();
const APE = { metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 1 };

/**
 * **The override of a final standing** (P18.6-T2 AC-5, AC-7; ADR-0144 §4, D-override), over `test/coaching-office.ts`'s
 * office — 10:00 on Monday 14 September 2026 in Jakarta, August on file and locked (from the 8th), September open.
 *
 * | Campaign | Window | Chasers | On the day |
 * |---|---|---|---|
 * | `AUGUST_PUSH` | August, APE ≥ 1 sen | Rina (Rp 20 M: qualified), Budi and the Owner (nothing on file: not met) | final |
 * | `JUNE_PUSH` | June, APE ≥ 1 sen — June is not on file | Dimas | final, `unknown` |
 * | `SEPT_PUSH` | September | Rina | running |
 * | `MDRT` | calendar year | Rina | this year, not final |
 * | `PROMO` | rolling 12 months | Rina | never final |
 * | `GONE_PUSH` | August, archived | Rina | — |
 */
describe('overriding a final standing (P18.6-T2 AC-5)', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;
  const owner = () => office.as('OWNER');
  const overrides = () => wired.campaignStandingOverrides;
  const standing = (code: string, who: Who) => db().collection('campaignStandings').findOne({ kpmId: KPM_A, campaignCode: code, membershipId: office.id[who] });
  const audits = (action: string) => db().collection('auditLog').find({ action }).toArray();
  const chase = (code: string, who: Who, kpmId = KPM_A) => db().collection('campaignChases').insertOne({
    kpmId, membershipId: office.id[who], campaignCode: code, chasing: true, chasedAt: new Date('2026-01-05T02:00:00Z'),
    unchasedAt: null, closedBy: null, deletedAt: null,
  });
  const make = (ctx: RequestContext, body: Record<string, unknown>) => wired.campaigns.create(ctx, body);
  const REASON = 'Persistency corrected by the carrier after the month locked.';

  beforeAll(async () => {
    await startMongo();
    wired = configModule(ROSTER_NOW);
    await syncIndexes();
  }, 60_000);
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    office = await buildCoachingOffice(wired);
    const o = owner();
    await make(o, { code: 'AUGUST_PUSH', title: 'August Push', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-08-31T23:59:00'), requirements: [APE] });
    await make(o, { code: 'JUNE_PUSH', title: 'June Push', startsAt: wib('2026-06-01T00:00:00'), endsAt: wib('2026-06-30T23:59:00'), requirements: [APE] });
    await make(o, { code: 'SEPT_PUSH', title: 'September Push', startsAt: wib('2026-09-01T00:00:00'), endsAt: wib('2026-09-30T23:59:00'), requirements: [APE] });
    await make(o, {
      code: 'MDRT', title: 'MDRT', kind: 'structural', subtype: 'ongoing', window: 'calendar_year',
      startsAt: wib('2026-01-01T00:00:00'), endsAt: null, requirements: [APE],
    });
    await make(o, {
      code: 'PROMO', title: 'Promotion', kind: 'structural', subtype: 'promotion', window: 'rolling_12m',
      startsAt: wib('2026-01-01T00:00:00'), endsAt: null, requirements: [APE],
    });
    const gone = await make(o, { code: 'GONE_PUSH', title: 'Gone', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-08-31T23:59:00'), requirements: [APE] });
    await wired.campaigns.archive(o, gone.id);
    const b = office.as('B_AB');
    await make(new RequestContext(b.userId, 'none', { ...b.membership!, isKpmOwner: true }), {
      code: 'B_PUSH', title: 'B Push', startsAt: wib('2026-08-01T00:00:00'), endsAt: wib('2026-08-31T23:59:00'), requirements: [APE],
    });
    for (const code of ['AUGUST_PUSH', 'SEPT_PUSH', 'MDRT', 'PROMO', 'GONE_PUSH']) await chase(code, 'RINA');
    await chase('AUGUST_PUSH', 'BUDI');
    // The Owner chases too, as the AB he is: nobody overrides their own result (the exit review, round 1).
    await chase('AUGUST_PUSH', 'OWNER');
    await chase('JUNE_PUSH', 'DIMAS');
  }, 60_000);

  describe('the body (P18.6-T2 AC-5)', () => {
    it('P18.6-T2 AC-5 reads a status and a reason, trimmed — nothing else', () => {
      expect(checkStandingOverride({ status: 'qualified', reason: '  Carrier restated it.  ' })).toEqual({ status: 'qualified', reason: 'Carrier restated it.' });
      expect(checkStandingOverrideClear({ reason: ' Wrong member. ' })).toEqual({ reason: 'Wrong member.' });
      expect(OVERRIDE_REASON).toEqual({ min: 1, max: 500 });
    });

    it.each([
      [{ status: 'qualified', reason: '   ' }, 'reason must be 1–500 characters.'],
      [{ status: 'qualified', reason: 'x'.repeat(501) }, 'reason must be 1–500 characters.'],
      [{ status: 'qualified' }, 'reason is required.'],
      [{ status: 'achieved', reason: 'Because' }, 'status must be one of qualified, not_met.'],
      [{ reason: 'Because' }, 'status is required.'],
      [{ status: 'not_met', reason: 'Because', note: 'x' }, 'property note should not exist'],
      [null, 'The change must be an object of fields.'],
    ])('P18.6-T2 AC-5 refuses %j: %s', (body, said) => {
      expect(() => checkStandingOverride(body)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED', details: { violations: expect.arrayContaining([said]) } }));
    });

    it('P18.6-T2 AC-5 clearing needs a reason too, and takes nothing else', () => {
      expect(() => checkStandingOverrideClear({})).toThrow(expect.objectContaining({ details: { violations: ['reason is required.'] } }));
      expect(() => checkStandingOverrideClear(undefined)).toThrow(expect.objectContaining({ details: { violations: ['reason is required.'] } }));
      expect(() => checkStandingOverrideClear({ reason: 'x', status: 'qualified' })).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    });

    it('P18.6-T2 AC-5 a 500-character reason is taken whole', () => {
      expect(checkStandingOverride({ status: 'not_met', reason: 'x'.repeat(500) }).reason).toHaveLength(500);
    });
  });

  describe('setting and clearing (P18.6-T2 AC-5, AC-7)', () => {
    it('P18.6-T2 AC-5 sets a final Not met to Achieved, with the reason, by the Owner — the frozen status kept', async () => {
      const result = await overrides().override(owner(), 'august_push', office.id.BUDI, { status: 'qualified', reason: `  ${REASON}  ` });
      expect(result).toEqual({
        campaignCode: 'AUGUST_PUSH', membershipId: office.id.BUDI, status: 'qualified',
        override: { status: 'qualified', reason: REASON, by: { membershipId: office.id.OWNER, name: office.name.OWNER }, at: ROSTER_NOW.toISOString() },
      });
      const row = (await standing('AUGUST_PUSH', 'BUDI'))!;
      expect(row.status).toBe('not_met');
      expect(row.override).toEqual({ status: 'qualified', reason: REASON, byMembershipId: office.id.OWNER, at: ROSTER_NOW, previousStatus: 'not_met' });
      expect(row.updatedAt).toEqual(ROSTER_NOW);
    });

    it('P18.6-T2 AC-5 audits the set once — before, after, the reason and the previous status', async () => {
      await overrides().override(owner(), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON });
      const [entry, ...more] = await audits('campaign_standing.overridden');
      expect(more).toEqual([]);
      const row = (await standing('AUGUST_PUSH', 'BUDI'))!;
      expect(entry).toMatchObject({
        kpmId: KPM_A, targetCollection: 'campaignStandings', targetId: String(row._id), targetMembershipId: office.id.BUDI,
        actorMembershipId: office.id.OWNER, effectiveUserId: null,
        before: { campaignCode: 'AUGUST_PUSH', windowKey: '2026-08..2026-08', status: 'not_met', override: null },
        after: {
          campaignCode: 'AUGUST_PUSH', windowKey: '2026-08..2026-08', status: 'qualified', reason: REASON, previousStatus: 'not_met',
          override: { status: 'qualified', reason: REASON, byMembershipId: office.id.OWNER, previousStatus: 'not_met' },
        },
      });
    });

    it('P18.6-T2 AC-7 every reader reads the overridden status: ofOffice with who, when and why', async () => {
      await overrides().override(owner(), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON });
      const read = await wired.campaignStandingsReader.ofOffice(owner(), { codes: ['AUGUST_PUSH'], memberIds: [office.id.BUDI, office.id.RINA] });
      const of = (who: Who) => read.standings.find((s) => s.membershipId === office.id[who]);
      expect(of('BUDI')).toMatchObject({
        status: 'qualified', final: true,
        overridden: { status: 'qualified', reason: REASON, byMembershipId: office.id.OWNER, at: ROSTER_NOW.toISOString() },
      });
      expect(of('RINA')).toMatchObject({ status: 'qualified', overridden: null });
      const evaluated = await wired.campaignEvaluation.evaluate(office.as('BUDI'), [{
        code: 'AUGUST_PUSH', version: 1, window: 'campaign_dates', startsAt: new Date(wib('2026-08-01T00:00:00')),
        endsAt: new Date(wib('2026-08-31T23:59:59.999')), appliesToOrgLevelCodes: [], requirements: [APE], frozenWindows: ['2026-08..2026-08'],
      }], [office.id.BUDI]);
      expect(evaluated.get('AUGUST_PUSH')!.members.get(office.id.BUDI)).toMatchObject({ status: 'qualified', override: { status: 'qualified' } });
    });

    it('P18.6-T2 AC-7 exit test 5: the agent’s dialog is unchanged by an override and by its clearing (ADR-0147)', async () => {
      const dialog = async () => wired.campaignAgent.detail(office.as('BUDI'), 'AUGUST_PUSH');
      const before = await dialog();
      expect(before.progress).toMatchObject({ final: true, rows: [{ metricKey: 'APE_ACHIEVED', state: 'not_met' }] });
      await overrides().override(owner(), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON });
      expect(await dialog()).toEqual(before);
      expect(JSON.stringify(await dialog())).not.toMatch(/qualified|override/i);
      await overrides().clear(owner(), 'AUGUST_PUSH', office.id.BUDI, { reason: 'Set in error.' });
      expect(await dialog()).toEqual(before);
    });

    it('P18.6-T2 AC-5 refuses the status it already reads, naming it, and writes nothing', async () => {
      await expect(overrides().override(owner(), 'AUGUST_PUSH', office.id.BUDI, { status: 'not_met', reason: 'Same' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 400, details: { status: 'not_met', violations: ['status already reads not_met.'] } });
      await overrides().override(owner(), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON });
      await expect(overrides().override(owner(), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: 'Again' }))
        .rejects.toMatchObject({ status: 400, details: { status: 'qualified' } });
      expect(await audits('campaign_standing.overridden')).toHaveLength(1);
    });

    it('P18.6-T2 AC-5 an override set back to the frozen result is an override of its own, the previous status the override’s', async () => {
      await overrides().override(owner(), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON });
      const back = await overrides().override(office.as('ADMIN'), 'AUGUST_PUSH', office.id.BUDI, { status: 'not_met', reason: 'Carrier withdrew it.' });
      expect(back).toMatchObject({ status: 'not_met', override: { status: 'not_met', by: { membershipId: office.id.ADMIN, name: office.name.ADMIN } } });
      expect((await standing('AUGUST_PUSH', 'BUDI'))!.override).toMatchObject({ status: 'not_met', previousStatus: 'qualified', byMembershipId: office.id.ADMIN });
    });

    it('P18.6-T2 AC-5 clearing restores the frozen result, audited, and a second clear is 404', async () => {
      await overrides().override(owner(), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON });
      const cleared = await overrides().clear(office.as('ADMIN'), 'AUGUST_PUSH', office.id.BUDI, { reason: '  Set in error.  ' });
      expect(cleared).toEqual({ campaignCode: 'AUGUST_PUSH', membershipId: office.id.BUDI, status: 'not_met', override: null });
      const row = (await standing('AUGUST_PUSH', 'BUDI'))!;
      expect(row).toMatchObject({ status: 'not_met', override: null });
      const [entry] = await audits('campaign_standing.override_cleared');
      expect(entry).toMatchObject({
        targetMembershipId: office.id.BUDI, actorMembershipId: office.id.ADMIN,
        before: { status: 'qualified', override: { status: 'qualified', reason: REASON } },
        after: { status: 'not_met', override: null, reason: 'Set in error.', previousStatus: 'qualified' },
      });
      await expect(overrides().clear(owner(), 'AUGUST_PUSH', office.id.BUDI, { reason: 'Again' })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
      expect(await audits('campaign_standing.override_cleared')).toHaveLength(1);
    });

    it('P18.6-T2 AC-5 a final unknown — nothing could decide it — is overridable', async () => {
      const result = await overrides().override(owner(), 'JUNE_PUSH', office.id.DIMAS, { status: 'qualified', reason: 'June’s file arrived by hand.' });
      expect(result.status).toBe('qualified');
      expect((await standing('JUNE_PUSH', 'DIMAS'))!).toMatchObject({ status: 'unknown', override: { previousStatus: 'unknown' } });
    });

    it('P18.6-T2 AC-5 the write may be the first read after the window locked: it freezes the window once, audited', async () => {
      expect(await standing('AUGUST_PUSH', 'RINA')).toBeNull();
      await overrides().override(owner(), 'AUGUST_PUSH', office.id.RINA, { status: 'not_met', reason: 'A policy lapsed.' });
      expect(await audits('campaign_standing.finalised')).toHaveLength(1);
      expect((await standing('AUGUST_PUSH', 'RINA'))!).toMatchObject({ status: 'qualified', override: { status: 'not_met' } });
      expect((await standing('AUGUST_PUSH', 'BUDI'))!).toMatchObject({ status: 'not_met', override: null });
      await overrides().override(owner(), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON });
      expect(await audits('campaign_standing.finalised')).toHaveLength(1);
    });

    it('P18.6-T2 AC-5 two identical sets at once: one lands and is audited, the other reads it and is refused', async () => {
      const results = await Promise.allSettled([
        overrides().override(owner(), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON }),
        overrides().override(office.as('ADMIN'), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason))
        .toEqual([expect.objectContaining({ status: 400, details: expect.objectContaining({ status: 'qualified' }) })]);
      expect(await audits('campaign_standing.overridden')).toHaveLength(1);
      expect(await audits('campaign_standing.finalised')).toHaveLength(1);
    });

    it('P18.6-T2 AC-5 a chaser whose window another request is still freezing is waited for, not called missing', async () => {
      // As the loser of `markFrozen` reads: the window final, and the winner's insert not landed yet.
      const spy = jest.spyOn(wired.campaignStandings, 'findOne').mockResolvedValueOnce(null).mockResolvedValueOnce(null);
      try {
        const result = await overrides().override(owner(), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON });
        expect(result.status).toBe('qualified');
        expect(spy).toHaveBeenCalledTimes(3);
      } finally {
        spy.mockRestore();
      }
      expect(await audits('campaign_standing.overridden')).toHaveLength(1);
    });

    it('P18.6-T2 AC-5 a chaser whose row never arrives is 404 after the wait, nothing written', async () => {
      await overrides().override(owner(), 'AUGUST_PUSH', office.id.RINA, { status: 'not_met', reason: REASON });
      const spy = jest.spyOn(wired.campaignStandings, 'findOne').mockResolvedValue(null);
      try {
        await expect(overrides().override(owner(), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON }))
          .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Standing not found.' });
        expect(spy).toHaveBeenCalledTimes(FREEZE_WAIT.reads);
      } finally {
        spy.mockRestore();
      }
      expect(await audits('campaign_standing.overridden')).toHaveLength(1);
      expect(FREEZE_WAIT.ms * FREEZE_WAIT.reads).toBe(2_000);
    });

    it('P18.6-T2 AC-5 a write that loses the race twice is a version conflict, nothing audited', async () => {
      await overrides().override(owner(), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON });
      const spy = jest.spyOn(wired.campaignStandings, 'setOverride').mockResolvedValue(false);
      try {
        await expect(overrides().clear(owner(), 'AUGUST_PUSH', office.id.BUDI, { reason: 'Clear' }))
          .rejects.toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
        expect(spy).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
      expect(await audits('campaign_standing.override_cleared')).toHaveLength(0);
    });

    it('P18.6-T2 AC-5 a row frozen before the override existed — no `override`, no `version` — is overridden all the same', async () => {
      await overrides().override(owner(), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON });
      await overrides().clear(owner(), 'AUGUST_PUSH', office.id.BUDI, { reason: 'Reset' });
      await db().collection('campaignStandings').updateOne(
        { kpmId: KPM_A, campaignCode: 'AUGUST_PUSH', membershipId: office.id.BUDI }, { $unset: { override: '', version: '' } },
      );
      const result = await overrides().override(owner(), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON });
      expect(result.override).toMatchObject({ status: 'qualified' });
      expect((await standing('AUGUST_PUSH', 'BUDI'))!).toMatchObject({ version: 1, override: { previousStatus: 'not_met' } });
    });

    it('P18.6-T2 AC-5 an override by somebody the office cannot name reads an empty name, never a placeholder', async () => {
      const job = RequestContext.forJob(KPM_A, 'correction');
      const result = await overrides().override(job, 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON });
      expect(result.override!.by).toEqual({ membershipId: 'job:correction', name: '' });
    });

    it('P18.6-T2 AC-5 a support session writes as its member, both actors on the entry', async () => {
      const o = owner();
      const elevated = new RequestContext(o.userId, 'none', o.membership, 'u-operator', null, false, false);
      await overrides().override(elevated, 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON });
      const [entry] = await audits('campaign_standing.overridden');
      expect(entry).toMatchObject({ actorUserId: 'u-operator', effectiveUserId: o.userId, actorMembershipId: office.id.OWNER });
    });
  });

  describe('nobody overrides their own result (the exit review, round 1; ADR-0138’s rule)', () => {
    const selfRefusal = (ctx: RequestContext) => ({
      code: 'CAMPAIGN_OVERRIDE_SELF', status: 400, message: 'You can’t override your own result.', details: { membershipId: ctx.membershipId },
    });

    it('round 1 negative: the Owner setting their own is refused 400 CAMPAIGN_OVERRIDE_SELF, nothing written or frozen', async () => {
      await expect(overrides().override(owner(), 'AUGUST_PUSH', office.id.OWNER, { status: 'qualified', reason: REASON }))
        .rejects.toMatchObject(selfRefusal(owner()));
      expect(await standing('AUGUST_PUSH', 'OWNER')).toBeNull();
      expect(await audits('campaign_standing.overridden')).toHaveLength(0);
      expect(await audits('campaign_standing.finalised')).toHaveLength(0);
    });

    it('round 1 negative: clearing one’s own is refused the same way, the override the Admin set kept', async () => {
      await overrides().override(office.as('ADMIN'), 'AUGUST_PUSH', office.id.OWNER, { status: 'qualified', reason: REASON });
      await expect(overrides().clear(owner(), 'AUGUST_PUSH', office.id.OWNER, { reason: 'Mine to clear' }))
        .rejects.toMatchObject(selfRefusal(owner()));
      expect((await standing('AUGUST_PUSH', 'OWNER'))!.override).toMatchObject({ status: 'qualified', byMembershipId: office.id.ADMIN });
      expect(await audits('campaign_standing.override_cleared')).toHaveLength(0);
    });

    it('round 1 positive: an Admin overrides the Owner’s result and clears it; the Owner can do neither on their own', async () => {
      const set = await overrides().override(office.as('ADMIN'), 'AUGUST_PUSH', office.id.OWNER, { status: 'qualified', reason: REASON });
      expect(set).toMatchObject({ membershipId: office.id.OWNER, status: 'qualified', override: { by: { membershipId: office.id.ADMIN } } });
      await expect(overrides().clear(owner(), 'AUGUST_PUSH', office.id.OWNER, { reason: 'x' })).rejects.toMatchObject({ status: 400 });
      expect(await overrides().clear(office.as('ADMIN'), 'AUGUST_PUSH', office.id.OWNER, { reason: 'Set in error.' }))
        .toMatchObject({ status: 'not_met', override: null });
    });

    it('round 1 negative: an elevated Super Admin session as the Owner is refused on the Owner’s own row', async () => {
      const o = owner();
      const elevated = new RequestContext(o.userId, 'none', o.membership, 'u-operator', null, false, false);
      await expect(overrides().override(elevated, 'AUGUST_PUSH', office.id.OWNER, { status: 'qualified', reason: REASON }))
        .rejects.toMatchObject(selfRefusal(elevated));
      // As the Owner, on somebody else's row, it writes.
      await overrides().override(elevated, 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: REASON });
    });

    it('round 1: the body is checked first, then the campaign, then the self guard — before finality', async () => {
      await expect(overrides().override(owner(), 'AUGUST_PUSH', office.id.OWNER, { status: 'maybe', reason: 'x' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(overrides().override(owner(), 'NO_SUCH_PUSH', office.id.OWNER, { status: 'qualified', reason: 'x' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(overrides().override(owner(), 'SEPT_PUSH', office.id.OWNER, { status: 'qualified', reason: 'x' }))
        .rejects.toMatchObject({ code: 'CAMPAIGN_OVERRIDE_SELF' });
    });
  });

  describe('refusals (P18.6-T2 AC-5)', () => {
    it.each([['SEPT_PUSH', 'running'], ['MDRT', 'this calendar year'], ['PROMO', 'a rolling window, never final']])(
      'P18.6-T2 AC-5 refuses %s (%s) 409 CAMPAIGN_STANDING_NOT_FINAL, writing nothing',
      async (code) => {
        await expect(overrides().override(owner(), code, office.id.RINA, { status: 'not_met', reason: 'Too early' }))
          .rejects.toMatchObject({ code: 'CAMPAIGN_STANDING_NOT_FINAL', status: 409, details: { code } });
        await expect(overrides().clear(owner(), code, office.id.RINA, { reason: 'Too early' }))
          .rejects.toMatchObject({ code: 'CAMPAIGN_STANDING_NOT_FINAL' });
        expect(await db().collection('campaignStandings').countDocuments({ campaignCode: code })).toBe(0);
      },
    );

    it.each([['UNKNOWN_PUSH'], ['GONE_PUSH'], ['B_PUSH']])('P18.6-T2 AC-5 404 for %s: unknown, archived or another office’s', async (code) => {
      await expect(overrides().override(owner(), code, office.id.RINA, { status: 'not_met', reason: 'x' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    });

    it('P18.6-T2 AC-5 404 for a membership not this office’s, or no id at all — before finality is even asked', async () => {
      for (const id of [office.id.B_AGENT, 'not-an-id', '66f0000000000000000000ff']) {
        await expect(overrides().override(owner(), 'AUGUST_PUSH', id, { status: 'qualified', reason: 'x' })).rejects.toMatchObject({ status: 404 });
        await expect(overrides().override(owner(), 'SEPT_PUSH', id, { status: 'qualified', reason: 'x' })).rejects.toMatchObject({ status: 404 });
      }
    });

    it('P18.6-T2 AC-5 404 for a member who was not chasing it when it ended: no stored standing (ADR-0143)', async () => {
      const spy = jest.spyOn(wired.campaignStandings, 'findOne');
      try {
        await expect(overrides().override(owner(), 'AUGUST_PUSH', office.id.INDAH, { status: 'qualified', reason: 'x' }))
          .rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Standing not found.' });
        // Nobody else's freeze can bring them a row, so nothing is waited for.
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
      expect(await standing('AUGUST_PUSH', 'INDAH')).toBeNull();
    });

    it('P18.6-T2 AC-5 checks the body before anything else, and refuses a caller with no office', async () => {
      await expect(overrides().override(owner(), 'UNKNOWN_PUSH', office.id.RINA, { status: 'maybe', reason: '' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(overrides().override(RequestContext.platform('root'), 'AUGUST_PUSH', office.id.BUDI, { status: 'qualified', reason: 'x' }))
        .rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP', status: 403 });
    });
  });

  describe('fromFrozen — the one place an override is applied (P18.6-T2 AC-7)', () => {
    const row = (override: CampaignStanding['override'] | undefined) => ({
      membershipId: 'm', status: 'not_met', chasing: true, eligible: true,
      requirements: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', target: 1, current: 0, met: false }],
      ...(override === undefined ? {} : { override }),
    }) as unknown as CampaignStanding;

    it('P18.6-T2 AC-7 reads the override’s status, who, when and why; the requirement rows are the frozen ones', () => {
      const at = new Date('2026-09-14T03:00:00Z');
      const plain = fromFrozen(row(null));
      const overridden = fromFrozen(row({ status: 'qualified', reason: 'r', byMembershipId: 'o', at, previousStatus: 'not_met' }));
      expect(plain).toMatchObject({ status: 'not_met', override: null, final: true });
      expect(overridden).toMatchObject({ status: 'qualified', override: { status: 'qualified', reason: 'r', byMembershipId: 'o', at }, final: true });
      expect(overridden.rows).toEqual(plain.rows);
      // A row frozen before the field existed reads no override.
      expect(fromFrozen(row(undefined))).toMatchObject({ status: 'not_met', override: null });
    });
  });

  it('KPM B is another office (the fixture’s own check)', () => {
    expect(KPM_B).not.toBe(KPM_A);
  });
});
