import { createHash } from 'node:crypto';
import mongoose from 'mongoose';
import { Clock, FixedClock } from '@/common/clock/clock.port';
import { addDays } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE, LEADER_MEETING_SHARE_DAYS, TIME } from '@/domain/constants';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { firstAgendaTexts, monthBefore } from '@/modules/leader-meetings/leader-meeting-agenda';
import type {
  ActionStatus, AgendaSection, FrozenEditor, LeaderMeetingActionItem, LeaderMeetingAgendaItem, MonthlyTargetCell,
} from '@/modules/leader-meetings/leader-meeting.schema';
import { LeaderScorecardService } from '@/modules/leader-meetings/scorecard/scorecard.service';
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
 * | `owner@kpm0417.test` (Wilson Tanoto), `admin@kpm0417.test` (Maya Halim) | **Three meetings, newest first.** **#14**, in three days: *Upcoming*, its scorecard live; the prototype's ten agenda items, *"Prepare {last month} performance data"*; the prototype's four rows (`KPM_Owner.html:2516-2521`) — *"4 open items"*; *Monthly Target* typed as `:2462-2471` draws it (*TBD* for APE, New AA and Case submission, *"8 (1 @ unit)"*, *"22 (3 @ unit)"*, *Manpower* empty); its editors live — the Owner, Maya Halim, Agus, Sari and Yosef, *"3 core leaders tagged"*. **#13**, two weeks ago: *Completed*, **frozen** the morning after its day, its editors as they were — the Owner, Maya Halim, Agus and Sari, *"2 core leaders tagged"* (Yosef tagged since); the prototype's agenda for it (`:2527-2539`) and its three rows — *Not yet planned*, *Planned* (`:2517`), *Implemented*; **a live link the Owner made two days ago**. **#12**, four weeks ago: *Completed*, frozen, *All clear* (`:2563`); **one link made on its day, expired since**. Every write, *+ New meeting* (*#15*), moving #14, *Share* and *Stop sharing*, *Save as PDF* |
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

/** *Monthly Target* as the prototype draws it (`:2462-2471`): *Manpower* left empty, never typed. */
const PROTOTYPE_TARGETS: Record<string, string> = {
  ape: 'TBD', flc: '8 (1 @ unit)', new_aa: 'TBD', avg_monthly_aa: '22 (3 @ unit)', case_submission: 'TBD',
};

type Row = [initiative: string, metric: string, action: string, pic: string, status: ActionStatus, remarks: string];

/** #14's four rows (`:2516-2521`), verbatim. */
const ROWS_14: readonly Row[] = [
  ['Activity tracking tool adoption', 'Adoption 80% (currently 63%)', 'Socialization on Activity Tracking Tool in LWS session', 'Amelia', 'planned', 'Scheduled for 2 Sept'],
  ['Activity tracking tool adoption', 'Adoption 80% (currently 63%)', 'Find success story for leaders meeting', 'Amelia', 'planned', 'TBD'],
  ['Leads Generation Playbook', '# of new prospects', 'Embed into recruitment onboarding', 'Ferry / Joy', 'not_planned', 'TBD'],
  ['Team Management Playbook', '# of 1-on-1s', 'Embed into leaders training materials', 'Hellen', 'not_planned', 'TBD'],
];

/** #13's: the prototype's two (`:2545-2546`) and one *Planned* row (`:2517`) — *Not yet planned*, *Planned*, *Implemented*. */
const ROWS_13: readonly Row[] = [
  ['Recruitment Playbook', '# of FLC / NPA', 'Embed into weekly training materials', 'TBD', 'not_planned', 'TBD'],
  ROWS_14[0],
  ['Strategic Leader Forum', '100% conducted, next 6 months', 'Monitor production metrics bi-weekly', 'TBD', 'implemented', 'Ongoing'],
];

