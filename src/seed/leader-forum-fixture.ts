import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { Clock, FixedClock } from '@/common/clock/clock.port';
import { readerIn } from '@/common/i18n/reader';
import { formatDayMonth } from '@/common/format/format';
import { addDays } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE, LEADER_MEETING_SHARE_DAYS, TIME } from '@/domain/constants';
import { rateCellOf, RATE_ROWS } from '@/migrations/0043-leader-meeting-target-rates';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { firstAgendaTexts, preparePerformanceData } from '@/modules/leader-meetings/leader-meeting-agenda';
import { MONTH_NAMES } from '@/modules/leader-meetings/leader-meetings.messages';
import type {
  ActionStatus, AgendaSection, FrozenEditor, LeaderMeetingActionItem, LeaderMeetingAgendaItem, MonthlyTargetCell,
  TextTargetCell,
} from '@/modules/leader-meetings/leader-meeting.schema';
import { LeaderScorecardService } from '@/modules/leader-meetings/scorecard/scorecard.service';
import { ROW_UNITS, type ComputedScorecard, type ScorecardCell } from '@/modules/leader-meetings/scorecard/scorecard.types';
import { DataUploadBatch, DataUploadBatchSchema } from '@/modules/production/data-upload-batch.schema';
import { DataUploadBatchRepository } from '@/modules/production/data-upload-batch.repository';
import { MemberNames } from '@/modules/org/member-names.service';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { MonthlyAgentData, MonthlyAgentDataSchema } from '@/modules/production/monthly-agent-data.schema';
import { MonthlyAgentDataRepository } from '@/modules/production/monthly-agent-data.repository';
import { ProductionReadings } from '@/modules/production/production-readings';
import { OfficePeople } from '@/modules/reporting/office-people';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { seedObjectId } from './coaching-fixture';

/**
 * **The Strategic Leader Forum, seeded** (Phase 18.1, P18.1-T2 AC-10, P18.1-T3, P18.1-T4 AC-1;
 * `functional/leader-forum.md`, *Seed*). Phase 18's fixture is in place by then — 0417's two new AB agencies, Yosef
 * tagged *Core Leader* beside Agus and Sari, the production history from January last year — and the activation
 * cohort (`cohort-fixture.ts`), which a frozen scorecard reads. Dates count from the run's today in Jakarta. Which
 * account shows what:
 *
 * | Signed in as | Sees |
 * |---|---|
 * | `owner@kpm0417.test` (Wilson Tanoto), `admin@kpm0417.test` (Maya Halim) | **Three meetings, newest first.** **#14**, in three days: *Upcoming*, its scorecard live — the reference slide's table (P18.9-T1): *Full Year* and *YTD* of last year full, a file for every month of it (`reporting-fixture.ts`), so no *(\*)* note on them; *AS OF* yesterday's upload; *# of units 7* — the 5 ABs and 4 AABs who lead somebody (P19.3-T1, ADR-0203 §1; it read 9 before); the prototype's ten agenda items as an Indonesian reader is given them, *"Siapkan data kinerja {this month}"* (P18.9-T2, P18.10-T5 AC-6); the prototype's four rows (`KPM_Owner.html:2516-2521`), **their remarks dated from the meeting** (*"Dijadwalkan {a week after it}"*), all of their words in Bahasa Indonesia (P18.10-T7) — *"4 open items"*; ***Monthly Target* as rates** — the prototype's typed targets as migration `0043` reads them: *FLC* 1 and *Avg. monthly AA* 3 per unit, so *"9 (1 @ unit)"* and *"27 (3 @ unit)"*; *APE* *TBD*, *Manpower* and *Case submission* blank; *New AA*'s *TBD* kept, not drawn; its editors live — the Owner, Maya Halim, Agus, Sari and Yosef, *"3 core leaders tagged"*. **#13**, two weeks ago: *Completed*, **frozen** the morning after its day, its editors as they were — the Owner, Maya Halim, Agus and Sari, *"2 core leaders tagged"* (Yosef tagged since); the prototype's agenda for it (`:2527-2539`) and its three rows — *Not yet planned*, *Planned* (`:2517`), *Implemented*; **a live link the Owner made two days ago**. **#12**, four weeks ago: *Completed*, *All clear* (`:2563`), **frozen in the shape before the reference slide** (P18.9-T1 AC-19): five columns, *New AA*, *# of units* the AB agencies it froze with, no *AS OF* — so its *YTD* of last year, *Cases/producing agents* and *AS OF* read *—*, and its targets are that count × the rate; **one link made on its day, expired since**. Every write, *+ New meeting* (*#15*), moving #14, *Share* and *Stop sharing*, *Save as PDF* |
 * | `agus@kpm0417.test`, `sari@kpm0417.test` — Core Leaders | The list and #14 by the address, in the field shell, editing; #13 by its link, read-only; no *+ New meeting*, no date control, no *Manage tags →* |
 * | `yosef@kpm0417.test` | On #14's live editors, not on #13's frozen ones |
 * | `rina@kpm0417.test` — an Agent, not tagged | `/leader-meetings` and #14's address: *not found*. #13's link: the meeting read-only. #12's link: *"This link doesn't open anything."* |
 * | `owner@kpm0555.test` | 0555's own meeting, one (*Upcoming*, in five days); 0417's #14 address and #13's link: *not found* |
 * | `owner@kpm0701.test` (Hadi Gunawan) | *"No meetings yet."* |
 * | `superadmin@agencyboost.test` | A read-only support session into 0417's Owner: the list and the three meetings, no write control |
 *
 * **The links' tokens are derived** from fixed words, like every `_id` here (`seedObjectId`), so they are the same on
 * every fresh seed and only their hashes are stored. Open them signed in to 0417:
 *
 * | Link | Token | Opens |
 * |---|---|---|
 * | #13's, made two days ago | `PaQz5IcHtTT6wsTi9xSqra50nogm5Pl9BB5tMqXN3eM` | for twelve more days |
 * | #12's, made on its day | `dF7s9Ng9KfYHe_GXpMOWI4KEba1nzM-ogv-SMguW8gU` | nothing: it expired two weeks ago |
 *
 * **#12's and #13's scorecards are frozen by the function a read runs** (`LeaderScorecardService.compute`), with the
 * clock at the morning after each meeting's day, over the records as they stand at the seed — a seed has no older
 * history to read — so a frozen scorecard and one a first read would write are one computation. **Derived ids,
 * written once until `--reset`**: a meeting, a link or an audit row already there is left as it is, so a re-run
 * writes nothing and a walk's own writes are kept.
 */

