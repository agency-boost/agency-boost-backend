import { randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { addDays, localDayOf, type LocalDate } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE, type SurveyRoleClass } from '@/domain/constants';
import { AnalyticsConfigReader } from '@/modules/config/analytics-config.reader';
import { CompanyTemplate, CompanyTemplateSchema } from '@/modules/config/company-template.schema';
import { NamedTemplate, NamedTemplateSchema } from '@/modules/config/named-template.schema';
import { snapshotOf } from '@/modules/surveys/survey-opening';
import { askedQuestions, bandOf, halfwayDay, periodBounds, tenureBandOf, wholeYears } from '@/modules/surveys/survey-rules';
import type { SurveyKind } from '@/modules/surveys/survey-run.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { seedObjectId } from './coaching-fixture';

const RECOMPILE = { overwriteModels: true } as const;

/** One person of the fixture: their membership, the class they are invited as, and their KPM. */
export interface SurveyPerson {
  membershipId: string;
  roleClass: SurveyRoleClass;
}

export interface SurveysFixture {
  runs: { npsOpen: string; npsPrevious: string; qualJune: string; qualAnonymous0555: string };
  /** The periods, so a test reads them as the run's today made them. */
  periods: { npsOpen: string; npsPrevious: string; qual: string };
  guide: string;
}

/**
 * **The surveys, seeded** (P19.5-T4 AC-20; ADR-0216 §10; `functional/surveys.md`). Every run is dated from the seed's
 * today in Jakarta, so the reminder is walkable on any day:
 *
 * | Run | Its dates | What it shows, and as whom |
 * |---|---|---|
 * | **0417's open NPS** (this quarter, anonymous, *Ingatkan di tengah* on) | nine days ago to four days ahead, inside the quarter | `indah@kpm0417.test`: *Lainnya*'s red dot and *Perlu diisi* card — *"1 dari 6 terjawab"*, *Lanjutkan* — the *Survei* tile's dot, `/surveys`. Dimas, Siti and Rina have sent it: *"Terima kasih, survei sudah diisi"*. The Owner's NPS tab: *Berjalan*, 3 of the office |
 * | **0417's previous-quarter NPS**, closed, anonymous | the 32nd to the 51st day of last quarter | Riwayat for the five who sent it; the Owner's NPS tab: the score, the open answers with no names, and the change the open run is compared by |
 * | **0417's June qualitative run** (the latest June or December closed), shown per person, the notice shown | the whole month | `agus@kpm0417.test` → Coaching → **Indah Permatasari → Survei**: *Penjualan 4*, her aspiration (B4-1). **Arief Hidayat** (AAB) answered as the mockup's Ika: *Penjualan tim · Rekrutmen · Aktivasi · Manajemen unit* (B4-3). **Sari Puspita** was invited and did not answer: *"Sari belum mengisi survei …"* (B4-5). `owner@kpm0417.test` → **Yosef Tambunan** (AB) answered as Fajar, with *Coaching leader downline* for Winda. **Dimas**: no run invited him, *Belum ada survei* |
 * | **0555's June qualitative run**, anonymous | the same month | `owner@kpm0555.test` → Coaching → **Lina** → Survei: *"Survei … dijalankan anonim"*, no answer sent (B4-4) |
 *
 * **The cast postdates June for some**: Indah, Arief and Agus joined after it. The fixture writes the invitations the
 * mockup draws rather than the ones an opening would have written, so B4-1 and B4-3 walk on any day — a demo's
 * licence, recorded here. Every answer to Q12 is seeded, and none is ever shown to a leader.
 *
 * Derived ids, written once until `--reset` (`seedObjectId`); an anonymous form has twelve random bytes for an id, as
 * the product writes one, and a re-run that finds a run's forms writes none.
 */
