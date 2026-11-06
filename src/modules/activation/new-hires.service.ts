import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException } from '@/common/errors/domain.exception';
import { addDays, isLocalDate } from '@/common/time/local-day';
import { refuseWith } from '@/common/validation/fields';
import { ACTIVATION, ACTIVATION_3M } from '@/domain/constants';
import {
  activation3MByJoinMonth, activation3MDay, activation3MFirstSaleDay, activation3MShare, newHireStatusOf, newHiresWindow,
} from '@/domain/metrics/activation-3m';
import type { FirstSaleSource } from '@/domain/metrics/first-sale';
import { AuditService } from '@/modules/audit/audit.service';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import type { MembershipDocument } from '@/modules/org/membership.schema';
import { TenantDay, type OfficeDay } from '@/modules/tenants/tenant-day.service';
import { User, type UserDocument } from '@/modules/users/user.schema';
import type { ActivationProgressDocument } from './activation-progress.schema';
import { ActivationProgressRepository } from './activation-progress.repository';
import { ActivationProgressService, activationClosed } from './activation-progress.service';
import type {
  ActivationClosingsView, ActivationNoteSavedView, ActivationView, FirstSaleSourceView, NewHireDetailView, NewHireLeaderView,
  NewHireRowView, NewHiresRosterView, NewHireStandingView, NewHireUnitRefView, Activation3MFiguresView,
} from './activation-progress.view';
import { Activation3MService } from './activation-3m.service';
import { ActivationItemRecords, type ItemRecordInput } from './activation-records.service';
import { activationEndsOn, activationState } from './activation-rules';
import { ACTIVATION_REFUSALS } from './activation.messages';

const SAY = ACTIVATION_REFUSALS.VALIDATION_FAILED;

/**
 * **The leader's side of an activation** (P13-T5, P13-T6): *Your New Hires*, one hire's detail — which the
 * coaching *Activation* tab reads too (P13-T9) — a leader's tick, the join date's correction and the
 * coaching note.
 *
 * **Reach is `COACH`, resolved on the server at each request** (ADR-0074): a hire the reader coaches now,
 * at any depth, never themselves. Anybody else — a peer's hire, another office's, a member who left, the
 * reader — is **404**, never 403 (P11-T3 AC-3). A hire who moves leader leaves the old leader's roster at
 * once, and nothing is written to the activation when they do (D-moves).
 *
 * **Every read of a hire's activation is recorded** (D-audit, roles §3.5): the detail one entry, the
 * roster one per hire it shows, surface `activation`, failing open. A refused read records nothing.
 */