/** The token a seeded link is opened with: fixed words, hashed, so it is the same on every fresh seed. */
export function seedShareToken(office: string, slot: string): string {
  return createHash('sha256').update(`leader-forum-fixture|token|${office}|${slot}`).digest('base64url');
}

/** #13's live link, and #12's expired one. */
export const FORUM_TOKENS = { live13: seedShareToken('0417', '13-live'), expired12: seedShareToken('0417', '12-expired') } as const;

/** *Monthly Target* as the prototype types it (`:2462-2471`): *Manpower* left empty, never typed. */
const PROTOTYPE_TARGETS: Record<string, string> = {
  ape: 'TBD', flc: '8 (1 @ unit)', new_aa: 'TBD', avg_monthly_aa: '22 (3 @ unit)', case_submission: 'TBD',
};

/**
 * **The prototype's targets as a database holds them since 2026-10-28** (P18.9-T1 AC-11, AC-20): each read by
 * migration `0043`'s own reading (`rateCellOf`) — *"8 (1 @ unit)"* the rate 1, *TBD* none — and *New AA*'s left as typed,
 * kept and not drawn (AC-6). So a fresh seed and a migrated one hold the same cells.
 */
function migratedTargets(typed: Record<string, string>): Record<string, MonthlyTargetCell | TextTargetCell> {
  return Object.fromEntries(Object.entries(typed).map(([row, value]) => [
    row, (RATE_ROWS as readonly string[]).includes(row) ? rateCellOf(row, value, 1).cell : { value, version: 1 },
  ]));
}

type Row = [initiative: string, metric: string, action: string, pic: string, status: ActionStatus, remarks: string];

/**
 * **The meetings' words are the office's, in Bahasa Indonesia** (P18.10-T7, OD-238): what the Owner and the leaders
 * typed, and the first agenda as the service writes it for a reader in Indonesian (P18.10-T5 AC-6). Every meeting is
 * keyed by its derived `_id`, so a database seeded before keeps its English and gets no second meeting.
 */
const INDONESIAN = readerIn('id');

/** The words the rows' remarks are built from, for the seed's spec. */
export const FORUM_REMARKS = {
  scheduled: (day: string) => `Dijadwalkan ${day}`,
  done: (day: string) => `Selesai ${day}`,
} as const;