export async function seedSurveysFixture(deps: {
  clock: Clock;
  office0417: {
    kpmId: string;
    people: Record<'owner' | 'admin' | 'agus' | 'sari' | 'indah' | 'arief' | 'dimas' | 'siti' | 'rina' | 'yosef' | 'winda', SurveyPerson>;
    /** Every active member, invited to the NPS runs. */
    everyone: SurveyPerson[];
  };
  office0555: { kpmId: string; lina: SurveyPerson; owner: SurveyPerson };
}): Promise<SurveysFixture> {
  const db = mongoose.connection.db!;
  const model = (name: string, schema: mongoose.Schema): never => mongoose.model(name, schema, undefined, RECOMPILE) as never;
  const reader = new AnalyticsConfigReader(
    model(Kpm.name, KpmSchema), model(NamedTemplate.name, NamedTemplateSchema), model(CompanyTemplate.name, CompanyTemplateSchema),
  );
  const now = deps.clock.now();
  const today = localDayOf(now, DEFAULT_TENANT_TIMEZONE);
  const p = deps.office0417.people;

  // ------------------------------------------------------------------------------------------- the periods
  const [y, m] = today.split('-').map(Number);
  const quarter = `${y}-Q${Math.ceil(m / 3)}`;
  const q = periodBounds(quarter);
  const prevQuarter = m <= 3 ? `${y - 1}-Q4` : `${y}-Q${Math.ceil(m / 3) - 1}`;
  const pq = periodBounds(prevQuarter);
  // The latest June or December that has closed.
  const qualKey = m >= 7 ? `${y}-06` : `${y - 1}-12`;
  const qb = periodBounds(qualKey);
  const opensNps = [addDays(today, -9), q.first].sort()[1];
  const closesNps = [addDays(today, 4), q.last].sort()[0];

  // ---------------------------------------------------------------------------------------------- the runs
  const birthAndJoin = async (kpmId: string, ids: readonly string[]) => {
    const members = await db.collection('memberships')
      .find({ kpmId, _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } }).toArray();
    const users = await db.collection('users')
      .find({ _id: { $in: members.map((x) => new mongoose.Types.ObjectId(String(x.userId))) } }).toArray();
    const dob = new Map(users.map((u) => [String(u._id), (u.dateOfBirth as string | null) ?? null]));
    return new Map(members.map((x) => [String(x._id), { joinDate: (x.joinDate as string | null) ?? null, dob: dob.get(String(x.userId)) ?? null }]));
  };

  async function run(spec: {
    slot: string; kpmId: string; kind: SurveyKind; periodKey: string; opensOn: LocalDate; closesOn: LocalDate;
    anonymous: boolean; perPerson: boolean; remindHalfway: boolean; invited: SurveyPerson[]; createdBy: string;
    downline?: ReadonlySet<string>;
    answers: { who: SurveyPerson; draftOnly?: boolean; values: Record<string, Record<string, unknown>> }[];
  }): Promise<string> {
    const runId = seedObjectId('surveyRun', spec.kpmId, spec.slot);
    const _id = new mongoose.Types.ObjectId(runId);
    if (await db.collection('surveyRuns').findOne({ _id })) return runId;
    const published = await reader.forOffice(spec.kpmId);
    const snapshot = snapshotOf(spec, published);
    const asks = (who: SurveyPerson) => askedQuestions(spec.kind, snapshot, who.roleClass, { downlineLeaders: spec.downline?.has(who.membershipId) ?? false });
    await db.collection('surveyRuns').insertOne({
      _id, kpmId: spec.kpmId, kind: spec.kind, periodKey: spec.periodKey, opensOn: spec.opensOn, closesOn: spec.closesOn,
      invitedRoleClasses: ['agent', 'aab', 'ab'], anonymous: spec.anonymous, perPerson: spec.perPerson,
      remindHalfway: spec.remindHalfway, snapshot, openedAt: now, invitedCount: spec.invited.length, deletedAt: null,
      createdBy: spec.createdBy, updatedBy: spec.createdBy, createdAt: now, updatedAt: now, version: 0,
    });
    const facts = await birthAndJoin(spec.kpmId, spec.invited.map((w) => w.membershipId));
    const reference = spec.closesOn < today ? spec.closesOn : today;
    const sentAt = (i: number) => new Date(Date.parse(`${spec.closesOn < today ? addDays(spec.closesOn, -3 - i) : addDays(today, -1 - i)}T03:00:00Z`));
    await db.collection('surveyParticipation').insertMany(spec.invited.map((who) => {
      const answered = spec.answers.find((a) => a.who.membershipId === who.membershipId);
      const index = spec.answers.indexOf(answered!);
      const asked = asks(who);
      const sent = answered && !answered.draftOnly;
      const lastPopupOn = spec.closesOn < today ? null : addDays(today, -1);
      return {
        _id: new mongoose.Types.ObjectId(seedObjectId('surveyParticipation', runId, who.membershipId)),
        kpmId: spec.kpmId, runId, membershipId: who.membershipId, roleClass: who.roleClass,
        asksDownline: spec.downline?.has(who.membershipId) ?? false,
        answeredCount: answered ? asked.filter((x) => answered.values[x.kode] !== undefined).length : 0,
        totalCount: asked.length,
        lastQuestionKode: answered ? Object.keys(answered.values).at(-1) ?? null : null,
        draftAnswers: answered?.draftOnly ? answered.values : null,
        submittedAt: sent ? sentAt(index) : null,
        // The opening popup was shown yesterday to whoever has a draft; the halfway one, once due, is still to come.
        reminder: { lastPopupOn: answered?.draftOnly ? lastPopupOn : null, momentsShown: answered?.draftOnly ? ['opened'] : [] },
        deletedAt: null, createdBy: spec.createdBy, updatedBy: spec.createdBy, createdAt: now, updatedAt: now, version: 0,
      };
    }));
    for (const [i, a] of spec.answers.entries()) {
      if (a.draftOnly) continue;
      const fact = facts.get(a.who.membershipId);
      const answers = asks(a.who).filter((x) => a.values[x.kode] !== undefined).map((x) => {
        const value = a.values[x.kode];
        return {
          questionKode: x.kode,
          value: spec.anonymous && x.type === 'downline_areas'
            ? { leaders: (value.leaders as { areas: string[] }[]).map((l) => ({ areas: l.areas })) }
            : value,
        };
      });
      const bands = {
        roleClass: a.who.roleClass,
        tenureBand: fact?.joinDate ? tenureBandOf(wholeYears(fact.joinDate, reference), snapshot.cutoffs.tenureBands) : null,
        ageBand: fact?.dob ? bandOf(wholeYears(fact.dob, reference), snapshot.cutoffs.ageBandUpper) : null,
      };
      await db.collection('surveyResponses').insertOne(spec.anonymous
        ? {
          _id: new mongoose.Types.ObjectId(randomBytes(12).toString('hex')), kpmId: spec.kpmId, runId, membershipId: null,
          submittedAt: null, answers, ...bands, noticeShown: false, deletedAt: null, createdBy: null, updatedBy: null,
        }
        : {
          _id: new mongoose.Types.ObjectId(seedObjectId('surveyResponse', runId, a.who.membershipId)), kpmId: spec.kpmId,
          runId, membershipId: a.who.membershipId, submittedAt: sentAt(i), answers, ...bands,
          noticeShown: snapshot.notice === 'per_person', deletedAt: null, createdBy: a.who.membershipId, updatedBy: a.who.membershipId,
        });
    }
    return runId;
  }

  const nps = (scores: number[], open = '', why: Record<number, string> = {}) => ({
    ...Object.fromEntries(scores.map((score, i) => [`P${i + 1}`, { score, ...(why[i] ? { why: why[i] } : {}) }])),
    ...(open ? { OPEN: { text: open } } : {}),
  });

  const npsPrevious = await run({
    slot: `nps-${prevQuarter}`, kpmId: deps.office0417.kpmId, kind: 'nps', periodKey: prevQuarter,
    opensOn: addDays(pq.first, 31), closesOn: addDays(pq.first, 50), anonymous: true, perPerson: false, remindHalfway: true,
    invited: deps.office0417.everyone, createdBy: p.owner.membershipId,
    answers: [
      { who: p.agus, values: nps([9, 8, 9, 9, 10], 'Lebih banyak sesi joint field work.') },
      { who: p.sari, values: nps([8, 7, 8, 9, 8]) },
      { who: p.rina, values: nps([10, 9, 9, 10, 9], 'Jadwal training diumumkan lebih awal.') },
      { who: p.yosef, values: nps([6, 7, 6, 8, 7], 'Target unit perlu dibahas bersama.') },
      { who: p.winda, values: nps([9, 9, 10, 9, 9]) },
    ],
  });
  const npsOpen = await run({
    slot: `nps-${quarter}`, kpmId: deps.office0417.kpmId, kind: 'nps', periodKey: quarter,
    opensOn: opensNps, closesOn: closesNps, anonymous: true, perPerson: false, remindHalfway: true,
    invited: deps.office0417.everyone, createdBy: p.owner.membershipId,
    answers: [
      { who: p.indah, draftOnly: true, values: { P1: { score: 8, why: 'Timnya solid.' } } },
      { who: p.dimas, values: nps([9, 9, 8, 9, 9], 'Ruang meeting lebih sering tersedia.') },
      { who: p.siti, values: nps([7, 8, 6, 8, 9]) },
      { who: p.rina, values: nps([10, 10, 9, 9, 10], 'Pertahankan coaching mingguan.') },
    ],
  });

  // The coaching mockup's answers (`coaching-survey-results-2026-11-02.html`): Indah, Ika (Arief), Fajar (Yosef).
  const scale = (kodes: string[], values: readonly (number | string)[]) => Object.fromEntries(kodes.map((k, i) => [k, values[i]]));
  const SALES = ['FREQUENCY', 'ACTIVITY', 'PIPELINE', 'APPOINTMENT', 'FACT_FINDING', 'PRESENTATION', 'PRODUCT'];
  const RECRUIT = ['FREQUENCY', 'ACTIVITY', 'PIPELINE', 'FILTERING', 'APPOINTMENT', 'HOT_BUTTON', 'PITCH', 'LICENSING'];
  const ACTIVATION = ['COMPANY_TRAINING', 'KPM_TRAINING', 'KPM_INTRO', 'GOAL_SETTING', 'LEADS_LIST', 'JFW', 'ROLEPLAY'];
  const UNIT = ['ACTIVATION', 'GOALS', 'LEADS', 'ACTIVITY', 'ONE_ON_ONE', 'ROLEPLAY', 'JFW', 'UNIT_MEETING'];
  const K = 'consistent';
  const TK = 'inconsistent';
  const TD = 'not_done';
  const qualJune = await run({
    slot: `qual-${qualKey}`, kpmId: deps.office0417.kpmId, kind: 'qual', periodKey: qualKey,
    opensOn: qb.first, closesOn: qb.last, anonymous: false, perPerson: true, remindHalfway: true,
    invited: [p.indah, p.arief, p.sari, p.yosef], createdBy: p.owner.membershipId,
    downline: new Set([p.yosef.membershipId]),
    answers: [
      { who: p.indah, values: {
        Q4: { chosen: ['TOP'], note: 'Target saya MDRT dalam 2 tahun, tapi butuh bimbingan closing.' },
        Q5: scale(SALES, [3, 4, 2, 3, 4, 5, 3]),
        Q12: { score: 8, reason: 'Leader saya sering mendampingi.' },
      } },
      { who: p.arief, values: {
        Q4: { chosen: ['TEAM'], note: 'Tim saya masih kecil, saya ingin mengembangkannya tahun depan.' },
        Q5: scale(SALES, [4, 3, 3, 4, 4, 4, 5]),
        Q6: scale(RECRUIT, [2, 3, 2, 3, 4, 3, 2, 4]),
        Q7: scale(ACTIVATION, [K, K, K, TK, TK, TD, TK] ),
        Q8: scale(UNIT, [TK, K, TK, K, K, TD, TD, K] ),
        Q9: scale(UNIT, [3, 4, 2, 4, 3, 2, 3, 5]),
        Q12: { score: 6 },
      } },
      { who: p.yosef, values: {
        Q4: { chosen: ['TOP', 'TEAM'], note: 'Ingin fokus ke nasabah jangka panjang dan menjadi top producer.' },
        Q5: scale(SALES, [3, 4, 2, 1, 3, 1, 1]),
        Q6: scale(RECRUIT, [2, 2, 1, 4, 1, 2, 2, 3]),
        Q7: scale(ACTIVATION, [K, TK, K, TK, TK, TK, TD] ),
        Q8: scale(UNIT, [TK, TK, K, K, TD, TD, TK, K] ),
        Q9: scale(UNIT, [3, 5, 3, 3, 5, 2, 2, 5]),
        Q10: { answer: 'yes' },
        Q11: { leaders: [{ membershipId: p.winda.membershipId, areas: ['SALES', 'ACTIVATION', 'UNIT'] }] },
        Q12: { score: 9 },
      } },
    ],
  });
  const qualAnonymous0555 = await run({
    slot: `qual-${qualKey}`, kpmId: deps.office0555.kpmId, kind: 'qual', periodKey: qualKey,
    opensOn: qb.first, closesOn: qb.last, anonymous: true, perPerson: false, remindHalfway: false,
    invited: [deps.office0555.lina], createdBy: deps.office0555.owner.membershipId,
    answers: [{ who: deps.office0555.lina, values: { Q4: { chosen: ['WEIGH'] }, Q5: scale(SALES, [2, 3, 2, 2, 3, 4, 3]), Q12: { score: 7 } } }],
  });

  const halfway = halfwayDay(opensNps, closesNps);
  const guide = `
    indah@kpm0417.test           Survei: the open NPS (${opensNps} – ${closesNps}), 1 of 6 answered — Lainnya's dot
                                 and "Perlu diisi" card, Lanjutkan opens question 2; Home's popup on ${halfway}
                                 (halfway) and ${addDays(closesNps, -1)} (Berakhir besok)
    dimas@, siti@, rina@kpm0417  Sent it: "Terima kasih, survei sudah diisi"; Riwayat lists it
    owner@kpm0417.test           Advanced analytics → NPS: ${quarter} running (3 sent), ${prevQuarter} closed (5);
                                 Kualitatif: ${qualKey}. Coaching → Yosef → Survei: answered, with Winda's areas
    agus@kpm0417.test            Coaching → Indah → Survei: "Penjualan 4"; Arief: the four sections; Sari: not answered
    owner@kpm0555.test           Coaching → Lina → Survei: the run was anonymous, nothing shown
                                 (from src/seed/surveys-fixture.ts)
`;
  return {
    runs: { npsOpen, npsPrevious, qualJune, qualAnonymous0555 },
    periods: { npsOpen: quarter, npsPrevious: prevQuarter, qual: qualKey },
    guide,
  };
}
