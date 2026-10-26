import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException } from '@/common/errors/domain.exception';
import { formatDate } from '@/common/format/format';
import { addDays, isLocalDate } from '@/common/time/local-day';
import { refuseWith } from '@/common/validation/fields';
import { ACTIVATION } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MemberNames } from '@/modules/org/member-names.service';
import type { MembershipDocument } from '@/modules/org/membership.schema';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import type { ActivationProgressDocument } from './activation-progress.schema';
import { ActivationProgressRepository } from './activation-progress.repository';
import { ActivationProgressService, activationClosed } from './activation-progress.service';
import type {
  ActivationNoteSavedView, ActivationView, NewHireGroupView, NewHireRowView, NewHiresRosterView,
} from './activation-progress.view';
import { activationEndsOn, activationState, firstCaseClosed } from './activation-rules';

/**
 * **The leader's side of an activation** (P13-T5, P13-T6): *Your New Hires*, one hire's detail — which the
 * coaching *Activation* tab reads too (P13-T9) — a leader's tick, the start date's correction and the
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
  ) {}

  /**
   * **`GET /new-hires`** (D-group, OD-122): the open activations of everybody the reader coaches, in a
   * card per group — *Direct Unit* first, the hires whose leader is the reader (and the hires of an Agent
   * who reports to them, who is no unit of their own), then one card per leader below the reader, each
   * hire under the nearest AAB above them, or an AB under an AB naming its rung. **The leader cards by the
   * leader's full name, A to Z** (the Phase 13 exit review); rows by day, highest first, ties by name. A
   * reader who reaches no open activation is 404: the nav would not offer them the page.
   *
   * One §3.5 entry per hire shown, written concurrently (N7) — each fails open on its own, in the seam.
   */
  async roster(ctx: RequestContext): Promise<NewHiresRosterView> {
    const me = ctx.membershipId!;
    const coachees = await this.coach.coacheesOf(ctx, me);
    const office = await this.days.office(ctx);
    const open = await this.activations.openOf(ctx, coachees.map((c) => c.membershipId), office);
    if (open.length === 0) throw new NotFoundException('New hires');

    const resolved = await this.activations.resolve(ctx, open, office);
    const members = new Map(coachees.map((c) => [c.membershipId, c.membership] as const));
    const leaderOf = (hire: MembershipDocument): MembershipDocument | null => {
      if (hire.leaderId === me) return null;
      const below = hire.ancestorIds.slice(hire.ancestorIds.indexOf(me) + 1).reverse();
      return below.map((id) => members.get(id)!).find((m) => m.role !== 'agent') ?? null;
    };

    const names = await this.names.byMembershipId(ctx, [
      ...resolved.map((r) => r.doc.membershipId),
      ...resolved.map((r) => leaderOf(members.get(r.doc.membershipId)!)).filter((m) => m !== null).map((m) => String(m!._id)),
    ]);
    const person = (membershipId: string) => ({ membershipId, name: names.get(membershipId) ?? '' });

    const groups = new Map<string, NewHireGroupView>();
    groups.set('direct', { kind: 'direct', leader: null, hires: [] });
    for (const coachee of coachees) {
      if (coachee.membership.role !== 'agent') {
        groups.set(coachee.membershipId, {
          kind: coachee.membership.role === 'ab' ? 'ab' : 'aab', leader: person(coachee.membershipId), hires: [],
        });
      }
    }
    for (const r of resolved) {
      const leader = leaderOf(members.get(r.doc.membershipId)!);
      const row: NewHireRowView = {
        hire: person(r.doc.membershipId),
        startDate: r.doc.startDate,
        day: r.day,
        window: r.window,
        overdue: r.overdue,
        pct: r.progress.pct,
        firstCaseClosed: firstCaseClosed(r.progress),
      };
      groups.get(leader ? String(leader._id) : 'direct')!.hires.push(row);
    }

    await Promise.all(resolved.map((r) => this.subjectReads.record(
      ctx, { membershipId: r.doc.membershipId }, 'activation', { from: r.doc.startDate, to: office.today },
    )));
    const [direct, ...cards] = [...groups.values()];
    return {
      // *Direct Unit* first, then the leader cards A to Z by full name; empty ones omitted.
      groups: [direct, ...cards.sort((a, b) => a.leader!.name.localeCompare(b.leader!.name))]
        .filter((g) => g.hires.length > 0)
        .map((g) => ({ ...g, hires: g.hires.sort((a, b) => b.day - a.day || a.hire.name.localeCompare(b.hire.name)) })),
      today: office.today,
    };
  }

  /**
   * **`GET /new-hires/:membershipId`**: one hire's activation as a leader reads it, in any state — the
   * detail page, and the coaching *Activation* tab. The hire's own note and date on each item are not in
   * it. One §3.5 entry per read.
   */
  async detail(ctx: RequestContext, membershipId: string): Promise<ActivationView> {
    const doc = await this.reach(ctx, membershipId);
    const office = await this.days.office(ctx);
    const view = await this.activations.viewOne(ctx, doc, office, 'leader');
    await this.subjectReads.record(ctx, { membershipId }, 'activation', { from: doc.startDate, to: office.today });
    return view;
  }

  /** **`PUT /new-hires/:membershipId/items/:code`**: a leader's tick or untick, attributed to them (OD-121). */
  async tick(ctx: RequestContext, membershipId: string, code: string, done: boolean): Promise<ActivationView> {
    return this.activations.setItem(ctx, await this.reach(ctx, membershipId), code, { done }, 'leader');
  }

  /**
   * **`PUT /new-hires/:membershipId/start-date`** (OD-118): a leader corrects the day the activation
   * started — the office's today at the latest, at most `ACTIVATION.START_DATE_MAX_DAYS_BACK` days before
   * it. The day and the end follow; who corrected it and when are kept, and the audit row holds both dates.
   */
  async correctStart(ctx: RequestContext, membershipId: string, startDate: string): Promise<ActivationView> {
    const doc = await this.reach(ctx, membershipId);
    const office = await this.days.office(ctx);
    const earliest = addDays(office.today, -ACTIVATION.START_DATE_MAX_DAYS_BACK);
    if (!isLocalDate(startDate) || startDate > office.today || startDate < earliest) {
      refuseWith([
        `startDate must be a day from ${formatDate(earliest)} to ${formatDate(office.today)}: no later than today, and no more than `
          + `${ACTIVATION.START_DATE_MAX_DAYS_BACK} days before it.`,
      ]);
    }
    const state = activationState(doc.graduatedAt, office.today, activationEndsOn(office.timezone, doc.startDate));
    if (state !== 'open') throw activationClosed(state);

    const updated = await this.progress.updateItems(
      ctx, { _id: doc._id, graduatedAt: null },
      { $set: { startDate, startCorrectedAt: this.clock.now(), startCorrectedByMembershipId: ctx.membershipId } },
    );
    if (!updated) throw activationClosed('graduated');
    await this.audit.record(ctx, {
      action: 'activation.start_date_corrected',
      targetCollection: 'activationProgress',
      targetId: String(doc._id),
      targetMembershipId: membershipId,
      before: { startDate: doc.startDate },
      after: { startDate },
    });
    return this.activations.viewOne(ctx, updated, office, 'leader');
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
      refuseWith([`text must be 1 to ${ACTIVATION.COACHING_NOTE_MAX} characters once trimmed.`]);
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