/** The month before a meeting's month, as an Indonesian office writes it: *September* for a meeting in October. */
const bulanSebelum = (meetingDate: string) => MONTH_NAMES.id[(Number(meetingDate.slice(5, 7)) + 10) % 12];

/**
 * #14's four rows (`:2516-2521`), in Bahasa Indonesia since P18.10-T7, the first's remark **dated from the meeting's own day** — a week on
 * — where the prototype's *"Scheduled for 2 Sept"* stood still while the meetings moved (P18.9-T2 AC-4, UI-015).
 */
const rows14 = (date: string): readonly Row[] => [
  ['Adopsi Activity Tracking Tool', 'Adopsi 80% (saat ini 63%)', 'Sosialisasi Activity Tracking Tool di sesi LWS', 'Amelia', 'planned', FORUM_REMARKS.scheduled(formatDayMonth(addDays(date, 7)))],
  ['Adopsi Activity Tracking Tool', 'Adopsi 80% (saat ini 63%)', 'Cari kisah sukses untuk rapat leader', 'Amelia', 'planned', 'TBD'],
  ['Playbook Leads Generation', '# prospek baru', 'Masukkan ke onboarding recruitment', 'Ferry / Joy', 'not_planned', 'TBD'],
  ['Playbook Team Management', '# 1-on-1', 'Masukkan ke materi pelatihan leader', 'Hellen', 'not_planned', 'TBD'],
];

/** #13's: the prototype's two (`:2545-2546`) and one *Planned* row (`:2517`) — *Not yet planned*, *Planned*, *Implemented*. */
const rows13 = (date: string): readonly Row[] => [
  ['Playbook Recruitment', '# FLC / NPA', 'Masukkan ke materi pelatihan mingguan', 'TBD', 'not_planned', 'TBD'],
  rows14(date)[0],
  ['Strategic Leader Forum', '100% terlaksana, 6 bulan ke depan', 'Pantau metrik produksi dua minggu sekali', 'TBD', 'implemented', 'Berjalan'],
];

/** #12's one row (`:2563`), implemented: *All clear*. Done the week before its day, where the prototype said *"Done Aug 20"*. */
const rows12 = (date: string): readonly Row[] => [
  ['Playbook Team Management', '# 1-on-1', 'Susun kerangka playbook', 'Hellen', 'implemented', FORUM_REMARKS.done(formatDayMonth(addDays(date, -7)))],
];

type Agenda = Record<AgendaSection, [text: string, pic: string, done: boolean][]>;

/**
 * #13's agenda (`:2527-2539`), in Bahasa Indonesia: the follow-ups the previous session's, the month before; *"Siapkan data
 * kinerja {month}"* its own month since P18.9-T2 (AC-4, ADR-0176 §11). Boxes on *During* alone.
 */
const agenda13 = (date: string): Agenda => {
  const month = bulanSebelum(date);
  return {
    preparation: [[`Kumpulkan follow-up dari sesi ${month}`, 'Wilson', false], [preparePerformanceData(date, INDONESIAN), 'Wilson', false]],
    during: [
      [`Pembaruan proses — follow-up ${month} sudah ditinjau`, '', true], ['Tinjauan kinerja terhadap ambang batas', '', true],
      ['Prioritas strategis (Agency) — fokus recruitment', '', true], ['Langkah berikutnya dirangkum, penanggung jawab ditetapkan', '', true],
    ],
    post: [['Hasil dicatat ke dalam template', 'Wilson', false], ['Follow-up dari sisi HO Prudential sudah dijalankan', '', false]],
  };
};

/** #12's agenda (`:2555-2560`). */
const AGENDA_12: Agenda = {
  preparation: [['Kumpulkan follow-up dari sesi sebelumnya', 'Wilson', false]],
  during: [['Tinjauan kinerja terhadap ambang batas', '', true], ['Prioritas strategis (Korporat)', '', true]],
  post: [['Hasil dicatat ke dalam template', 'Wilson', false]],
};

/** The prototype's ten, PICs empty, as an office's first meeting starts (ADR-0130 §3). */
const tenItems = (date: string): Agenda => {
  const texts = firstAgendaTexts(date, INDONESIAN);
  const of = (list: string[]) => list.map((text): [string, string, boolean] => [text, '', false]);
  return { preparation: of(texts.preparation), during: of(texts.during), post: of(texts.post) };
};

