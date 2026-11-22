import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException } from '@/common/errors/domain.exception';
import { platformAnalyticsConfig, type AdvancedAnalyticsConfig } from '@/modules/config/analytics-config';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { buildCoachingOffice, COMPANY, KPM_A, KPM_B, type CoachingOffice, type Who } from '../../../test/coaching-office';

/**
 * **The surveys on real rows** (P19.5-T4; ADR-0216; `functional/surveys.md`): office 0417 (KPM A) beside 0555 (KPM B),
 * the coaching roster's office (`test/coaching-office.ts`). Every rule a respondent was promised is held against the
 * database itself: an anonymous answer carries no person anywhere, Q12 never leaves for a leader, a view-as session
 * sees no answer, and another KPM's runs, forms and people never answer.
 *
 * ```
 * OWNER ─┬─ ADMIN          AGUS (AB) ─┬── INDAH, DIMAS, LUKAS ── TARI
 *        ├─ AGUS ──────────           ├── DEWI (AAB)
 *        └─ PEER_AB ── PEER_AAB ──    └── SARI (AAB) ─┬── RINA, BUDI
 *                     PEER_AGENT                       └── NINA (AAB) ── DODI
 * ```
 */
describe('P19.5-T4 surveys, on real rows', () => {
  let wired: ReturnType<typeof configModule>;
  let office: CoachingOffice;
  const db = () => mongoose.connection.db!;
  const clock = () => wired.clock as FixedClock;
  /** 10:00 in Jakarta on a calendar day. */
  const at = (day: string) => clock().set(new Date(`${day}T03:00:00Z`));
  const as = (who: Who) => office.as(who);
  const session = (who: Who) => {
    const c = as(who);
    return new RequestContext(c.userId, 'none', c.membership, 'u-super', null, false, true);
  };
  const coreLeader = (who: Who) => {
    const c = as(who);
    return new RequestContext(c.userId, 'none', { ...c.membership!, isCoreLeader: true });
  };
  const s = () => wired.surveys;
  const refusal = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (err) {
      const e = err as DomainException;
      return { status: e.getStatus(), code: e.code, details: e.details };
    }
    throw new Error('expected a refusal');
  };

  /** Publish an *Advanced analytics* version for KPM A's company: its default template, version `n`. */
  async function publish(version: number, change: (c: AdvancedAnalyticsConfig) => void): Promise<void> {
    const templateId = '66f00000000000000000aa01';
    await db().collection('templates').updateOne(
      { _id: new mongoose.Types.ObjectId(templateId) },
      { $set: { companyId: COMPANY, name: 'Default', isDefault: true, deletedAt: null } },
      { upsert: true },
    );
    const payload = platformAnalyticsConfig();
    change(payload);
    await db().collection('companyTemplates').insertOne({
      companyId: COMPANY, templateId, kind: 'advanced_analytics', status: 'published', version, payload, deletedAt: null,
    });
  }

  const score = (n: number) => ({ score: n });
  async function answerNps(who: Who, runId: string, scores: number[], open = '') {
    const ctx = as(who);
    for (const [i, n] of scores.entries()) await s().member.answer(ctx, runId, `P${i + 1}`, score(n));
    if (open) await s().member.answer(ctx, runId, 'OPEN', { text: open });
    await s().member.submit(ctx, runId);
  }

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    wired = configModule(new Date('2026-10-26T03:00:00Z'));
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    office = await buildCoachingOffice(wired);
    // The member list's facts, for the bands: Indah 27 and two years in, Agus 50 and part-time.
    await db().collection('users').updateOne({ fullName: 'Indah Permatasari' }, { $set: { dateOfBirth: '1999-03-10' } });
    await db().collection('memberships').updateOne(
      { _id: new mongoose.Types.ObjectId(office.id.INDAH) }, { $set: { joinDate: '2024-07-01', workStatus: 'full_time' } },
    );
  }, 120_000);
  afterAll(stopMongo);

  // ------------------------------------------------------------------------------------------------- the runs

  describe('AC-1 a run, started within the cadence', () => {
    beforeAll(() => at('2026-10-26'));

    it('AC-1 refuses a start before today, an end before the start, and dates outside one quarter', async () => {
      const base = { invitedRoleClasses: ['agent', 'aab', 'ab'] as const, anonymous: true, remindHalfway: true };
      expect(await refusal(s().kpm.create(as('OWNER'), 'nps', { ...base, opensOn: '2026-10-20', closesOn: '2026-11-09', invitedRoleClasses: [...base.invitedRoleClasses] })))
        .toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
      expect(await refusal(s().kpm.create(as('OWNER'), 'nps', { ...base, opensOn: '2026-11-09', closesOn: '2026-11-01', invitedRoleClasses: [...base.invitedRoleClasses] })))
        .toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
      expect(await refusal(s().kpm.create(as('OWNER'), 'nps', { ...base, opensOn: '2026-12-20', closesOn: '2027-01-05', invitedRoleClasses: [...base.invitedRoleClasses] })))
        .toMatchObject({ status: 409, code: 'SURVEY_RUN_CONFLICT', details: { reason: 'outside_cadence' } });
      expect(await refusal(s().kpm.create(as('OWNER'), 'qual', { ...base, opensOn: '2026-11-02', closesOn: '2026-11-20', invitedRoleClasses: [...base.invitedRoleClasses] })))
        .toMatchObject({ status: 409, code: 'SURVEY_RUN_CONFLICT', details: { reason: 'outside_cadence' } });
    });

    it('AC-1 the Owner starts Q4’s NPS for 27 October to 9 November; it is scheduled, and a second in Q4 is refused', async () => {
      const run = await s().kpm.create(as('OWNER'), 'nps', {
        opensOn: '2026-10-27', closesOn: '2026-11-09', invitedRoleClasses: ['agent', 'aab', 'ab'], anonymous: true,
        perPerson: true, remindHalfway: true,
      });
      expect(run).toMatchObject({ periodKey: '2026-Q4', state: 'scheduled', anonymous: true, perPerson: false, responses: { sent: 0, invited: 0 } });
      expect(await refusal(s().kpm.create(as('ADMIN'), 'nps', {
        opensOn: '2026-11-10', closesOn: '2026-11-20', invitedRoleClasses: ['agent'], anonymous: true, remindHalfway: false,
      }))).toMatchObject({ status: 409, code: 'SURVEY_RUN_CONFLICT', details: { reason: 'period_taken' } });
      const audit = await db().collection('auditLog').findOne({ action: 'survey_run.created', targetId: run.runId });
      expect(audit?.after).toMatchObject({ kind: 'nps', opensOn: '2026-10-27', anonymous: true });
    });

    it('AC-1 a scheduled run can change or be cancelled; another KPM’s run is not found', async () => {
      const run = await s().kpm.create(as('OWNER'), 'qual', {
        opensOn: '2026-12-01', closesOn: '2026-12-20', invitedRoleClasses: ['ab'], anonymous: false, perPerson: true, remindHalfway: false,
      });
      expect(run.perPerson).toBe(true);
      const changed = await s().kpm.update(as('ADMIN'), run.runId, { anonymous: true });
      expect(changed).toMatchObject({ anonymous: true, perPerson: false });
      expect(await refusal(s().kpm.update(as('B_AB'), run.runId, { remindHalfway: true }))).toMatchObject({ status: 404 });
      expect(await refusal(s().kpm.cancel(as('B_AB'), run.runId))).toMatchObject({ status: 404 });
      await s().kpm.cancel(as('OWNER'), run.runId);
      expect(await db().collection('surveyRuns').findOne({ _id: new mongoose.Types.ObjectId(run.runId) }))
        .toMatchObject({ deletedAt: expect.any(Date) });
    });
  });

  // ------------------------------------------------------------------------------- a session on the due day

  describe('ADR-0206 §4 a view-as session on a run’s first day writes nothing', () => {
    it('ADR-0206 §4 GET /surveys, /surveys/pending, /surveys/:runId and the results, read in a session: no snapshot, no invitation, no invitedCount', async () => {
      at('2026-10-27');
      const due = await db().collection('surveyRuns').findOne({ kpmId: KPM_A, kind: 'nps', periodKey: '2026-Q4', deletedAt: null });
      const runId = String(due!._id);
      expect(due).toMatchObject({ snapshot: null, openedAt: null, invitedCount: 0 });
      // A member's three reads, as the session sees them: the run has not opened, so it is nobody's yet.
      expect(await s().member.pending(session('INDAH'))).toMatchObject({ open: [], popup: null });
      expect((await s().member.list(session('INDAH'))).history).toEqual([]);
      expect(await refusal(s().member.form(session('INDAH'), runId))).toMatchObject({ status: 404, code: 'SURVEY_NOT_INVITED' });
      // The office's results, read in a session as the Owner: the run is listed as it stands.
      expect((await s().kpm.results(session('OWNER'), 'nps')).runs.map((r) => r.runId)).toEqual([runId]);
      expect(await refusal(s().coaching.read(session('AGUS'), office.id.INDAH))).toMatchObject({ status: 403, code: 'SURVEY_ANSWERS_HIDDEN' });
      expect(await db().collection('surveyRuns').findOne({ _id: due!._id }))
        .toMatchObject({ snapshot: null, openedAt: null, invitedCount: 0 });
      expect(await db().collection('surveyParticipation').countDocuments({ runId })).toBe(0);
    });
  });

  // --------------------------------------------------------------------------------------------- the reminder

  describe('opening and the reminder (C-R1 to C-R10; C2)', () => {
    let npsId: string;

    beforeAll(async () => {
      at('2026-10-27');
      npsId = (await s().kpm.results(as('OWNER'), 'nps')).runs[0].runId;
    });

    it('ADR-0216 §2 the first read on 27 October opens it: a snapshot, and every Aktif member of the invited classes', async () => {
      const pending = await s().member.pending(as('INDAH'));
      expect(pending.open.map((r) => [r.runId, r.answeredCount, r.totalCount, r.minutes, r.daysLeft])).toEqual([[npsId, 0, 6, 3, 13]]);
      const run = await db().collection('surveyRuns').findOne({ _id: new mongoose.Types.ObjectId(npsId) });
      expect(run?.snapshot).toMatchObject({ cutoffs: { promoterMin: 9, passiveMin: 7 }, notice: 'anonymous' });
      // Sixteen active in 0417; the member who left is not invited, and 0555's never are.
      const invited = await db().collection('surveyParticipation').find({ runId: npsId }).toArray();
      expect(invited).toHaveLength(16);
      expect(invited.some((p) => p.membershipId === office.id.LEFT || p.kpmId !== KPM_A)).toBe(false);
    });

    it('C-R3 on its first day the popup is Survei baru; drawn, it is not drawn again that day (C-R4)', async () => {
      const first = await s().member.pending(as('INDAH'));
      expect(first.popup).toEqual({ moment: 'opened', runIds: [npsId] });
      await s().member.popupShown(as('INDAH'), 'opened', [npsId]);
      expect((await s().member.pending(as('INDAH'))).popup).toBeNull();
    });

    it('C-R1, C2-5 only an invitee: another KPM’s member is refused the form 404 SURVEY_NOT_INVITED, and sees nothing', async () => {
      expect(await refusal(s().member.form(as('B_AGENT'), npsId))).toMatchObject({ status: 404, code: 'SURVEY_NOT_INVITED' });
      expect(await refusal(s().member.answer(as('B_AGENT'), npsId, 'P1', score(9)))).toMatchObject({ status: 404, code: 'SURVEY_NOT_INVITED' });
      expect(await s().member.pending(as('B_AGENT'))).toMatchObject({ open: [], popup: null });
      expect(await refusal(s().member.form(as('INDAH'), '66f0000000000000000000ff'))).toMatchObject({ code: 'SURVEY_NOT_INVITED' });
    });

    it('C2-2 on an ordinary day — 30 October — no popup, but the run is still open for the dot and the card', async () => {
      at('2026-10-30');
      expect(await s().member.pending(as('INDAH'))).toMatchObject({ popup: null, open: [{ runId: npsId, daysLeft: 10 }] });
    });

    it('C-R6, C2-3 one of six answered and closed: halfway on 2 November says 1 of 6, and Lanjutkan opens question 2', async () => {
      await s().member.answer(as('INDAH'), npsId, 'P1', { score: 8, why: 'Timnya solid.' });
      at('2026-11-02');
      const pending = await s().member.pending(as('INDAH'));
      expect(pending.popup).toEqual({ moment: 'halfway', runIds: [npsId] });
      expect(pending.open[0]).toMatchObject({ answeredCount: 1, totalCount: 6 });
      const form = await s().member.form(as('INDAH'), npsId);
      expect(form).toMatchObject({ state: 'open', answeredCount: 1, totalCount: 6, resumeIndex: 1, answers: { P1: { score: 8, why: 'Timnya solid.' } } });
      expect(form.questions.map((q) => q.kode)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'OPEN']);
    });

    it('ADR-0216 §3 a view-as session reads the form without the saved answers, and is shown no popup', async () => {
      const form = await s().member.form(session('INDAH'), npsId);
      expect(form.answers).toEqual({});
      expect(form.questions).toHaveLength(6);
      expect((await s().member.pending(session('INDAH'))).popup).toBeNull();
    });

    it('C2-1 on 8 November the red Berakhir besok, even after the halfway one was shown', async () => {
      await s().member.popupShown(as('INDAH'), 'halfway', [npsId]);
      at('2026-11-08');
      expect((await s().member.pending(as('INDAH'))).popup).toEqual({ moment: 'last_day', runIds: [npsId] });
    });

    it('AC-5 Kirim refuses a form with a score question unanswered, naming it; nothing is written', async () => {
      expect(await refusal(s().member.submit(as('INDAH'), npsId))).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
      expect(await db().collection('surveyResponses').countDocuments({ runId: npsId })).toBe(0);
    });

    it('AC-6, C2-4 sent: no popup, dot or card; the run is in Riwayat with the day; a second Kirim is 409 submitted', async () => {
      for (const kode of ['P2', 'P3', 'P4', 'P5']) await s().member.answer(as('INDAH'), npsId, kode, score(9));
      await s().member.answer(as('INDAH'), npsId, 'OPEN', { text: 'Lebih banyak pelatihan closing.' });
      await s().member.submit(as('INDAH'), npsId);
      const pending = await s().member.pending(as('INDAH'));
      expect(pending).toMatchObject({ open: [], popup: null, sentOpen: [{ runId: npsId }] });
      expect((await s().member.list(as('INDAH'))).history).toEqual([
        { runId: npsId, kind: 'nps', periodKey: '2026-Q4', submittedOn: '2026-11-08' },
      ]);
      expect(await refusal(s().member.submit(as('INDAH'), npsId))).toMatchObject({ status: 409, code: 'SURVEY_CLOSED', details: { reason: 'submitted' } });
      expect(await refusal(s().member.answer(as('INDAH'), npsId, 'P1', score(1)))).toMatchObject({ code: 'SURVEY_CLOSED', details: { reason: 'submitted' } });
    });

    it('ADR-0216 §3 AC-7 an anonymous run’s answer holds no person anywhere: no membership, no time, no author', async () => {
      const rows = await db().collection('surveyResponses').find({ runId: npsId }).toArray();
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({ membershipId: null, submittedAt: null, createdBy: null, updatedBy: null });
      expect(row.createdAt).toBeUndefined();
      expect(row.updatedAt).toBeUndefined();
      // The id is random bytes: its first four are not the second it was written.
      const idSeconds = (row._id as mongoose.Types.ObjectId).getTimestamp().getTime();
      expect(Math.abs(idSeconds - clock().now().getTime())).toBeGreaterThan(24 * 3600 * 1000);
      // Nothing in it names anybody of the office.
      const text = JSON.stringify(row);
      for (const id of Object.values(office.id)) expect(text.includes(id)).toBe(false);
      // The participation row says she answered, and no longer holds what.
      const part = await db().collection('surveyParticipation').findOne({ runId: npsId, membershipId: office.id.INDAH });
      expect(part).toMatchObject({ draftAnswers: null, submittedAt: expect.any(Date), answeredCount: 6 });
      // The bands from the member list, never asked: Indah is 27 (Gen Z, ≤ 29) and two years in (< 3).
      expect(row).toMatchObject({ roleClass: 'agent', ageBand: 0, tenureBand: 0 });
    });

    it('P19.5-T4 ADR-0216 §3 an anonymous run under three respondents shows no score and no open answer; at three it does', async () => {
      const one = (await s().kpm.results(as('OWNER'), 'nps', npsId)).selected!.nps!;
      expect(one).toMatchObject({ respondents: 1, improve: null, headline: { score: null, change: null, shares: null, reasons: null } });
      expect(one.questions.map((q) => q.score)).toEqual([null, null, null, null]);
      expect(JSON.stringify(one)).not.toContain('Lebih banyak pelatihan closing');
      await answerNps('RINA', npsId, [9, 9, 9, 9, 9]);
      expect((await s().kpm.results(as('OWNER'), 'nps', npsId)).selected!.nps!).toMatchObject({ respondents: 2, headline: { score: null } });
      await answerNps('BUDI', npsId, [6, 6, 6, 6, 6]);
      const three = (await s().kpm.results(as('OWNER'), 'nps', npsId)).selected!.nps!;
      // P19.22-T6 AC-2 (ADR-0276 §1): *Keseluruhan KPM* is P1 — Indah 8, Rina 9, Budi 6: one promoter, one detractor of 3.
      expect(three).toMatchObject({ respondents: 3, headline: { kode: 'P1', score: 0, n: 3, shares: { promoterPct: 33, detractorPct: 33 } } });
      // Three agents sent it: the quote may say *Agent* (ADR-0276 §3).
      expect(three.improve).toEqual([{ text: 'Lebih banyak pelatihan closing.', who: 'agent' }]);
    });

    it('C-R5 after the run closes: no popup, no card, and a write is 409 closed', async () => {
      at('2026-11-10');
      expect(await s().member.pending(as('DIMAS'))).toMatchObject({ open: [], popup: null, sentOpen: [] });
      expect(await refusal(s().member.answer(as('DIMAS'), npsId, 'P1', score(9)))).toMatchObject({ code: 'SURVEY_CLOSED', details: { reason: 'closed' } });
      expect((await s().member.form(as('DIMAS'), npsId))).toMatchObject({ state: 'closed', questions: [] });
    });
  });

  // ---------------------------------------------------------------------------------------------- the results

  describe('AC-2, AC-3 NPS results on the run’s own cut-offs (AT-8)', () => {
    let q4: string;
    let q1: string;

    beforeAll(async () => {
      at('2026-11-12');
      q4 = (await s().kpm.results(as('OWNER'), 'nps')).runs[0].runId;
    });

    it('AT-8 AA Case 7 moving the promoter cut-off to 8 and publishing leaves Q4 2026 as it was; the next run uses 8', async () => {
      const before = (await s().kpm.results(as('OWNER'), 'nps', q4)).selected!.nps!;
      await publish(2, (c) => {
        c.nps.promoterMin = 8;
      });
      const after = (await s().kpm.results(as('OWNER'), 'nps', q4)).selected!.nps!;
      expect(after.cutoffs).toMatchObject({ promoterMin: 9, passiveMin: 7 });
      expect(after.headline).toEqual(before.headline);
      at('2027-01-04');
      q1 = (await s().kpm.create(as('OWNER'), 'nps', {
        opensOn: '2027-01-05', closesOn: '2027-01-20', invitedRoleClasses: ['agent', 'aab', 'ab'], anonymous: true, remindHalfway: false,
      })).runId;
      at('2027-01-05');
      const next = await s().kpm.results(as('OWNER'), 'nps', q1);
      expect(next.selected!.nps!.cutoffs).toMatchObject({ promoterMin: 8, passiveMin: 7 });
    });

    it('AC-3 overall, per aspect and per question, the change from Q4 by kode, and the open answers with no names', async () => {
      await answerNps('DIMAS', q1, [8, 8, 8, 8, 8], 'Jadwal training lebih jelas.');
      await answerNps('RINA', q1, [10, 9, 9, 9, 9]);
      await answerNps('SARI', q1, [3, 5, 6, 6, 7]);
      const { selected } = await s().kpm.results(as('OWNER'), 'nps', q1);
      const nps = selected!.nps!;
      // P1 at a cut-off of 8: Dimas 8 and Rina 10 promoters, Sari 3 a detractor of 3 — round(100 · 1 / 3) = 33.
      expect(nps.headline).toMatchObject({ kode: 'P1', score: 33, n: 3 });
      expect(selected!.previousRunId).toBe(q4);
      // Q4's P1 was 0: +33 poin, and the trend runs Q4 → Q1 (P19.22-T6 AC-2).
      expect(nps.headline!.change).toBe(33);
      expect(nps.trendPeriods).toEqual(['2026-Q4', '2027-Q1']);
      expect(nps.headline!.trend).toEqual([0, 33]);
      // Two agents and an AAB: neither class has three, so the quote names no class (ADR-0276 §3).
      expect(nps.improve).toEqual([{ text: 'Jadwal training lebih jelas.', who: null }]);
      expect(JSON.stringify(nps)).not.toMatch(/Dimas|Rina|Sari/);
      expect(selected!.responses).toMatchObject({ sent: 3, invited: 16, leaders: 1, agents: 2 });
    });

    it('P19.22-T6 AC-3 Survei baru: the quarter’s run, its live progress and who has not answered; the preview; no names for a summary', async () => {
      const { send, canWrite } = await s().kpm.results(as('OWNER'), 'nps');
      expect(canWrite).toBe(true);
      expect(send).toMatchObject({ periodKey: '2027-Q1', closesOnMax: '2027-03-31', invitable: 16, run: { runId: q1, responses: { sent: 3, invited: 16 } } });
      expect(send.preview.map((p) => p.kodes[0])).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'OPEN']);
      expect(send.minutes).toBeGreaterThan(0);
      expect(send.notAnswered).toHaveLength(13);
      const names = send.notAnswered!.map((p) => p.name);
      expect(names).toContain('Indah Permatasari');
      expect(names).not.toContain('Dimas Pratama');
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
      const summary = await s().kpm.results(session('OWNER'), 'nps');
      expect(summary.send.notAnswered).toBeNull();
      expect(summary.canWrite).toBe(false);
      // *Survei sebelumnya*'s *NPS x%*: Q4's headline over its three forms.
      expect((await s().kpm.results(as('OWNER'), 'nps')).runs.find((r) => r.runId === q4)!.headlineScore).toBe(0);
    });

    it('AC-3 a question whose text changed under the same kode says so', async () => {
      at('2027-03-25');
      await publish(3, (c) => {
        c.nps.promoterMin = 8;
        c.nps.questions[1].text = { id: 'Seberapa jelas visi KPM?', en: 'How clear is the vision?' };
      });
      const q2 = (await s().kpm.create(as('OWNER'), 'nps', {
        opensOn: '2027-04-01', closesOn: '2027-04-10', invitedRoleClasses: ['agent'], anonymous: true, remindHalfway: false,
      })).runId;
      at('2027-04-02');
      const nps = (await s().kpm.results(as('OWNER'), 'nps', q2)).selected!.nps!;
      expect([nps.headline!.kode, nps.headline!.textChanged]).toEqual(['P1', false]);
      expect(nps.questions.map((q) => [q.kode, q.textChanged])).toEqual([
        ['P2', true], ['P3', false], ['P4', false], ['P5', false],
      ]);
    });

    it('P19.22-T6 AC-1 ADR-0276 §3 Semua | Leader | Agent: an anonymous run’s class view is hidden while a class has under three', async () => {
      // Two agents and one AAB answered: the leaders' view would be Sari's own answer, the agents' the rest of it.
      for (const who of ['leader', 'agent'] as const) {
        const view = (await s().kpm.results(as('OWNER'), 'nps', q1, who)).selected!.nps!;
        expect(view).toMatchObject({ who, whoShown: false, improve: null, headline: { score: null, reasons: null } });
      }
      expect((await s().kpm.results(as('OWNER'), 'nps', q1, 'leader')).selected!.nps!.respondents).toBe(1);
      expect((await s().kpm.results(as('OWNER'), 'nps', q1, 'all')).selected!.nps!.whoShown).toBe(true);
    });

    it('A-R9 a view-as session reads a summary: no open answers; a non-Core leader is 404; a Core Leader reads', async () => {
      expect((await s().kpm.results(session('OWNER'), 'nps', q1)).selected!.nps!.improve).toBeNull();
      expect((await s().kpm.results(session('OWNER'), 'nps', q1)).canWrite).toBe(false);
      expect(await refusal(s().kpm.results(as('AGUS'), 'nps'))).toMatchObject({ status: 404 });
      expect((await s().kpm.results(coreLeader('AGUS'), 'nps', q1)).audience).toBe('core_leader');
    });

    it('cross-tenant: another KPM’s run is 404 to the results; its own tab lists none of 0417’s', async () => {
      const b = new RequestContext('u-b', 'none', { ...as('B_AB').membership!, isKpmOwner: true });
      expect(await refusal(s().kpm.results(b, 'nps', q1))).toMatchObject({ status: 404 });
      expect((await s().kpm.results(b, 'nps')).runs).toEqual([]);
    });
  });

  describe('AC-13, AT-12 NPS turned off while a run is open', () => {
    it('AT-12 AA Case 9 the Bagian switch counts the open run; it runs to its end; the tab hides after; turned on, it is back', async () => {
      at('2027-04-03');
      const sa = RequestContext.platform('u-super');
      expect(await s().openRuns.openIn(sa, [KPM_A, KPM_B], 'nps')).toEqual({ runs: 1, kpms: 1 });
      await publish(4, (c) => {
        c.sections.find((x) => x.kode === 'NPS')!.enabled = false;
      });
      const during = await s().kpm.results(as('OWNER'), 'nps');
      expect(during).toMatchObject({ sectionOn: false, visible: true });
      const runId = during.runs.find((r) => r.state === 'open')!.runId;
      // An answer sent after the switch is saved.
      await answerNps('INDAH', runId, [9, 9, 9, 9, 9]);
      expect(await db().collection('surveyResponses').countDocuments({ runId })).toBe(1);
      // No new run while it is off.
      expect(await refusal(s().kpm.create(as('OWNER'), 'nps', {
        opensOn: '2027-04-20', closesOn: '2027-04-25', invitedRoleClasses: ['agent'], anonymous: true, remindHalfway: false,
      }))).toMatchObject({ code: 'SURVEY_RUN_CONFLICT', details: { reason: 'section_off' } });
      at('2027-04-11');
      expect(await s().kpm.results(as('OWNER'), 'nps')).toMatchObject({ visible: false });
      await publish(5, () => undefined);
      const back = await s().kpm.results(as('OWNER'), 'nps', runId);
      expect(back).toMatchObject({ visible: true });
      expect(back.selected!.nps!.respondents).toBe(1);
      expect(await s().openRuns.openIn(sa, [KPM_A], 'nps')).toEqual({ runs: 0, kpms: 0 });
    });
  });

  // ------------------------------------------------------------------------------------- the coaching Survei tab

  describe('AC-14 to AC-19 the qualitative run and the coaching Survei tab', () => {
    let june: string;

    beforeAll(async () => {
      at('2027-05-30');
      june = (await s().kpm.create(as('OWNER'), 'qual', {
        opensOn: '2027-06-01', closesOn: '2027-06-30', invitedRoleClasses: ['agent', 'aab', 'ab'], anonymous: false,
        perPerson: true, remindHalfway: true,
      })).runId;
      at('2027-06-02');
      const indah = as('INDAH');
      expect((await s().member.form(indah, june)).questions.map((q) => q.kode)).toEqual(['Q4', 'Q5', 'Q12']);
      await s().member.answer(indah, june, 'Q4', { chosen: ['TOP'], note: 'Target saya MDRT dalam 2 tahun.' });
      await s().member.answer(indah, june, 'Q5', {
        FREQUENCY: 3, ACTIVITY: 4, PIPELINE: 2, APPOINTMENT: 3, FACT_FINDING: 4, PRESENTATION: 5, PRODUCT: 3,
      });
      await s().member.answer(indah, june, 'Q12', { score: 4, reason: 'Leader saya jarang ada.' });
      await s().member.submit(indah, june);
      // Sari (AAB) answers the leader blocks, Q11 about Nina, her own downline leader.
      const sari = as('SARI');
      const form = await s().member.form(sari, june);
      expect(form.downlineLeaders.map((d) => d.membershipId)).toEqual([office.id.NINA]);
      const all = (kodes: string[], v: unknown) => Object.fromEntries(kodes.map((k) => [k, v]));
      const items = (kode: string) => form.questions.find((q) => q.kode === kode)!.items.map((i) => i.kode);
      await s().member.answer(sari, june, 'Q4', { chosen: ['TEAM'] });
      await s().member.answer(sari, june, 'Q5', all(items('Q5'), 4));
      await s().member.answer(sari, june, 'Q6', { ...all(items('Q6'), 3), PITCH: 2 });
      await s().member.answer(sari, june, 'Q7', { ...all(items('Q7'), 'consistent'), JFW: 'not_done' });
      await s().member.answer(sari, june, 'Q8', all(items('Q8'), 'inconsistent'));
      await s().member.answer(sari, june, 'Q9', all(items('Q9'), 5));
      await s().member.answer(sari, june, 'Q10', { answer: 'yes' });
      await s().member.answer(sari, june, 'Q11', { leaders: [{ membershipId: office.id.NINA, areas: ['SALES', 'ACTIVATION'] }] });
      await s().member.answer(sari, june, 'Q12', { score: 9 });
      await s().member.submit(sari, june);
    });

    it('B4-1 AC-14 AB Agus opens Indah: Penjualan 4 for Jun 2027, her aspiration and note, and no Q12', async () => {
      const view = await s().coaching.read(as('AGUS'), office.id.INDAH);
      expect(view.state).toBe('answered');
      expect(view.issueCounts.map((c) => [c.kode, c.count])).toEqual([['SALES', 4]]);
      expect(view.aspiration).toMatchObject({ note: 'Target saya MDRT dalam 2 tahun.' });
      expect(view.aspiration!.options.filter((o) => o.chosen).map((o) => o.kode)).toEqual(['TOP']);
      expect(view.person).toMatchObject({ workStatus: 'full_time', tenureYears: 2, age: 28, generation: 0 });
      const wire = JSON.stringify(view);
      expect(wire).not.toMatch(/Q12|Leader saya jarang ada|"score":4/);
    });

    it('B4-3 for an AAB the sections are Penjualan, Rekrutmen, Aktivasi, Manajemen unit and the downline card', async () => {
      const view = await s().coaching.read(as('AGUS'), office.id.SARI);
      expect(view.sections.map((x) => [x.kode, x.kind])).toEqual([
        ['SALES', 'scale'], ['RECRUIT', 'scale'], ['ACTIVATION', 'state'], ['UNIT', 'unit'], ['COACHING', 'downline'],
      ]);
      // Q6: every item 3 (an issue) — 8; Q7: one not done; Q8·Q9: eight inconsistent, comfort 5.
      expect(view.issueCounts.map((c) => [c.kode, c.count])).toEqual([['SALES', 0], ['RECRUIT', 8], ['ACTIVATION', 1], ['UNIT', 8]]);
      const downline = view.sections.find((x) => x.kind === 'downline') as Extract<typeof view.sections[number], { kind: 'downline' }>;
      expect(downline).toMatchObject({ stillCoaching: true, leaders: [{ membershipId: office.id.NINA, name: 'Nina Lestari' }] });
      expect(JSON.stringify(view)).not.toContain('"score":9');
    });

    it('AC-16 the Owner and an Admin read it; B4-6 ADR-0216 §3 a leader outside the line is 404, as another office’s person is', async () => {
      expect((await s().coaching.read(as('OWNER'), office.id.INDAH)).state).toBe('answered');
      expect((await s().coaching.read(as('ADMIN'), office.id.INDAH)).state).toBe('answered');
      expect((await s().coaching.read(as('SARI'), office.id.RINA)).state).toBe('not_answered');
      const beyond = await refusal(s().coaching.read(as('PEER_AB'), office.id.INDAH));
      expect(beyond).toMatchObject({ status: 404 });
      // The same answer, word for word, as a person of another office: nothing says Indah is in 0417.
      expect(await refusal(s().coaching.read(as('PEER_AB'), office.id.B_AGENT))).toEqual(beyond);
      expect(await refusal(s().coaching.read(as('SARI'), office.id.INDAH))).toEqual(beyond);
      // Refused before the read is recorded: the Owner's read wrote its §3.5 entry, the readers outside the line none.
      expect(await db().collection('auditLog').countDocuments({
        targetMembershipId: office.id.INDAH, actorMembershipId: office.id.OWNER, 'after.surface': 'survey',
      })).toBeGreaterThan(0);
      expect(await db().collection('auditLog').countDocuments({
        targetMembershipId: office.id.INDAH, actorMembershipId: { $in: [office.id.PEER_AB, office.id.SARI] }, 'after.surface': 'survey',
      })).toBe(0);
    });

    it('A-R9, A5-6 a view-as session is 403 whoever it acts as; cross-tenant: another KPM’s person is 404', async () => {
      expect(await refusal(s().coaching.read(session('OWNER'), office.id.INDAH))).toMatchObject({ status: 403, code: 'SURVEY_ANSWERS_HIDDEN' });
      expect(await refusal(s().coaching.read(as('B_AB'), office.id.INDAH))).toMatchObject({ status: 404 });
      expect(await refusal(s().coaching.read(as('OWNER'), office.id.B_AGENT))).toMatchObject({ status: 404 });
    });

    it('B4-5 AC-15 Rina was invited and has not sent it: not_answered, with no answer', async () => {
      at('2027-07-02');
      const view = await s().coaching.read(as('AGUS'), office.id.RINA);
      expect(view).toMatchObject({ state: 'not_answered', run: { periodKey: '2027-06', closesOn: '2027-06-30' }, sections: [], person: null });
    });

    it('AC-15 none: a member no qualitative run invited; NPS runs never appear here', async () => {
      await db().collection('surveyParticipation').deleteMany({ runId: june, membershipId: office.id.TARI });
      expect((await s().coaching.read(as('AGUS'), office.id.TARI)).state).toBe('none');
    });

    it('AC-19 opening the tab writes the §3.5 entry, surface survey, the run’s dates', async () => {
      const entries = await db().collection('auditLog')
        .find({ targetMembershipId: office.id.INDAH, 'after.surface': 'survey' }).toArray();
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].after).toEqual({ surface: 'survey', from: '2027-06-01', to: '2027-06-30' });
    });

    it('P19.22-T7 AC-2 the qualitative results: issue % per item, Dukungan leader by who rated, the downline table, notes on tap', async () => {
      const office0417 = await s().kpm.results(as('OWNER'), 'qual', june);
      const qual = office0417.selected!.qual!;
      const pipeline = qual.blocks.find((b) => b.kode === 'SALES')!.rows.find((i) => i.itemKode === 'PIPELINE')!;
      expect(pipeline).toMatchObject({ answers: 2, issuePct: 50, severity: 'watch', previousPct: null, trend: null });
      // ADR-0276 §5: *Agent menilai leader* (Indah, 4) and *Leader menilai upline* (Sari, 9) — a named run keeps both.
      expect(qual.support).toEqual([
        { rater: 'agent', n: 1, average: 4, satisfiedPct: 0, fairPct: 0, poorPct: 100 },
        { rater: 'leader', n: 1, average: 9, satisfiedPct: 100, fairPct: 0, poorPct: 0 },
      ]);
      expect(qual.coachingDownline).toMatchObject({
        asked: true, n: 1, yes: 1, pct: 100, good: true,
        rows: [{ leaderId: office.id.NINA, uplineId: office.id.SARI, areas: ['SALES', 'ACTIVATION'], independent: false }],
      });
      expect(qual.aspirationNotes).toEqual([{ text: 'Target saya MDRT dalam 2 tahun.', who: 'agent' }]);
      expect(qual.profile.workStatus).toMatchObject({ fullTime: 1 });
      // One reason with Q12: *Suara responden* waits for three, and Q12's reason never crosses under it.
      expect(qual.voices).toBeNull();
      expect(JSON.stringify(qual)).not.toMatch(/jarang/);
      // A core leader reads the Owner's figures (ADR-0268) but never the reasons given about leaders (ADR-0276 §5).
      const core = (await s().kpm.results(coreLeader('AGUS'), 'qual', june)).selected!.qual!;
      expect(core.support).toHaveLength(2);
      expect(core.voices).toBeNull();
      // The downline table is per-person answers: Sari is Agus's own, so he sees her row; a core leader elsewhere none.
      expect(core.coachingDownline.rows).toMatchObject([{ uplineName: 'Sari Puspita', leaderName: 'Nina Lestari' }]);
      expect((await s().kpm.results(coreLeader('PEER_AB'), 'qual', june)).selected!.qual!.coachingDownline.rows).toEqual([]);
      const summary = (await s().kpm.results(session('OWNER'), 'qual', june)).selected!.qual!;
      expect(summary).toMatchObject({ aspirationNotes: null, voices: null });
      expect(summary.coachingDownline.rows).toBeNull();
      // *Agent*: the leader blocks were not asked of them.
      const agents = (await s().kpm.results(as('OWNER'), 'qual', june, 'agent')).selected!.qual!;
      expect(agents.blocks.find((b) => b.kode === 'RECRUIT')).toMatchObject({ asked: false, rows: [] });
    });

    it('P19.22-T7 AC-3 Per orang: every invitee, n item bermasalah, Belum menjawab; rows open for the Owner', async () => {
      const view = await s().people.people(as('OWNER'), june);
      expect(view).toMatchObject({ audience: 'office', answersShown: true, run: { periodKey: '2027-06' }, issueMaxRating: 3 });
      const row = (id: string) => view.people!.find((p) => p.membershipId === id)!;
      // Indah's Q5: 3, 4, 2, 3, 4, 5, 3 — four at 3 or below.
      expect(row(office.id.INDAH)).toMatchObject({
        name: 'Indah Permatasari', roleClass: 'agent', upline: 'Agus Salim', answered: true, issues: 4, canOpen: true,
        workStatus: 'full_time', tenureYears: 3, age: 28, generation: 0, phone: null,
      });
      // Sari: Rekrutmen 8, Aktivasi 1, Manajemen unit 8 inconsistent — 17 items.
      expect(row(office.id.SARI)).toMatchObject({ roleClass: 'aab', issues: 17, canOpen: true });
      expect(row(office.id.RINA)).toMatchObject({ answered: false, issues: null, canOpen: false });
      expect(view.people!.map((p) => p.name)).toEqual([...view.people!.map((p) => p.name)].sort((a, b) => a.localeCompare(b)));
    });

    it('P19.22-T7 AC-3 ADR-0276 §5 one person’s answers: tiles x/y, Q4, the cards; Q12 to the office alone; audited', async () => {
      const indah = await s().people.person(as('OWNER'), office.id.INDAH, june);
      expect(indah.tiles.map((t) => [t.kode, t.count, t.of])).toEqual([['SALES', 4, 7]]);
      expect(indah.aspiration).toMatchObject({ note: 'Target saya MDRT dalam 2 tahun.' });
      expect(indah.support).toEqual({ kode: 'Q12', score: 4 });
      expect(JSON.stringify(indah)).not.toContain('jarang');
      const sari = await s().people.person(as('ADMIN'), office.id.SARI, june);
      expect(sari.tiles.map((t) => [t.kode, t.count, t.of])).toEqual([['SALES', 0, 7], ['RECRUIT', 8, 8], ['ACTIVATION', 1, 7], ['UNIT', 8, 8]]);
      // The Super Admin inside the KPM reads as its Owner (ADR-0268).
      const root = RequestContext.superAdminInKpm(RequestContext.platform('u-root'), KPM_A);
      expect((await s().people.person(root, office.id.INDAH, june)).support).toEqual({ kode: 'Q12', score: 4 });
      expect((await s().people.people(root, june)).audience).toBe('office');
      expect(await db().collection('auditLog').countDocuments({
        targetMembershipId: office.id.SARI, actorMembershipId: office.id.ADMIN, 'after.surface': 'survey',
      })).toBeGreaterThan(0);
    });

    it('P19.22-T7 AC-3 ADR-0276 §5 a core leader opens their own downline only, and never sees Q12', async () => {
      const agus = await s().people.people(coreLeader('AGUS'), june);
      expect(agus.people!.find((p) => p.membershipId === office.id.INDAH)!.canOpen).toBe(true);
      expect((await s().people.person(coreLeader('AGUS'), office.id.INDAH, june)).support).toBeNull();
      const peer = await s().people.people(coreLeader('PEER_AB'), june);
      expect(peer.people!.find((p) => p.membershipId === office.id.INDAH)!.canOpen).toBe(false);
      expect(await refusal(s().people.person(coreLeader('PEER_AB'), office.id.INDAH, june))).toMatchObject({ status: 404 });
    });

    it('P19.22-T7 AC-3 refusals: not answered is 404; a plain AB 404; a view-as session no names and 403; another KPM 404', async () => {
      expect(await refusal(s().people.person(as('OWNER'), office.id.RINA, june))).toMatchObject({ status: 404 });
      expect(await refusal(s().people.people(as('AGUS'), june))).toMatchObject({ status: 404 });
      expect(await refusal(s().people.people(as('INDAH'), june))).toMatchObject({ status: 404 });
      expect((await s().people.people(session('OWNER'), june)).people).toBeNull();
      expect(await refusal(s().people.person(session('OWNER'), office.id.INDAH, june))).toMatchObject({ status: 403, code: 'SURVEY_ANSWERS_HIDDEN' });
      const b = new RequestContext('u-b', 'none', { ...as('B_AB').membership!, isKpmOwner: true });
      expect(await refusal(s().people.people(b, june))).toMatchObject({ status: 404 });
      expect(await refusal(s().people.person(b, office.id.INDAH))).toMatchObject({ status: 404 });
      expect(await refusal(s().people.person(as('OWNER'), office.id.B_AGENT, june))).toMatchObject({ status: 404 });
    });

    it('B4-4 AC-15 an anonymous qualitative run: the tab says so, and no answer crosses the network', async () => {
      at('2027-11-30');
      const dec = (await s().kpm.create(as('OWNER'), 'qual', {
        opensOn: '2027-12-01', closesOn: '2027-12-20', invitedRoleClasses: ['agent'], anonymous: true, perPerson: true, remindHalfway: false,
      })).runId;
      at('2027-12-02');
      const indah = as('INDAH');
      await s().member.answer(indah, dec, 'Q4', { chosen: ['FLOW'] });
      await s().member.answer(indah, dec, 'Q5', Object.fromEntries(
        (await s().member.form(indah, dec)).questions[1].items.map((i) => [i.kode, 1]),
      ));
      await s().member.answer(indah, dec, 'Q12', { score: 2 });
      await s().member.submit(indah, dec);
      const view = await s().coaching.read(as('AGUS'), office.id.INDAH);
      expect(view).toMatchObject({ state: 'anonymous', run: { periodKey: '2027-12' }, sections: [], aspiration: null, person: null });
      expect(await db().collection('surveyResponses').findOne({ runId: dec })).toMatchObject({ membershipId: null, noticeShown: false });
      // P19.22-T7 AC-3 (ADR-0276 §5): *Per orang* of an anonymous run lists who answered, and no row opens.
      const people = await s().people.people(as('OWNER'), dec);
      expect(people.answersShown).toBe(false);
      expect(people.people!.find((p) => p.membershipId === office.id.INDAH)).toMatchObject({ answered: true, issues: null, canOpen: false });
      expect(await refusal(s().people.person(as('OWNER'), office.id.INDAH, dec))).toMatchObject({ status: 404 });
    });

    it('P19.22-T6 AC-3 ADR-0268 a core leader and the Super Admin inside the KPM send and cancel; a plain AB is 404', async () => {
      const root = RequestContext.superAdminInKpm(RequestContext.platform('u-root'), KPM_A);
      const next = await s().kpm.create(root, 'qual', {
        opensOn: '2028-06-01', closesOn: '2028-06-30', invitedRoleClasses: ['agent', 'aab', 'ab'], anonymous: false,
        perPerson: true, remindHalfway: true,
      });
      expect(next).toMatchObject({ periodKey: '2028-06', state: 'scheduled' });
      const moved = await s().kpm.update(coreLeader('AGUS'), next.runId, { closesOn: '2028-06-20' });
      expect(moved.closesOn).toBe('2028-06-20');
      await s().kpm.cancel(coreLeader('AGUS'), next.runId);
      expect(await refusal(s().kpm.create(as('AGUS'), 'qual', {
        opensOn: '2028-06-01', closesOn: '2028-06-30', invitedRoleClasses: ['agent'], anonymous: true, remindHalfway: false,
      }))).toMatchObject({ status: 404 });
      expect((await s().kpm.results(root, 'qual')).audience).toBe('office');
    });
  });
});