/** #12's one row (`:2563`), implemented: *All clear*. */
const ROWS_12: readonly Row[] = [
  ['Team Management Playbook', '# of 1-on-1s', 'Draft playbook outline', 'Hellen', 'implemented', 'Done Aug 20'],
];

type Agenda = Record<AgendaSection, [text: string, pic: string, done: boolean][]>;

/** #13's agenda (`:2527-2539`), the month it names the one before its own. Boxes on *During* alone. */
const agenda13 = (date: string): Agenda => {
  const month = monthBefore(date);
  return {
    preparation: [[`Compile follow-ups from ${month} session`, 'Wilson', false], [`Prepare ${month} performance data`, 'Wilson', false]],
    during: [
      [`Process update — reviewed ${month} follow-ups`, '', true], ['Performance review vs. thresholds', '', true],
      ['Strategic priorities (Agency) — recruitment focus', '', true], ['Next steps summarized, owners assigned', '', true],
    ],
    post: [['Documented outcomes into template', 'Wilson', false], ['Executed follow-ups from Prudential HO side', '', false]],
  };
};

/** #12's agenda (`:2555-2560`). */
const AGENDA_12: Agenda = {
  preparation: [['Compile follow-ups from prior session', 'Wilson', false]],
  during: [['Performance review vs. thresholds', '', true], ['Strategic priorities (Corporate)', '', true]],
  post: [['Documented outcomes into template', 'Wilson', false]],
};

/** The prototype's ten, PICs empty, as an office's first meeting starts (ADR-0130 §3). */
const tenItems = (date: string): Agenda => {
  const texts = firstAgendaTexts(date);
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
  return new LeaderScorecardService(people, new ProductionReadings(monthRows), monthRows, memberships, clock);
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
    const monthlyTargets = Object.fromEntries(Object.entries(spec.targets)
      .map(([row, value]): [string, MonthlyTargetCell] => [row, { value, version: 1 }]));
    let frozen: Record<string, unknown> = { frozenScorecard: null, frozenAt: null, frozenCoeditors: null };
    if (spec.freeze) {
      // The first read: the morning after its day, by the Owner.
      const frozenAt = at(addDays(spec.date, 1), 9);
      freezeClock.set(frozenAt);
      const frozenScorecard = await scorecards.compute({ kpmId: spec.kpmId, timezone: tz, meetingDate: spec.date });
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
    kpmId: a.kpmId, actor: a.owner, number: 12, date: date12, createdOn: addDays(date12, -4), agenda: AGENDA_12, rows: ROWS_12,
    targets: PROTOTYPE_TARGETS, writtenAt: at(date12, 11), freeze: true,
  });
  const m13 = await meeting({
    kpmId: a.kpmId, actor: a.owner, number: 13, date: date13, createdOn: addDays(date13, -4), agenda: agenda13(date13), rows: ROWS_13,
    targets: PROTOTYPE_TARGETS, writtenAt: at(date13, 11), freeze: true,
  });
  const m14 = await meeting({
    kpmId: a.kpmId, actor: a.owner, number: 14, date: date14, createdOn: addDays(today, -4), agenda: tenItems(date14), rows: ROWS_14,
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
  const guide = `
  FORUM at /leader-meetings  (from src/seed/leader-forum-fixture.ts)
    owner@kpm0417.test           Three meetings, newest first. #14 on ${date14}, Upcoming: the scorecard live,
    admin@kpm0417.test           the ten agenda items ("Prepare ${monthBefore(date14)} performance data"), four
                                 open items, Monthly Target typed (Manpower empty), "3 core leaders tagged".
                                 #13 on ${date13}, Completed and frozen: its editors the Owner, Maya, Agus and
                                 Sari ("2 core leaders tagged"); Not yet planned, Planned, Implemented; a live
                                 link. #12 on ${date12}, Completed, frozen, All clear; its link expired.
                                 + New meeting makes #15; Share, Stop sharing, Save as PDF
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