export interface LeaderForumFixtureDeps {
  clock: Clock;
  '0417': {
    kpmId: string;
    owner: { membershipId: string; userId: string };
    admin: { membershipId: string };
    agus: { membershipId: string };
    sari: { membershipId: string };
  };
  '0555': { kpmId: string; owner: { membershipId: string; userId: string } };
}

export interface LeaderForumFixture {
  /** Rows this run wrote; 0 on a re-run. */
  written: number;
  /** The seeded meetings' ids, by office and number, for a spec. */
  meetings: { '0417': Record<12 | 13 | 14, string>; '0555': string };
  guide: string;
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);
const RECOMPILE = { overwriteModels: true } as const;

/**
 * **The scorecard, as a first read would freeze it**: `LeaderScorecardService` wired by hand over the collections, as
 * `coaching-snapshots.ts` wires finalize's builder — the seed is a script, not the application. Nothing it reads
 * writes anything.
 */
function scorecardService(clock: Clock): LeaderScorecardService {
  const model = (name: string, schema: mongoose.Schema): never => mongoose.model(name, schema, undefined, RECOMPILE) as never;
  const kpms = model(Kpm.name, KpmSchema);
  const companies = model(Company.name, CompanySchema);
  const memberships = new MembershipRepository(model(Membership.name, MembershipSchema));
  const audit = new AuditService(model(AuditLog.name, AuditLogSchema));
  const orgLevels = new OrgLevelService(model(CompanyOrgLevel.name, CompanyOrgLevelSchema), companies, kpms, audit, clock);
  const people = new OfficePeople(memberships, new MemberNames(memberships, model(User.name, UserSchema)), kpms, companies, orgLevels, clock);
  const monthRows = new MonthlyAgentDataRepository(model(MonthlyAgentData.name, MonthlyAgentDataSchema));
  const batches = new DataUploadBatchRepository(model(DataUploadBatch.name, DataUploadBatchSchema));
  return new LeaderScorecardService(people, new ProductionReadings(monthRows), monthRows, memberships, clock, batches);
}

/** The columns and rows a scorecard frozen before 2026-10-28 has (ADR-0129 §1, §2, before ADR-0175). */
const COLUMNS_BEFORE_THE_SLIDE = ['fy', 'ytd', 'thisMonthLastYear', 'lastMonth', 'thisMonth'] as const;
const ROWS_BEFORE_THE_SLIDE = [
  'ape', 'manpower', 'flc', 'producing_agents', 'new_aa', 'new_agent_3m', 'avg_monthly_aa', 'case_submission', 'average_case_size',
] as const;

const shiftMonth = (month: string, by: number) => {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1 + by, 1));
  return d.toISOString().slice(0, 7);
};

/**
 * **A scorecard in the shape it was frozen in before 2026-10-28** (P18.9-T1 AC-19, AC-20) — what #12 keeps, so the
 * tolerant read can be walked on a fresh seed: the five columns, *FY* and *YTD* named by their years, nine rows with
 * *Producing agents* and ***New AA (avg. monthly)***, the chips with ***# of units* the AB agencies** (D-units, so equal
 * to *# of AB*), and **no *AS OF***. Every figure is the one the scorecard computes over the same records — the cells
 * are `compute`'s own — but *New AA*'s, which nothing computes any more: written here as the retired
 * `NEW_ACTIVE_AGENTS_MONTHLY_AVG` read them (`metrics-and-definitions.md` §A.12, struck) — the file's `NEW_ACTIVE_AGENTS`
 * over the office, each month held, averaged over a year's months — the seed being the one place that still needs it.
 */
