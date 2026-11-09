import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { addDays, type LocalDate } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE, mayTickByHand } from '@/domain/constants';
import { inSpan, newHiresYear, type NewHireYear } from '@/domain/metrics/activation-3m';
import type { ActivationItemState } from '@/modules/activation/activation-progress.schema';
import { ActivationProgress, ActivationProgressSchema } from '@/modules/activation/activation-progress.schema';
import { activationFirstYearEndsOn, firstYearOver } from '@/modules/activation/activation-rules';
import { seedObjectId } from './coaching-fixture';
import { markNewHires } from './join-dates';
import { REPORTING_CAST, type ReportingKey } from './reporting-fixture';

/**
 * **The activation cohort, seeded** (Phase 18.1, P18.1-T1; `functional/leader-forum.md`, *Seed*): what the forum's
 * *3M new agent %* (`KPM_Owner.html:2468`) reads — the hires whose activation started in a period, and the office's
 * file over their first four months.
 *
 * **Twelve activations, complete and graduated long ago, for the Agents Phase 18's fixture already placed** under
 * Yosef, Winda and Satria (`reporting-fixture.ts`), **each starting on its hire's join day**, as every activation
 * does (ADR-0102) — nobody is added, and nobody's file changes: their months are the ones Phase 18 wrote. Which
 * account shows what, on a run on 10 October 2026 (the joins count back from the run, so another day moves them):
 *
 * | Signed in as | Sees |
 * |---|---|
 * | `owner@kpm0417.test`, `admin@kpm0417.test` at a meeting's *Overview & Stats* | ***3M new agent %* — FY 2025: 100%**, the nine who started last year (Arini, Bonar, Gilang, Cahya, Damar, Elsa, Oscar, Ikhsan, Jihan) all producing in their first four months — Gilang among them, who left last month and is judged on the months he belonged (the spec's *Noted* 4). **YTD 2026: 33%**, one of three: Pandu producing; Kemal, quiet every month, and Raka, on no file, not. Phase 13's hires (Siti, Indah, Dimas, Wahyu, Novi from July; Budi, Rina in August; Yanti in September) are in the cohort and **left out**, their four months not all held — August's file is empty — and the cell names the months they wait on: August, and November and December, still to come |
 * | `arini@kpm0417.test` and the other eleven | Their own activation, complete: every item done, graduated by themselves on day 71 — **empty from a year after joining** (P19.9-T3 AC-5, OD-289): Arini and Bonar, past it, read *Aktivasi hanya untuk tahun pertama* |
 * | `yosef@kpm0417.test` | ***New hires* by year** (P19.9-T3, ADR-0233): *Tahun berjalan* this year's joiners under him and Winda, *Tahun lalu* last year's — Arini to Elsa, and Gilang who left. Arini and Bonar, past their first year, open **empty**; Cahya, Damar and Elsa, still inside it, open their completed checklist. Which names fall in which year moves with the run's day; the seed's guide prints them |
 *
 * **No walk already reviewed moves**: a graduated activation is on no *New hires* roster (`openOf`), in no leader's
 * nav, and nothing of the coaching roster or the Unit Dashboard reads one; none of the twelve is in Agus's, Sari's,
 * Arief's or Dewi's downline, and the Owner, who leads Yosef and Satria, reaches no open activation through them.
 * What does change: each hire's own *Activation* page and nav, and the activation tab of a coachee page opened on one
 * of them, which show the completed activation.
 *
 * **Derived ids, written once**: each activation and its graduation's audit row carry an `_id` from `seedObjectId`,
 * and a membership that already has an activation is left as it is — so a re-run writes nothing.
 */

/** The reporting cast's Agents: everybody Phase 18 placed at the Agent rung, the leaver included. */
export const COHORT_HIRES: readonly ReportingKey[] = [
  'arini', 'bonar', 'cahya', 'damar', 'elsa', 'ikhsan', 'jihan', 'kemal', 'oscar', 'pandu', 'raka', 'gilang',
];

/** The day each hire graduated, counted from their start: inside the 90 days, by their own *Mark activation complete →*. */
const GRADUATED_ON_DAY = 71;

export interface CohortSeedDeps {
  clock: Clock;
  /** Office 0417. */
  kpmId: string;
  /** `placeReportingCast`'s answer: each hire's membership. */
  cast: Readonly<Record<ReportingKey, { id: string }>>;
}

export interface CohortSeed {
  /** Rows this run wrote; 0 on a re-run. */
  written: number;
  /** Each hire's start, by key: their join day in the office's calendar. */
  starts: Partial<Record<ReportingKey, LocalDate>>;
  guide: string;
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);

/**
 * **Seed the cohort.** Called by `demo.ts` once the reporting fixture has placed its cast and written its files, and
 * after the activation fixture — whose rows it does not touch. Each activation is pinned to 0417's published checklist,
 * every item done (a linked item by its link, the rest by the hire), validated by `activationProgress`' own schema.
 */