@Injectable()
export class NewHiresService {
  constructor(
    private readonly activations: ActivationProgressService,
    private readonly progress: ActivationProgressRepository,
    private readonly coach: CoachResolver,
    private readonly names: MemberNames,
    private readonly days: TenantDay,
    private readonly subjectReads: SubjectReadAudit,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    // ADR-0169 §2: the join date's correction writes the membership's `joinDate` beside the activation's start.
    private readonly memberships: MembershipRepository,
    // P18.8-T4 AC-3: a tick of a data-backed item, with its record; and the hire's closings it names.
    private readonly records: ActivationItemRecords,
    // P18.8-T6 AC-1: each new hire's 3M activation, kept once decided.
    private readonly results: Activation3MService,
    // UI V1, UI-027: the hire's WhatsApp number on their detail (`users.phone`), for the leader who coaches them.
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  /**
   * **`GET /new-hires`** (ADR-0173; P18.8-T6 AC-2, AC-3; UI V1, UI-023): **every new hire the reader coaches whose
   * join date is in the last twelve months** (`newHiresWindow`, the office's calendar) — `joinedAs = new_hire`, at any
   * depth, never an existing agent — in three sections by their **status** (D-24): *In progress* (no first sale, days 1
   * to 90), *Teraktivasi* (a first sale — by day 90, or after it in amber) and *not activated* (no first sale, past day
   * 90). Each row: the join date, today's day, the first sale with its day and source, the status, the 3M result, and
   * their checklist where they have one — an AB or an AAB placed as a new hire has none (ADR-0103), and is listed with
   * `checklist: null`. A hire marked left is listed as anybody else, by their sale and join date (no *Keluar*, UI-025).
   *
   * **The 3M activation %** (`ACTIVATION_3M_PCT`) of everybody listed, and of each unit — *Direct Unit*, then each
   * AAB's (or AB's) below the reader, D-group's grouping kept — each overall and by join month, so the page's month
   * filter reads the server's figure and computes none. A decided result nothing has kept yet is kept here
   * (`Activation3MService.settle`), never in a read-only session. A reader who coaches no such new hire is 404: the nav
   * would not offer them the page.
   *
   * One §3.5 entry per new hire shown, written concurrently (N7) — each fails open on its own, in the seam.
   */
  async roster(ctx: RequestContext): Promise<NewHiresRosterView> {
    const me = ctx.membershipId!;
    const office = await this.days.office(ctx);
    const window = newHiresWindow(office.today);
    const inWindow = { joinedAs: 'new_hire', joinDate: { $gte: window.from, $lte: window.to } } as const;
    const [coachees, gone] = await Promise.all([
      this.coach.coacheesOf(ctx, me),
      /*
       * **And the ones who left** (ADR-0173 §2, *"Not activated, including Left"*; ADR-0169 §4 as amended 2026-10-27):
       * *Mark left* removes a new hire from the office, so `COACH` reaches them no more — they are read here, below the
       * reader on the edges they were removed with, for the rest of their year.
       */
      this.memberships.find(ctx, { ...inWindow, ancestorIds: me, status: 'removed', leftAt: { $ne: null } }),
    ]);
    const listed = [
      ...coachees.filter(({ membership: m }) =>
        m.joinedAs === 'new_hire' && m.joinDate !== null && m.joinDate >= window.from && m.joinDate <= window.to),
      ...gone.map((m) => ({ membershipId: String(m._id), membership: m })),
    ];
    if (listed.length === 0) throw new NotFoundException('New hires');

    const ids = listed.map((c) => c.membershipId);
    const [results, activations] = await Promise.all([
      this.results.settle(ctx, listed.map((c) => c.membership), office),
      this.latestActivations(ctx, ids),
    ]);
    const checklists = new Map((await this.activations.resolve(ctx, activations, office)).map((r) => [r.doc.membershipId, r]));

    const members = new Map(coachees.map((c) => [c.membershipId, c.membership] as const));
    const leaderOf = (hire: MembershipDocument): MembershipDocument | null => {
      if (hire.leaderId === me) return null;
      const below = hire.ancestorIds.slice(hire.ancestorIds.indexOf(me) + 1).reverse();
      // A leaver's edges are the ones they left with: a leader since gone is no unit of the reader's now.
      return below.map((id) => members.get(id)).find((m) => m !== undefined && m.role !== 'agent') ?? null;
    };
    const leaders = new Map(listed.map((c) => [c.membershipId, leaderOf(c.membership)] as const));
    const names = await this.names.byMembershipId(ctx, [
      ...ids, ...[...leaders.values()].filter((m) => m !== null).map((m) => String(m!._id)),
    ]);
    const person = (membershipId: string) => ({ membershipId, name: names.get(membershipId) ?? '' });
    const unitOf = (leader: MembershipDocument | null): NewHireUnitRefView => (leader
      ? { kind: leader.role === 'ab' ? 'ab' : 'aab', leader: person(String(leader._id)) }
      : { kind: 'direct', leader: null });

    const rows: NewHireRowView[] = listed.map(({ membershipId, membership: m }) => {
      const checklist = checklists.get(membershipId);
      return {
        hire: person(membershipId),
        unit: unitOf(leaders.get(membershipId) ?? null),
        joinDate: m.joinDate!,
        day: activation3MDay(m.joinDate!, office.today),
        firstSaleDate: m.firstSaleDate ?? null,
        firstSaleDay: activation3MFirstSaleDay(m.joinDate!, m.firstSaleDate ?? null),
        firstSaleSource: saleSourceOf(m.firstSaleDate ? (m.firstSaleSource ?? null) : null),
        status: newHireStatusOf(results.get(membershipId) ?? 'in_progress', m.firstSaleDate ?? null),
        activation3M: results.get(membershipId) ?? 'in_progress',
        leftOn: m.leftAt ? this.clock.localDateFor(office.timezone, m.leftAt) : null,
        checklist: checklist
          ? {
            state: checklist.state, done: checklist.progress.done, total: checklist.progress.total,
            pct: checklist.progress.pct, overdue: checklist.overdue,
          }
          : null,
      };
    });

    const byName = (a: NewHireRowView, b: NewHireRowView) => a.hire.name.localeCompare(b.hire.name);
    const newestFirst = (a: NewHireRowView, b: NewHireRowView) =>
      (a.joinDate < b.joinDate ? 1 : a.joinDate > b.joinDate ? -1 : byName(a, b));
    const of = (section: 'inProgress' | 'activated' | 'notActivated') => rows.filter((r) => (
      section === 'activated' ? r.status !== 'not_yet'
        : r.status === 'not_yet' && (section === 'inProgress') === (r.activation3M === 'in_progress')));

    // *Direct Unit* first, then the leaders A to Z by full name; a unit nobody listed is in omitted.
    const unitKey = (u: NewHireUnitRefView) => u.leader?.membershipId ?? 'direct';
    const units = new Map<string, { ref: NewHireUnitRefView; rows: NewHireRowView[] }>();
    for (const row of rows) {
      const key = unitKey(row.unit);
      if (!units.has(key)) units.set(key, { ref: row.unit, rows: [] });
      units.get(key)!.rows.push(row);
    }
    const orderedUnits = [...units.values()].sort((a, b) => {
      if (!a.ref.leader) return -1;
      if (!b.ref.leader) return 1;
      return a.ref.leader.name.localeCompare(b.ref.leader.name);
    });

    await Promise.all(rows.map((r) => this.subjectReads.record(
      ctx, { membershipId: r.hire.membershipId }, 'activation', { from: r.joinDate, to: office.today },
    )));
    return {
      today: office.today,
      window,
      days: ACTIVATION_3M.DAYS,
      activation3M: figuresOf(rows),
      units: orderedUnits.map((u) => ({ ...u.ref, activation3M: figuresOf(u.rows) })),
      sections: {
        inProgress: of('inProgress').sort((a, b) => b.day - a.day || byName(a, b)),
        activated: of('activated').sort(newestFirst),
        notActivated: of('notActivated').sort(newestFirst),
      },
    };
  }

  /** The newest activation of each member, any state — one per membership is the rule, the newest wins. */
  private async latestActivations(ctx: RequestContext, membershipIds: readonly string[]): Promise<ActivationProgressDocument[]> {
    const rows = await this.progress.find(ctx, { membershipId: { $in: [...membershipIds] } }, { sort: { createdAt: -1, _id: -1 } });
    const newest = new Map<string, ActivationProgressDocument>();
    for (const doc of rows) if (!newest.has(doc.membershipId)) newest.set(doc.membershipId, doc);
    return [...newest.values()];
  }

  /**
   * **`GET /new-hires/:membershipId`**: one hire's activation as a leader reads it, in any state — the
   * detail page, and the coaching *Activation* tab. The hire's own note and date on each item are not in
   * it. One §3.5 entry per read.
   */
  async detail(ctx: RequestContext, membershipId: string): Promise<NewHireDetailView> {
    const doc = await this.reach(ctx, membershipId);
    const office = await this.days.office(ctx);
    const view = await this.withStanding(ctx, await this.activations.viewOne(ctx, doc, office, 'leader'), office);
    await this.subjectReads.record(ctx, { membershipId }, 'activation', { from: doc.startDate, to: office.today });
    return view;
  }

  /**
   * **The hire's 3M standing beside their activation** (UI V1, UI-023; D-25): the strip on the detail says what their
   * row says — the same `newHireStatusOf`, day and first sale — so a write on the detail (a tick that records a closing,
   * a corrected join date) answers the strip as it now stands. `null` for somebody who is not a new hire.
   *
   * **And the header's two facts** (UI-027, D-25): who they report to — their leader's name and rung — and their
   * WhatsApp number (`users.phone`), which the detail's *WhatsApp* opens. Both are read only here, for a reader who
   * reaches this hire (`reach`, `COACH`); the number never reaches the roster.
   */
  private async withStanding(
    ctx: RequestContext, view: ActivationView, office: OfficeDay,
  ): Promise<NewHireDetailView> {
    const member = await this.memberships.findById(ctx, view.hire.membershipId);
    if (!member || member.joinedAs !== 'new_hire' || !member.joinDate) return { ...view, newHire: null };
    const result = (await this.results.settle(ctx, [member], office)).get(view.hire.membershipId) ?? 'in_progress';
    const firstSaleDate = member.firstSaleDate ?? null;
    const newHire: NewHireStandingView = {
      status: newHireStatusOf(result, firstSaleDate),
      activation3M: result,
      joinDate: member.joinDate,
      day: activation3MDay(member.joinDate, office.today),
      firstSaleDate,
      firstSaleDay: activation3MFirstSaleDay(member.joinDate, firstSaleDate),
      firstSaleSource: saleSourceOf(firstSaleDate ? (member.firstSaleSource ?? null) : null),
      leader: await this.leaderOf(ctx, member),
      phone: await this.phoneOf(member),
    };
    return { ...view, newHire };
  }

  /** The hire's leader as their header names them (UI-027): membership, name and rung; `null` with nobody. */
  private async leaderOf(ctx: RequestContext, member: MembershipDocument): Promise<NewHireLeaderView | null> {
    if (!member.leaderId) return null;
    const leader = await this.memberships.findById(ctx, member.leaderId);
    if (!leader) return null;
    const name = (await this.names.byMembershipId(ctx, [String(leader._id)])).get(String(leader._id));
    return name ? { membershipId: String(leader._id), name, role: leader.role } : null;
  }

  /** The hire's WhatsApp number as stored on their account (UI-027), or `null`. */
  private async phoneOf(member: MembershipDocument): Promise<string | null> {
    const user = await this.users.findOne({ _id: member.userId }).select('phone').lean().exec();
    return (user as { phone?: string | null } | null)?.phone ?? null;
  }

  /**
   * **`PUT /new-hires/:membershipId/items/:code`**: a leader's tick or untick, attributed to them (OD-121) — and, for a
   * data-backed item, with its record, saved together (P18.8-T4 AC-3, `ActivationItemRecords`).
   */
  async tick(
    ctx: RequestContext, membershipId: string, code: string, change: { done: boolean; record?: ItemRecordInput },
  ): Promise<NewHireDetailView> {
    const view = await this.records.tick(ctx, await this.reach(ctx, membershipId), code, change, 'leader');
    return this.withStanding(ctx, view, await this.days.office(ctx));
  }

  /**
   * **`GET /new-hires/:membershipId/closings`** (P18.8-T4 AC-3): a hire's closings, for *Which case?* — to a leader
   * who reaches the hire's activation and reads their leads (`lead:read`'s reach); recorded as a read of their leads.
   */
  async closings(ctx: RequestContext, membershipId: string): Promise<ActivationClosingsView> {
    return this.records.closingsOf(ctx, await this.reach(ctx, membershipId));
  }

  /**
   * **`PUT /new-hires/:membershipId/start-date`** (OD-118, ADR-0169 §2): a leader corrects the hire's **join
   * date** — the office's today at the latest, at most `ACTIVATION.START_DATE_MAX_DAYS_BACK` days before it. It
   * moves **both** the membership's `joinDate` and the activation's start, which is the join date; the day and the
   * end follow; who corrected it and when are kept, and the one audit row holds both fields before and after. It
   * **does not reclassify** them: `joinedAs` was decided once, when the date was first set. The path and the body's
   * `startDate` keep their names, so nothing that calls it breaks.
   */
  async correctStart(ctx: RequestContext, membershipId: string, startDate: string): Promise<NewHireDetailView> {
    const doc = await this.reach(ctx, membershipId);
    const office = await this.days.office(ctx);
    const earliest = addDays(office.today, -ACTIVATION.START_DATE_MAX_DAYS_BACK);
    if (!isLocalDate(startDate) || startDate > office.today || startDate < earliest) {
      refuseWith([SAY.joinDateRange({ from: earliest, to: office.today, days: ACTIVATION.START_DATE_MAX_DAYS_BACK })]);
    }
    const state = activationState(doc.graduatedAt, office.today, activationEndsOn(office.timezone, doc.startDate));
    if (state !== 'open') throw activationClosed(state);

    // P18.8-T6 AC-1: a 3M result already decided is kept from the join date it was decided on, before the date moves.
    await this.results.keepBeforeChange(ctx, [membershipId]);
    const updated = await this.progress.updateItems(
      ctx, { _id: doc._id, graduatedAt: null },
      { $set: { startDate, startCorrectedAt: this.clock.now(), startCorrectedByMembershipId: ctx.membershipId } },
    );
    if (!updated) throw activationClosed('graduated');
    // The membership's join date moves with it (ADR-0169 §2): one date, kept in two places that must agree.
    const member = await this.memberships.findById(ctx, membershipId);
    await this.memberships.updateById(ctx, membershipId, { $set: { joinDate: startDate } });
    await this.audit.record(ctx, {
      action: 'activation.start_date_corrected',
      targetCollection: 'activationProgress',
      targetId: String(doc._id),
      targetMembershipId: membershipId,
      before: { startDate: doc.startDate, joinDate: member?.joinDate ?? null },
      after: { startDate, joinDate: startDate },
    });
    return this.withStanding(ctx, await this.activations.viewOne(ctx, updated, office, 'leader'), office);
  }

  /**
   * **`PUT /new-hires/:membershipId/note`** (OD-117): the leader's coaching note to the hire — one per hire,
   * replaced on each save, kept with who wrote it and when, and read by the hire on their own page. Trimmed;
   * 1 to `ACTIVATION.COACHING_NOTE_MAX` characters; refused on a graduated or expired activation, as every
   * write is. The audit row holds ids, never the words.
   */
  async saveNote(ctx: RequestContext, membershipId: string, text: string): Promise<ActivationNoteSavedView> {
    const doc = await this.reach(ctx, membershipId);
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > ACTIVATION.COACHING_NOTE_MAX) {
      refuseWith([SAY.coachingNote({ max: ACTIVATION.COACHING_NOTE_MAX })]);
    }
    // Like every other write: nothing on a graduated or expired activation changes (amended 2026-10-03).
    const office = await this.days.office(ctx);
    const state = activationState(doc.graduatedAt, office.today, activationEndsOn(office.timezone, doc.startDate));
    if (state !== 'open') throw activationClosed(state);

    const at = this.clock.now();
    const updated = await this.progress.updateItems(
      ctx, { _id: doc._id, graduatedAt: null }, { $set: { note: { text: trimmed, byMembershipId: ctx.membershipId, at } } },
    );
    if (!updated) throw activationClosed('graduated');
    await this.audit.record(ctx, {
      action: 'activation.note_saved',
      targetCollection: 'activationProgress',
      targetId: String(doc._id),
      targetMembershipId: membershipId,
    });
    const names = await this.names.byMembershipId(ctx, [ctx.membershipId!]);
    return {
      note: {
        text: trimmed,
        by: { membershipId: ctx.membershipId!, name: names.get(ctx.membershipId!) ?? '' },
        at: at.toISOString(),
      },
    };
  }