async function frozenBeforeTheSlide(
  card: ComputedScorecard, kpmId: string, meetingDate: string, frozenOn: string,
): Promise<Record<string, unknown>> {
  const db = mongoose.connection.db!;
  const month = meetingDate.slice(0, 7);
  const lastYear = String(Number(meetingDate.slice(0, 4)) - 1);
  const sums = new Map((await db.collection('monthlyAgentData').aggregate([
    { $match: { kpmId, deletedAt: null, month: { $gte: `${lastYear}-01`, $lte: month }, 'values.NEW_ACTIVE_AGENTS.value': { $ne: null } } },
    { $group: { _id: '$month', value: { $sum: '$values.NEW_ACTIVE_AGENTS.value' } } },
  ]).toArray()).map((row) => [String(row._id), row.value as number]));
  const monthsOf = (from: string, to: string) => {
    const months: string[] = [];
    for (let m = from; m <= to; m = shiftMonth(m, 1)) months.push(m);
    return months;
  };
  const current = frozenOn.slice(0, 7);
  const newAa = (months: string[]): ScorecardCell => {
    const held = months.filter((m) => sums.has(m));
    if (held.length === 0) return { kind: 'pending' };
    const value = held.reduce((n, m) => n + sums.get(m)!, 0) / held.length;
    return { kind: 'figure', value, leavesOut: months.filter((m) => !sums.has(m) && m !== current) };
  };
  const newAaCells = {
    fy: newAa(monthsOf(`${lastYear}-01`, `${lastYear}-12`)),
    ytd: newAa(monthsOf(`${month.slice(0, 4)}-01`, month)),
    thisMonthLastYear: newAa([shiftMonth(month, -12)]),
    lastMonth: newAa([shiftMonth(month, -1)]),
    thisMonth: newAa([month]),
  };
  const pick = (cells: Record<string, ScorecardCell>) => Object.fromEntries(COLUMNS_BEFORE_THE_SLIDE.map((c) => [c, cells[c]]));
  return {
    periods: {
      fy: lastYear, ytd: month.slice(0, 4), thisMonthLastYear: shiftMonth(month, -12), lastMonth: shiftMonth(month, -1), thisMonth: month,
    },
    chips: { ...card.chips, units: card.chips.ab },
    rows: ROWS_BEFORE_THE_SLIDE.map((key) => (key === 'new_aa'
      ? { key, unit: 'count', cells: newAaCells }
      : { key, unit: ROW_UNITS[key], cells: pick(card.rows.find((r) => r.key === key)!.cells) })),
  };
}