export async function seedActivationCohort(deps: CohortSeedDeps): Promise<CohortSeed> {
  const { clock, kpmId } = deps;
  const db = mongoose.connection.db!;
  const tz = DEFAULT_TENANT_TIMEZONE;
  const now = clock.now();
  /** 10:00 office time on a day. */
  const at = (day: LocalDate) => new Date(clock.startOfLocalDay(tz, day).getTime() + 10 * 3_600_000);

  const checklist = await db.collection('activationTemplates')
    .find({ kpmId, status: 'published', deletedAt: null }).sort({ version: -1 }).limit(1).next();
  if (!checklist) throw new Error(`KPM ${kpmId} has no published activation checklist to pin the cohort to`);
  const items = (checklist.aspects as { items: { code: string; autoLink?: string | null }[] }[]).flatMap((a) => a.items);
  const Rows = mongoose.model(ActivationProgress.name, ActivationProgressSchema, undefined, { overwriteModels: true });

  let written = 0;
  const starts: Partial<Record<ReportingKey, LocalDate>> = {};
  for (const key of COHORT_HIRES) {
    const membershipId = deps.cast[key].id;
    const member = await db.collection('memberships').findOne({ _id: oid(membershipId) });
    if (!member?.joinedAt) continue;
    const startDate = clock.localDateFor(tz, member.joinedAt as Date);
    starts[key] = startDate;
    const graduatedAt = at(addDays(startDate, GRADUATED_ON_DAY - 1));
    if (graduatedAt > now) continue;
    // A membership with an activation of any kind keeps it: one per membership, and a walk's is never written over.
    if (await db.collection('activationProgress').findOne({ kpmId, membershipId, deletedAt: null })) continue;

    const _id = oid(seedObjectId('cohort-fixture', 'activation', kpmId, membershipId));
    const done = items.map((item, i): ActivationItemState => ({
      code: item.code, done: true, doneAt: at(addDays(startDate, 1 + i * 4)),
      source: mayTickByHand(item.autoLink ?? null) ? 'hire' : 'link', doneByMembershipId: membershipId,
      recordCollection: null, recordId: null, note: null, date: null,
    }));
    const doc = new Rows({
      _id, kpmId, membershipId, templateId: String(checklist._id), templateVersion: checklist.version as number,
      startDate, startCorrectedAt: null, startCorrectedByMembershipId: null,
      // They joined before Phase 13, as the activation fixture's hires did.
      origin: 'backfill', items: done, note: null, graduatedAt, graduatedByMembershipId: membershipId,
      version: 1 + done.length + 1, deletedAt: null, createdBy: null, updatedBy: membershipId,
    }, null, { strict: 'throw' });
    await doc.validate();
    await Rows.collection.insertOne({ ...doc.toObject(), _id, createdAt: at(startDate), updatedAt: graduatedAt });
    // The graduation's audit row, as the hire's own *Mark activation complete →* leaves it.
    await db.collection('auditLog').insertOne({
      _id: oid(seedObjectId('cohort-fixture', 'audit', kpmId, membershipId)), kpmId,
      actorUserId: String(member.userId), effectiveUserId: null, actorMembershipId: membershipId, onBehalfOf: false,
      action: 'activation.graduated', targetCollection: 'activationProgress', targetId: String(_id), targetMembershipId: membershipId,
      before: null, after: null, createdAt: graduatedAt, updatedAt: graduatedAt,
    });
    written += 2;
  }

  // ADR-0169: each of the twelve with an activation is a new hire, joined on its start — written or found, so a re-run
  // gives the same answer. Their join dates are long past; `/new-hires` shows a year of them (ADR-0173).
  await markNewHires(COHORT_HIRES.map((key) => deps.cast[key].id));

  const today = clock.localDateFor(tz, now);
  const lastYear = String(Number(today.slice(0, 4)) - 1);
  const startedLastYear = COHORT_HIRES.filter((key) => starts[key]?.startsWith(lastYear)).length;
  // P19.9-T3 (ADR-0233): Yosef's New Hires by year — his own Agents and Winda's — and who is past their first year.
  const yosefs = REPORTING_CAST.filter((m) => COHORT_HIRES.includes(m.key) && (m.leader === 'yosef' || m.leader === 'winda'));
  const named = (year: NewHireYear) => yosefs
    .filter((m) => inSpan(starts[m.key], newHiresYear(today, year)))
    .map((m) => `${m.fullName.split(' ')[0]}${firstYearOver(today, activationFirstYearEndsOn(tz, starts[m.key]!)) ? ' (empty)' : ''}`)
    .join(', ') || 'nobody';
  const guide = `
  COHORT for the forum's 3M new agent %  (from src/seed/cohort-fixture.ts)
    owner@kpm0417.test           Overview & Stats › 3M new agent %: ${COHORT_HIRES.length} activations, graduated long
    admin@kpm0417.test           ago, for Yosef's, Winda's and Satria's Agents, each from its join day —
                                 ${startedLastYear} started in FY ${lastYear}, the rest this year. Kemal (quiet every month)
                                 and Raka (on no file) are the two not producing; Gilang left last month and
                                 counts on the months he belonged. Phase 13's hires (July on) are left out:
                                 August's file is empty, so their four months are not all held
  NEW HIRES by year  (P19.9-T3, ADR-0233)
    yosef@kpm0417.test           /new-hires Tahun berjalan: ${named('current')}
                                 Tahun lalu: ${named('previous')}
                                 (empty) = past the first year: the activation opens with one line, no checklist
    arini@kpm0417.test           /activation: past her first year, the one line and no checklist
`;
  return { written, starts, guide };
}