  /** The activation of a hire the reader coaches, or a 404 that says nothing about whether they exist. */
  private async reach(ctx: RequestContext, membershipId: string): Promise<ActivationProgressDocument> {
    const hire = await this.coach.coachee(ctx, ctx.membershipId!, membershipId);
    const doc = hire ? await this.activations.latestOf(ctx, membershipId) : null;
    if (!doc) throw new NotFoundException('Activation');
    return doc;
  }
}

/**
 * `ACTIVATION_3M_PCT` of a set of rows (rule A, UI V1): all of them, and each join month, newest first — one function
 * for the tree and for each leader's group, so the list, the tile and every leader's % agree.
 */
function figuresOf(rows: readonly NewHireRowView[]): Activation3MFiguresView {
  const outcomes = rows.map((r) => ({ joinDate: r.joinDate, result: r.activation3M, firstSaleDate: r.firstSaleDate }));
  return {
    all: activation3MShare(outcomes),
    byMonth: activation3MByJoinMonth(outcomes).map(({ month, share }) => ({ month, ...share })),
  };
}

/** Where a first sale came from, as the page says it (D-26): the data — a lead or the production file — or a hand tick. */
function saleSourceOf(source: FirstSaleSource | null): FirstSaleSourceView | null {
  if (source === null) return null;
  return source === 'manual' ? 'manual' : 'sales';
}