export async function seedLeaderForumFixture(deps: LeaderForumFixtureDeps): Promise<LeaderForumFixture> {
  const db = mongoose.connection.db!;
  const tz = DEFAULT_TENANT_TIMEZONE;
  const today = deps.clock.localDateFor(tz);
  const at = (day: string, hour: number) => new Date(deps.clock.startOfLocalDay(tz, day).getTime() + hour * 3_600_000);
  const freezeClock = new FixedClock(deps.clock.now());
  const scorecards = scorecardService(freezeClock);
  const a = deps['0417'];
  let written = 0;

  const audit = async (
    kpmId: string, actor: { membershipId: string; userId: string }, action: string, targetCollection: string, targetId: string,
    after: Record<string, unknown>, when: Date,
  ) => {
    await db.collection('auditLog').insertOne({
      _id: oid(seedObjectId('leader-forum-fixture', 'audit', kpmId, action, targetId)), kpmId, action, targetCollection, targetId,
      actorUserId: actor.userId, effectiveUserId: null, actorMembershipId: actor.membershipId, onBehalfOf: false,
      before: null, after, createdAt: when, updatedAt: when,
    });
    written += 1;
  };

  /** The editors as they stand now, as the freeze writes them: the Owner, the Admin, Agus and Sari — not Yosef. */
  const editorsBeforeYosef = async (): Promise<FrozenEditor[]> => {
    const ids = [a.owner.membershipId, a.admin.membershipId, a.agus.membershipId, a.sari.membershipId];
    const rows = await db.collection('memberships').find({ _id: { $in: ids.map(oid) }, kpmId: a.kpmId }).toArray();
    const of = (id: string) => rows.find((r) => String(r._id) === id)!;
    const as: FrozenEditor['as'][] = ['owner', 'admin', 'core_leader', 'core_leader'];
    return ids.map((id, i) => ({
      membershipId: id, as: as[i], rungCode: of(id).orgLevelCode as string, tagged: i >= 2 || of(id).isCoreLeader === true,
    }));
  };

  const meeting = async (spec: {
    kpmId: string; actor: { membershipId: string; userId: string }; number: number; date: string; createdOn: string;
    agenda: Agenda; rows: readonly Row[]; targets: Record<string, string>; writtenAt: Date | null; freeze: boolean;
    /** Frozen in the shape scorecards had before the reference slide (P18.9-T1 AC-19): #12's. */
    frozenBeforeTheSlide?: true;
  }): Promise<string> => {
    const key = (...parts: string[]) => seedObjectId('leader-forum-fixture', spec.kpmId, String(spec.number), ...parts);
    const id = key('meeting');
    if (await db.collection('leaderMeetings').findOne({ _id: oid(id) })) return id;
    const createdAt = at(spec.createdOn, 9);
    const item = (section: string, n: number, [text, pic, done]: [string, string, boolean]): LeaderMeetingAgendaItem =>
      ({ itemId: key('agenda', section, String(n)), text, pic, done, version: 1 });
    const agenda = Object.fromEntries((Object.keys(spec.agenda) as AgendaSection[])
      .map((section) => [section, spec.agenda[section].map((entry, n) => item(section, n, entry))]));
    const actionItems = spec.rows.map(([initiative, metric, action, pic, status, remarks], n): LeaderMeetingActionItem => ({
      itemId: key('row', String(n)), initiative, metric, action, pic, status, remarks, order: n, version: 1,
    }));
    const monthlyTargets = migratedTargets(spec.targets);
    let frozen: Record<string, unknown> = { frozenScorecard: null, frozenAt: null, frozenCoeditors: null };
    if (spec.freeze) {
      // The first read: the morning after its day, by the Owner.
      const frozenAt = at(addDays(spec.date, 1), 9);
      freezeClock.set(frozenAt);
      const computed = await scorecards.compute({ kpmId: spec.kpmId, timezone: tz, meetingDate: spec.date });
      const frozenScorecard = spec.frozenBeforeTheSlide
        ? await frozenBeforeTheSlide(computed, spec.kpmId, spec.date, addDays(spec.date, 1))
        : computed;
      const frozenCoeditors = await editorsBeforeYosef();
      frozen = { frozenScorecard, frozenAt, frozenCoeditors };
      await audit(spec.kpmId, spec.actor, 'leader_meeting.frozen', 'leaderMeetings', id, {
        frozenAt: frozenAt.toISOString(), editors: frozenCoeditors.map((e) => e.membershipId),
      }, frozenAt);
    }
    await db.collection('leaderMeetings').insertOne({
      _id: oid(id), kpmId: spec.kpmId, number: spec.number, title: `Strategic Check-in — #${spec.number}`, date: spec.date,
      agenda, actionItems, monthlyTargets, writtenAt: spec.writtenAt, ...frozen, version: 1, deletedAt: null,
      createdBy: spec.actor.membershipId, updatedBy: spec.actor.membershipId, createdAt, updatedAt: spec.writtenAt ?? createdAt, __v: 0,
    });
    await audit(spec.kpmId, spec.actor, 'leader_meeting.created', 'leaderMeetings', id, {
      title: `Strategic Check-in — #${spec.number}`, date: spec.date, number: spec.number,
    }, createdAt);
    written += 1;
    return id;
  };

  const link = async (kpmId: string, meetingId: string, slot: string, token: string, madeAt: Date) => {
    const id = seedObjectId('leader-forum-fixture', 'link', kpmId, slot);
    if (await db.collection('leaderMeetingShareLinks').findOne({ _id: oid(id) })) return;
    const expiresAt = new Date(madeAt.getTime() + LEADER_MEETING_SHARE_DAYS * TIME.MS_PER_DAY);
    await db.collection('leaderMeetingShareLinks').insertOne({
      _id: oid(id), kpmId, meetingId, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt,
      revokedAt: null, revokedBy: null, deletedAt: null, createdBy: a.owner.membershipId, updatedBy: a.owner.membershipId,
      createdAt: madeAt, updatedAt: madeAt, version: 0,
    });
    await audit(kpmId, a.owner, 'leader_meeting_share_link.created', 'leaderMeetingShareLinks', id, {
      meetingId, expiresAt: expiresAt.toISOString(),
    }, madeAt);
    written += 1;
  };

  // ---- 0417: #12 four weeks ago, #13 two weeks ago, #14 in three days.
  const date12 = addDays(today, -28);
  const date13 = addDays(today, -14);
  const date14 = addDays(today, 3);
  const m12 = await meeting({
    kpmId: a.kpmId, actor: a.owner, number: 12, date: date12, createdOn: addDays(date12, -4), agenda: AGENDA_12, rows: rows12(date12),
    targets: PROTOTYPE_TARGETS, writtenAt: at(date12, 11), freeze: true, frozenBeforeTheSlide: true,
  });
  const m13 = await meeting({
    kpmId: a.kpmId, actor: a.owner, number: 13, date: date13, createdOn: addDays(date13, -4), agenda: agenda13(date13), rows: rows13(date13),
    targets: PROTOTYPE_TARGETS, writtenAt: at(date13, 11), freeze: true,
  });
  const m14 = await meeting({
    kpmId: a.kpmId, actor: a.owner, number: 14, date: date14, createdOn: addDays(today, -4), agenda: tenItems(date14), rows: rows14(date14),
    targets: PROTOTYPE_TARGETS, writtenAt: at(addDays(today, -1), 15), freeze: false,
  });
  await link(a.kpmId, m12, '12-expired', FORUM_TOKENS.expired12, at(date12, 12));
  const madeLive = at(addDays(today, -2), 10);
  await link(a.kpmId, m13, '13-live', FORUM_TOKENS.live13, madeLive);

  // ---- 0555: one meeting of its own, upcoming, nobody has written in it. 0701 has none.
  const b = deps['0555'];
  const date0555 = addDays(today, 5);
  const m0555 = await meeting({
    kpmId: b.kpmId, actor: b.owner, number: 1, date: date0555, createdOn: addDays(today, -1), agenda: tenItems(date0555), rows: [],
    targets: {}, writtenAt: null, freeze: false,
  });

  const liveUntil = addDays(deps.clock.localDateFor(tz, madeLive), LEADER_MEETING_SHARE_DAYS);
  // The guide's figures as the walk reads them today: #14's units now, #12's as it froze with them.
  freezeClock.set(deps.clock.now());
  const units14 = await scorecards.units({ kpmId: a.kpmId, timezone: tz, meetingDate: date14 });
  const kept12 = await db.collection('leaderMeetings').findOne({ _id: oid(m12) });
  const units12 = (kept12?.frozenScorecard as { chips?: { units?: number } } | null)?.chips?.units ?? 0;
  const guide = `
  FORUM at /leader-meetings  (from src/seed/leader-forum-fixture.ts)
    owner@kpm0417.test           Three meetings, newest first. #14 on ${date14}, Upcoming: the scorecard live,
    admin@kpm0417.test           as the reference slide: Full Year and YTD of last year full (no (*) note on
                                 them), AS OF the day of the latest upload, # of units ${units14} (the AB and AAB who lead somebody);
                                 Monthly Target as rates — FLC "${units14} (1 @ unit)", Avg. monthly AA
                                 "${3 * units14} (3 @ unit)", APE TBD, the rest blank; the ten agenda items ("${preparePerformanceData(date14, INDONESIAN)}"),
                                 four open items, "${FORUM_REMARKS.scheduled(formatDayMonth(addDays(date14, 7)))}",
                                 "3 core leaders tagged". On a phone, one card per metric; on a tablet, Metrics
                                 stays in view.
                                 #13 on ${date13}, Completed and frozen: its editors the Owner, Maya, Agus and
                                 Sari ("2 core leaders tagged"); Not yet planned, Planned, Implemented; a live
                                 link. #12 on ${date12}, Completed, All clear, frozen in the old shape: its YTD
                                 of last year, Cases/producing agents and AS OF read "—", # of units the
                                 ${units12} AB agencies it froze with, FLC's target "${units12} (1 @ unit)"; its
                                 link expired.
                                 + New meeting makes #15, its month item re-dated; Share, Stop sharing,
                                 Save as PDF (landscape, the same table)
    agus@kpm0417.test            Core Leaders, in the field shell: the list and #14 by the address, editing;
    sari@kpm0417.test            #13 by its link, read-only; no + New meeting, no date control
    yosef@kpm0417.test           tagged since #13: on #14's editors, not on #13's
    rina@kpm0417.test            not tagged: /leader-meetings and #14's address not found; #13's link
                                 read-only; #12's link "This link doesn't open anything."
    owner@kpm0555.test           0555's own meeting, #1 on ${date0555}; 0417's #14 and #13's link not found
    owner@kpm0701.test           Hadi Gunawan: "No meetings yet."
    superadmin@agencyboost.test  a read-only support session into 0417's Owner: the list and the three
                                 meetings, no write control
    Links, opened signed in to 0417:
      #13's, live until ${liveUntil}   /leader-meetings/shared/${FORUM_TOKENS.live13}
      #12's, expired               /leader-meetings/shared/${FORUM_TOKENS.expired12}
`;

  return { written, meetings: { '0417': { 12: m12, 13: m13, 14: m14 }, '0555': m0555 }, guide };
}
