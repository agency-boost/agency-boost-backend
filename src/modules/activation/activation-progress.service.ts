import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { newHiresWindow } from '@/domain/metrics/activation-3m';
import { DomainException, NotFoundException, VersionConflictException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { isLocalDate, type LocalDate } from '@/common/time/local-day';
import { refuseWith } from '@/common/validation/fields';
import {
  dataItemHandWrite, isActivationDataLink, mayTickByHand, recordFormOf, type ActivationRecordForm,
} from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import type { MembershipDocument } from '@/modules/org/membership.schema';
import { can } from '@/modules/rbac/permissions';
import { TenantDay, type Office } from '@/modules/tenants/tenant-day.service';
import { OfferedTraining } from '@/modules/training/offered-training';
import type { ActivationSignal } from './activation-events.port';
import { trainingLinkModuleCode } from './activation-input';
import {
  ActivationService, type ActivationItemView, type ActivationVersionView,
} from './activation.service';
import { ActivationLinkEngine } from './activation-links';
import { NO_ACTIVATION_NAV, type ActivationNavFacts } from './activation-nav.port';
import type {
  ActivationItemState, ActivationOrigin, ActivationProgressDocument, ActivationRecordCollection,
} from './activation-progress.schema';
import { ActivationProgressRepository } from './activation-progress.repository';
import type {
  ActivationItemProgressView, ActivationPersonView, ActivationView,
} from './activation-progress.view';
import {
  activationDay, activationEndsOn, activationState, firstCaseClosed, freshItemState, isOverdue, progressOf,
  type ActivationState, type Progress,
} from './activation-rules';

/** Whose read it is: the hire's own carries their note and date on each item; a leader's never does. */
export type ActivationAudience = 'hire' | 'leader';

/** One activation with everything a reader is served computed — once, for every reader alike. */
export interface ResolvedActivation {
  doc: ActivationProgressDocument;
  version: ActivationVersionView;
  state: ActivationState;
  endsOn: LocalDate;
  day: number;
  window: number;
  overdue: boolean;
  progress: Progress<ActivationItemView>;
  /**
   * D-orphan (P18.5-T3 AC-4): whether the module a `training:` link binds is offered now. Always true for any
   * other link. While it is not, the item is ticked by hand and served `live: false`.
   */
  offered: (link: string | null) => boolean;
}

/** A change to one item: done or not, and — the hire's own only — their note and date. */
export interface ItemChange {
  done: boolean;
  note?: string | null;
  date?: string | null;
}

/** The record a hand tick of a data-backed item was saved with (P18.96-T4 AC-3): the closing, or the 1:1. */
export interface ItemRecord {
  collection: Extract<ActivationRecordCollection, 'leads' | 'coachingSessions'>;
  id: string;
}

/**
 * **A hand write to one item, checked and not yet made** (P18.96-T4 AC-3): what `setItem` checks before it writes,
 * kept so a data-backed item's record can be saved between the check and the tick — the record only once the tick
 * would be taken, and the tick only once the record is saved.
 */
export interface ItemWritePlan {
  doc: ActivationProgressDocument;
  office: Office;
  code: string;
  label: string;
  /** The hire's own join date, which a closing or a 1:1 saved with a tick is held to. */
  startDate: LocalDate;
  /** `closing` or `one_on_one` when the write is a tick that is taken only with its record; else `null`. */
  needsRecord: ActivationRecordForm | null;
}

const DUPLICATE_KEY = 11000;

/** Refused: graduated, or past its six months (OD-28, OD-120). */
export function activationClosed(state: ActivationState): DomainException {
  return new DomainException(
    ErrorCode.ACTIVATION_CLOSED,
    state === 'graduated'
      // P18.96-T6 AC-5 (ADR-0173 §4): the checklist is complete — never *activation*, which is the 3M result.
      ? 'This checklist is complete. Nothing on it changes now.'
      : 'This activation has ended: its six months are over. It is kept as it was, and nothing on it changes now.',
    HttpStatus.CONFLICT,
    { state },
  );
}

/**
 * **One hire's activation, and the hire's side of it** (Phase 13: P13-T1, T2, T4, T7): creating it when a
 * person joins under a leader, the one computation every reader is served, the hire's ticks with their note
 * and date, graduation, and the facts the *New agent* section is drawn from.
 *
 * **Creation** (OD-119): a placement through a leader — an approved request, a tag, a leader's code — of a
 * **new hire** (ADR-0169) at the Agent rung, pinned to the office's published checklist (D-version), starting on
 * the membership's join date, an office date (OD-118, ADR-0169 §2). Never a roster import or an office's creation; nothing for a membership that
 * has one already. **It fails open**, and the hire's next read creates what is missing.
 *
 * **Every read evaluates an open activation's links first** (D-links): a write whose call failed is healed
 * there, and every reader then reads the same stored state through `progressOf`. A read-only support
 * session is the exception that writes nothing (N3): no heal, and its links are met in memory only.
 */
@Injectable()
export class ActivationProgressService {
  private readonly logger = new Logger(ActivationProgressService.name);

  constructor(
    private readonly progress: ActivationProgressRepository,
    private readonly checklists: ActivationService,
    private readonly engine: ActivationLinkEngine,
    private readonly memberships: MembershipRepository,
    private readonly history: MembershipHistoryRepository,
    private readonly coach: CoachResolver,
    private readonly names: MemberNames,
    private readonly days: TenantDay,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    // P18.5-T3, D-orphan: which training modules are offered now, read once per resolve that binds one.
    private readonly training: OfferedTraining,
  ) {}

  // ------------------------------------------------------------------ creation

  /**
   * **`ActivationStarter`**: somebody was just placed under a leader. **A new hire** (ADR-0169 §3) at the Agent
   * rung who has no activation in this office gets one; anybody else — an existing agent above all, whose join
   * date was more than 90 days back when it was set — and a second placement of the same membership, gets nothing.
   */
  async joined(ctx: RequestContext, membershipId: string): Promise<void> {
    const member = await this.memberships.findById(ctx, membershipId);
    if (!member || member.status !== 'active' || member.role !== 'agent' || member.joinedAs !== 'new_hire') return;
    if (await this.progress.exists(ctx, { membershipId })) return;
    await this.create(ctx, member, 'joined');
  }

  /**
   * Write the activation, pinned to the version a hire starting now is given. `null` when the office has
   * published no checklist yet — logged, never thrown: there is nothing to pin, and the placement stands.
   * A second writer racing this one finds the database's unique index, and the activation it made.
   */
  private async create(
    ctx: RequestContext, member: MembershipDocument, origin: ActivationOrigin,
  ): Promise<ActivationProgressDocument | null> {
    const membershipId = String(member._id);
    const version = await this.checklists.publishedNow(ctx);
    if (!version) {
      this.logger.warn({ membershipId, kpmId: ctx.kpmId }, 'no published checklist to pin an activation to');
      return null;
    }
    const office = await this.days.office(ctx);
    try {
      return await this.progress.create(ctx, {
        membershipId,
        templateId: version.id,
        templateVersion: version.version,
        // The join date (ADR-0169 §2): an activation's start is the membership's join date, and nothing else.
        startDate: startOf(member, office.timezone, this.clock),
        startCorrectedAt: null,
        startCorrectedByMembershipId: null,
        origin,
        items: version.aspects.flatMap((a) => a.items).map((i) => freshItemState(i.code)),
        note: null,
        graduatedAt: null,
        graduatedByMembershipId: null,
        version: 1,
      } as Partial<ActivationProgressDocument>);
    } catch (err) {
      if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err;
      return this.latestOf(ctx, membershipId);
    }
  }

  /** A member's activation in this office, whatever its state — the newest, though nothing makes two. */
  async latestOf(ctx: RequestContext, membershipId: string): Promise<ActivationProgressDocument | null> {
    const [found] = await this.progress.find(ctx, { membershipId }, { sort: { createdAt: -1 }, limit: 1 });
    return found ?? null;
  }

  /**
   * **The reader's own activation, healing a placement whose creation failed** (P13-T1 AC-2), before the
   * page or the nav answers, so the two agree. Eligible: an active Agent with a leader, **a new hire**
   * (ADR-0169 §3 — an existing agent is never given one by a read either), whose join is within an
   * activation's life, and whose membership history shows they were **placed** — approved, tagged or through
   * a leader's code (`placedByALeader`). Such a member with none gets it now, from their join date; anybody
   * else has none.
   *
   * **A read-only support session heals nothing** (the Phase 13 exit review, N3): it is answered what is
   * stored — here, none — and the member's own next read creates it.
   */
  private async own(ctx: RequestContext): Promise<ActivationProgressDocument | null> {
    const me = ctx.membershipId!;
    const found = await this.latestOf(ctx, me);
    if (found || ctx.membership!.hierarchyRole !== 'agent' || ctx.impersonationReadOnly) return found;

    const member = (await this.memberships.findById(ctx, me))!;
    if (member.status !== 'active' || !member.leaderId || member.joinedAs !== 'new_hire') return null;
    const office = await this.days.office(ctx);
    const start = startOf(member, office.timezone, this.clock);
    if (activationState(null, office.today, activationEndsOn(office.timezone, start)) !== 'open') return null;
    if (!(await this.placedByALeader(ctx, member))) return null;
    return this.create(ctx, member, 'joined');
  }

  /**
   * **Was this membership placed under a leader, rather than imported or created with the office?** Read
   * from its history, which every path writes from the first day (invariant §5):
   *
   * - **an approved request or a tag** of somebody who registered: their registration's `joined` edge names
   *   no leader, and the placement opens a second `joined` edge that does;
   * - **a leader's code**: one `joined` edge naming the leader, written by the joiner themselves.
   *
   * A roster import's one `joined` edge is written by whoever imported it, and an office's creation names
   * no leader, so neither is a placement. **A code redeemed for somebody inside a support session reads as
   * an import** — the edge names the operator — and is not healed: a placement that cannot be told from an
   * import is never given an activation by a read.
   */
  private async placedByALeader(ctx: RequestContext, member: MembershipDocument): Promise<boolean> {
    const joins = await this.history.find(
      ctx, { membershipId: String(member._id), eventType: 'joined' }, { sort: { validFrom: 1, _id: 1 } },
    );
    return joins.some((edge, i) => edge.toLeaderId !== null && (i > 0 || edge.actorUserId === member.userId));
  }

  private async requireOwn(ctx: RequestContext): Promise<ActivationProgressDocument> {
    const doc = await this.own(ctx);
    if (!doc) throw new NotFoundException('Activation');
    return doc;
  }

  /** **The reader's own activation, healed as a read heals it**, or 404 — for the routes that write it (P18.96-T4). */
  async ownActivation(ctx: RequestContext): Promise<ActivationProgressDocument> {
    return this.requireOwn(ctx);
  }

  // ------------------------------------------------------------------ the one computation

  /**
   * **Every activation a read serves, computed once** (P13-T2 AC-5): its pinned version, its state and
   * end, its day, and its progress — after the open ones' links are evaluated, all of them in one pass of
   * one query per kind. The hire's page, a leader's detail, the roster and both coaching tabs read this.
   */
  async resolve(
    ctx: RequestContext, docs: readonly ActivationProgressDocument[], office: Office,
  ): Promise<ResolvedActivation[]> {
    const versions = new Map<number, Promise<ActivationVersionView | null>>();
    const pinned = await Promise.all(docs.map(async (doc) => {
      if (!versions.has(doc.templateVersion)) {
        versions.set(doc.templateVersion, this.checklists.findVersion(ctx, doc.templateVersion));
      }
      const version = await versions.get(doc.templateVersion)!;
      // A published version is immutable and never removed, so this is a row somebody broke by hand.
      if (!version) throw new NotFoundException('Activation checklist');
      return version;
    }));
    const ends = docs.map((doc) => activationEndsOn(office.timezone, doc.startDate));
    const states = docs.map((doc, i) => activationState(doc.graduatedAt, office.today, ends[i]));

    /*
     * D-orphan: what is offered is asked only when an **open** activation has a training item **not yet done** — the
     * one case it decides (a hand tick, and the link drawn live or not). Otherwise nothing is read (the exit review,
     * training review 3), and every module counts as offered: a closed activation refuses every write, and an item
     * already done is not ticked again.
     */
    const waitsOnTraining = docs.some((doc, i) => states[i] === 'open' && pinned[i].aspects.some((a) => a.items.some(
      (item) => trainingLinkModuleCode(item.autoLink) !== null && !doc.items.some((s) => s.code === item.code && s.done),
    )));
    const offeredCodes = waitsOnTraining ? await this.training.moduleCodes(ctx) : null;
    const offered = (link: string | null): boolean => {
      const code = trainingLinkModuleCode(link);
      return code === null || offeredCodes === null || offeredCodes.has(code);
    };

    const open = docs.map((doc, i) => ({ doc, i })).filter(({ i }) => states[i] === 'open');
    const evaluated = await this.engine.evaluate(
      ctx, open.map(({ doc, i }) => ({ doc, items: pinned[i].aspects.flatMap((a) => a.items) })), office.timezone,
    );
    const current = [...docs];
    open.forEach(({ i }, n) => { current[i] = evaluated[n]; });

    const window = office.settings.activationWindowDays;
    return current.map((doc, i) => {
      const progress = progressOf(pinned[i].aspects, new Set(doc.items.filter((s) => s.done).map((s) => s.code)));
      const day = activationDay(this.clock, office.timezone, doc.startDate, office.today);
      return {
        doc, version: pinned[i], state: states[i], endsOn: ends[i], day, window,
        overdue: isOverdue(day, window, progress.pct, states[i]), progress, offered,
      };
    });
  }

  /** One activation as its reader is served it, the names it carries resolved in one read. */
  async viewOne(
    ctx: RequestContext, doc: ActivationProgressDocument, office: Office, audience: ActivationAudience,
  ): Promise<ActivationView> {
    const [resolved] = await this.resolve(ctx, [doc], office);
    const names = await this.names.byMembershipId(ctx, peopleOn(resolved.doc));
    return this.view(resolved, office.today, audience, names);
  }

  /** The open activations of these members — graduated and expired ones are not on any roster. */
  async openOf(
    ctx: RequestContext, membershipIds: readonly string[], office: Office,
  ): Promise<ActivationProgressDocument[]> {
    if (membershipIds.length === 0) return [];
    const rows = await this.progress.find(ctx, { membershipId: { $in: [...membershipIds] }, graduatedAt: null });
    return rows.filter((doc) => office.today < activationEndsOn(office.timezone, doc.startDate));
  }

  private view(
    r: ResolvedActivation, today: LocalDate, audience: ActivationAudience, names: ReadonlyMap<string, string>,
  ): ActivationView {
    const person = (membershipId: string): ActivationPersonView => ({ membershipId, name: names.get(membershipId) ?? '' });
    const states = new Map(r.doc.items.map((s) => [s.code, s] as const));
    const own = audience === 'hire';
    const { doc } = r;
    return {
      hire: person(doc.membershipId),
      state: r.state,
      startDate: doc.startDate,
      startCorrected: doc.startCorrectedAt
        ? { by: person(doc.startCorrectedByMembershipId!), at: doc.startCorrectedAt.toISOString() }
        : null,
      today,
      day: r.day,
      window: r.window,
      overdue: r.overdue,
      endsOn: r.endsOn,
      done: r.progress.done,
      total: r.progress.total,
      pct: r.progress.pct,
      aspects: r.progress.aspects.map((aspect) => ({
        code: aspect.code,
        label: aspect.label,
        status: aspect.status,
        done: aspect.done,
        total: aspect.total,
        items: aspect.items.map(({ item, done }): ActivationItemProgressView => {
          const state: ActivationItemState = states.get(item.code) ?? freshItemState(item.code);
          // D-orphan: a training link to a module no longer offered is ticked by hand, so it is not served live —
          // unless its link already completed it, which nobody hand-edits (`mayTickByHand`).
          const orphan = !r.offered(item.autoLink) && !(done && state.source === 'link');
          return {
            code: item.code,
            label: item.label,
            link: item.link && orphan ? { ...item.link, live: false } : item.link,
            done,
            doneAt: done && state.doneAt ? state.doneAt.toISOString() : null,
            source: done ? state.source : null,
            doneBy: done && state.doneByMembershipId ? person(state.doneByMembershipId) : null,
            // The hire's own words and date, and nobody else's to read (P13-T2 AC-4).
            note: own ? state.note : null,
            date: own ? state.date : null,
            /*
             * P18.96-T4 AC-4: a data-backed item ticked by hand is *waiting for data* until its data confirms it — the
             * next evaluation then attributes it to the link. Its record, the source line's (AC-2): the lead, the
             * session or the file's month a data-backed item names, done.
             */
            waiting: done && state.source !== 'link' && isActivationDataLink(item.autoLink),
            record: done && isActivationDataLink(item.autoLink) && state.recordCollection && state.recordId
              ? { collection: state.recordCollection, id: state.recordId }
              : null,
          };
        }),
      })),
      firstCaseClosed: firstCaseClosed(r.progress),
      graduatedAt: doc.graduatedAt ? doc.graduatedAt.toISOString() : null,
      graduatedBy: doc.graduatedByMembershipId ? person(doc.graduatedByMembershipId) : null,
      note: doc.note ? { text: doc.note.text, by: person(doc.note.byMembershipId), at: doc.note.at.toISOString() } : null,
    };
  }

  // ------------------------------------------------------------------ the hire's own

  /** `GET /activation/me`: the reader's own activation, in any state, with their note and date. */
  async mine(ctx: RequestContext): Promise<ActivationView> {
    const doc = await this.requireOwn(ctx);
    return this.viewOne(ctx, doc, await this.days.office(ctx), 'hire');
  }

  /*
   * `PUT /activation/me/items/:code` is `ActivationItemRecords.tickMine` since P18.96-T4: a data-backed item's tick
   * carries its record, which this service cannot write without depending on the modules that own it.
   */

  /**
   * **Set one manual item** (P13-T2 AC-2, AC-3): the hire's own, or a leader's on a hire they coach. A
   * write **sets** the item rather than toggling it, so two people ticking at once cannot conflict and the
   * last write is the one named. An item the pinned version lacks is 404; one whose link is live is
   * nobody's to tick, by any route (`mayTickByHand`, by the link and never by position) — except a training
   * link whose module is no longer offered, which is ticked by hand (D-orphan, P18.5-T3 AC-4); a graduated or
   * expired activation refuses every write. One audit row per write, ids only.
   *
   * **A data-backed item is ticked only with its record** (P18.96-T4 AC-3): a bare tick here is refused,
   * `422 ACTIVATION_RECORD_REQUIRED`, and `ActivationItemRecords` is the route's way to tick one — the record and the
   * tick, together. Unticking one ticked by hand is taken; one its data completed is nobody's (`409`).
   */
  async setItem(
    ctx: RequestContext, doc: ActivationProgressDocument, code: string, change: ItemChange,
    source: 'hire' | 'leader',
  ): Promise<ActivationView> {
    const plan = await this.planItemWrite(ctx, doc, code, change);
    if (plan.needsRecord) throw recordRequired(code, plan.needsRecord);
    return this.commitItemWrite(ctx, plan, change, source, null);
  }

  /**
   * **Every check a hand write meets, before anything is written** (P18.96-T4 AC-3): the date's shape, the item in the
   * pinned version (404), the link's rule (`mayTickByHand`, `dataItemHandWrite`: `409 ACTIVATION_ITEM_AUTOMATIC`),
   * and the activation open (`409 ACTIVATION_CLOSED`). The plan says whether the write is a tick taken only with its
   * record, and which form that record is.
   */
  async planItemWrite(
    ctx: RequestContext, doc: ActivationProgressDocument, code: string, change: ItemChange,
  ): Promise<ItemWritePlan> {
    if (typeof change.date === 'string' && !isLocalDate(change.date)) {
      refuseWith(['date must be a day, written YYYY-MM-DD.']);
    }
    const office = await this.days.office(ctx);
    const [resolved] = await this.resolve(ctx, [doc], office);
    const item = resolved.version.aspects.flatMap((a) => a.items).find((i) => i.code === code);
    if (!item) throw new NotFoundException('Activation item');
    // Evaluated first (`resolve`), so a `done` progress row for the bound module has already completed it by its link.
    const byLink = completedByLink(resolved.doc, code);
    // P18.96-T4: a data-backed item — bound by its code — is ticked with its record, and unticked freely by hand.
    const dataRule = dataItemHandWrite(item.autoLink, change.done, byLink);
    if (dataRule === null) {
      // D-orphan, asked of this item itself: `resolve` reads what is offered only while a training item waits, and an
      // item hand-ticked while its module was withdrawn may be unticked while it still is.
      const moduleCode = trainingLinkModuleCode(item.autoLink);
      const offeredNow = moduleCode === null || (await this.training.moduleCodes(ctx)).has(moduleCode);
      if (!mayTickByHand(item.autoLink, offeredNow, byLink)) throw automatic(code, item.link!.completesWhen);
    } else if (dataRule === 'refused') {
      throw automatic(code, item.link!.completesWhen);
    }
    if (resolved.state !== 'open') throw activationClosed(resolved.state);
    return {
      doc: resolved.doc,
      office,
      code,
      label: item.label,
      startDate: resolved.doc.startDate,
      needsRecord: dataRule === 'needs_record' ? recordFormOf(item.autoLink) : null,
    };
  }

  /**
   * **The write a plan checked** (P18.96-T4 AC-3): done or not, by whom and when, and — for a data-backed item — the
   * record it was saved with, or none. One audit row, ids only, naming the record. The answer is the activation read
   * again, its links evaluated: a tick whose record makes the data complete — the fourth 1:1 — reads as the link's.
   */
  async commitItemWrite(
    ctx: RequestContext, plan: ItemWritePlan, change: ItemChange, source: 'hire' | 'leader', record: ItemRecord | null,
  ): Promise<ActivationView> {
    const { doc, code, office } = plan;
    await this.engine.ensureRows(ctx, doc, [code]);
    const at = 'items.$[it]';
    const set: Record<string, unknown> = change.done
      ? {
        [`${at}.done`]: true, [`${at}.doneAt`]: this.clock.now(), [`${at}.source`]: source,
        [`${at}.doneByMembershipId`]: ctx.membershipId,
        [`${at}.recordCollection`]: record?.collection ?? null, [`${at}.recordId`]: record?.id ?? null,
      }
      : {
        [`${at}.done`]: false, [`${at}.doneAt`]: null, [`${at}.source`]: null, [`${at}.doneByMembershipId`]: null,
        [`${at}.recordCollection`]: null, [`${at}.recordId`]: null,
      };
    if (change.note !== undefined) set[`${at}.note`] = change.note?.trim() || null;
    if (change.date !== undefined) set[`${at}.date`] = change.date;

    const updated = await this.progress.updateItems(
      // Never over a link: a data-backed item its data completed between the check and this write stays the link's.
      ctx, { _id: doc._id, graduatedAt: null }, { $set: set }, [{ 'it.code': code, 'it.source': { $ne: 'link' } }],
    );
    // Graduated between the read and the write: the write never landed.
    if (!updated) throw activationClosed('graduated');

    await this.audit.record(ctx, {
      action: change.done ? 'activation.item_ticked' : 'activation.item_unticked',
      targetCollection: 'activationProgress',
      targetId: String(doc._id),
      targetMembershipId: doc.membershipId,
      after: record ? { code, record } : { code },
    });
    return this.viewOne(ctx, updated, office, source);
  }

  /**
   * **`POST /activation/me/graduate`** (OD-28): the hire's own *Mark activation complete →*, at 100% —
   * every item, the linked ones included, which are evaluated first. Recorded here and nowhere else, with
   * who and when, and one audit row. Refused below 100%, and on an activation already closed.
   *
   * **The rule is the write's own precondition** (the Phase 13 exit review, N2): still open, and every item
   * of the pinned version done *in the stored row* — so an untick that lands between the read and the write
   * makes the write match nothing, where a check in memory alone would graduate an activation no longer
   * complete. A write that matched nothing reads again and answers what is there now: `ACTIVATION_CLOSED`
   * when another graduation landed first, `ACTIVATION_INCOMPLETE` when an item was unticked, and
   * `VERSION_CONFLICT` in the one case left — unticked and ticked again in between — so a retry reads afresh.
   */
  async graduate(ctx: RequestContext): Promise<ActivationView> {
    const office = await this.days.office(ctx);
    const resolved = await this.readyToGraduate(ctx, office);
    const { doc } = resolved;
    const codes = resolved.version.aspects.flatMap((a) => a.items).map((i) => i.code);
    const updated = await this.progress.updateItems(
      ctx,
      // A published version holds at least one item, so `$all` is never empty — which would match nothing.
      { _id: doc._id, graduatedAt: null, items: { $all: codes.map((code) => ({ $elemMatch: { code, done: true } })) } },
      { $set: { graduatedAt: this.clock.now(), graduatedByMembershipId: ctx.membershipId } },
    );
    if (!updated) {
      const now = await this.readyToGraduate(ctx, office);
      throw new VersionConflictException(doc.version, now.doc.version);
    }
    await this.audit.record(ctx, {
      action: 'activation.graduated',
      targetCollection: 'activationProgress',
      targetId: String(doc._id),
      targetMembershipId: doc.membershipId,
    });
    return this.viewOne(ctx, updated, office, 'hire');
  }

  /** The reader's own activation, open and at 100% after its links are evaluated — or the refusal naming which it is not. */
  private async readyToGraduate(ctx: RequestContext, office: Office): Promise<ResolvedActivation> {
    const [resolved] = await this.resolve(ctx, [await this.requireOwn(ctx)], office);
    if (resolved.state !== 'open') throw activationClosed(resolved.state);
    if (resolved.progress.done < resolved.progress.total) {
      throw new DomainException(
        ErrorCode.ACTIVATION_INCOMPLETE,
        `${resolved.progress.total - resolved.progress.done} of ${resolved.progress.total} items are not done yet. `
          + 'The checklist is complete when every item is.',
        HttpStatus.CONFLICT,
        { done: resolved.progress.done, total: resolved.progress.total },
      );
    }
    return resolved;
  }

  // ------------------------------------------------------------------ the ports

  /**
   * **`ActivationEvents`** (P13-T3 AC-5): a goal, a lead or a day was written for this member — or, since
   * P18.5-T3, they marked a training module *Done*. Their open
   * activation, if any, is evaluated now — every kind still waiting, not only this one, so a call missed
   * earlier heals here too.
   */
  async recorded(ctx: RequestContext, membershipId: string, _kind: ActivationSignal): Promise<void> {
    await this.recordedMany(ctx, [membershipId]);
  }

  /**
   * **`recorded`, for many members at once** (P18.96-T4): a production file's commit names everybody it gave a policy.
   * Their open activations are evaluated in one pass — one query per kind for all of them — and nothing is answered.
   */
  async recordedMany(ctx: RequestContext, membershipIds: readonly string[]): Promise<void> {
    const ids = [...new Set(membershipIds)];
    if (ids.length === 0) return;
    const docs = await this.progress.find(ctx, { membershipId: { $in: ids }, graduatedAt: null });
    if (docs.length === 0) return;
    await this.resolve(ctx, docs, await this.days.office(ctx));
  }

  /**
   * **`ActivationNav`** (P13-T7 AC-5): the reader's own activation — open, and complete — and whether they
   * reach anybody's open one, served with the session. The same reads the routes make, so the nav offers
   * exactly what the routes answer.
   */
  async factsFor(ctx: RequestContext): Promise<ActivationNavFacts> {
    if (ctx.membership!.status !== 'active') return NO_ACTIVATION_NAV;
    const office = await this.days.office(ctx);
    const doc = await this.own(ctx);
    const [resolved] = doc ? await this.resolve(ctx, [doc], office) : [];
    return {
      activation: resolved
        ? { open: resolved.state === 'open', complete: resolved.progress.done === resolved.progress.total }
        : null,
      newHires: await this.reachesANewHire(ctx, office),
    };
  }

  /**
   * Whether the reader coaches a **new hire who joined in the last twelve months** (OD-122; P18.96-T6, ADR-0173 §1) —
   * what `GET /new-hires` answers since it lists the year's new hires by their 3M result, not the open activations.
   */
  private async reachesANewHire(ctx: RequestContext, office: Office): Promise<boolean> {
    if (!can(ctx, 'new_hires:read_roster') || ctx.membership!.directCount === 0) return false;
    const window = newHiresWindow(office.today);
    const coaches = (await this.coach.coacheesOf(ctx, ctx.membershipId!)).some(({ membership: m }) =>
      m.joinedAs === 'new_hire' && m.joinDate !== null && m.joinDate >= window.from && m.joinDate <= window.to);
    // And one who left — removed by *Mark left*, listed for the rest of their year (ADR-0173 §2).
    return coaches || (await this.memberships.count(ctx, {
      ancestorIds: ctx.membershipId, status: 'removed', leftAt: { $ne: null }, joinedAs: 'new_hire',
      joinDate: { $gte: window.from, $lte: window.to },
    })) > 0;
  }
}

/** Refused: an item that completes on its own (ADR-0031), naming what completes it. */
function automatic(code: string, completesWhen: string): DomainException {
  return new DomainException(
    ErrorCode.ACTIVATION_ITEM_AUTOMATIC,
    `This item completes on its own, when ${completesWhen}. Nobody ticks it by hand.`,
    HttpStatus.CONFLICT,
    { code },
  );
}

/** Refused (P18.96-T4 AC-3): a bare tick of a data-backed item, which is ticked with its record. */
export function recordRequired(code: string, form: ActivationRecordForm): DomainException {
  return new DomainException(
    ErrorCode.ACTIVATION_RECORD_REQUIRED,
    form === 'closing'
      ? 'This item is ticked with the case it names: choose one of the closings, or log a new one.'
      : 'This item is ticked with the 1:1 it names: log it, with the day it was held and a note.',
    HttpStatus.UNPROCESSABLE_ENTITY,
    { code, form },
  );
}

/** Whether an item's stored state says its link completed it: done, attributed to the link. */
function completedByLink(doc: ActivationProgressDocument, code: string): boolean {
  const state = doc.items.find((i) => i.code === code);
  return state?.done === true && state.source === 'link';
}

/** Every member an activation names: the hire, whoever ticked or wrote what, corrected, graduated, noted. */
export function peopleOn(doc: ActivationProgressDocument): string[] {
  return [
    doc.membershipId,
    ...doc.items.map((s) => s.doneByMembershipId),
    doc.startCorrectedByMembershipId,
    doc.graduatedByMembershipId,
    doc.note?.byMembershipId ?? null,
  ].filter((id): id is string => id !== null);
}

/**
 * **Where a new hire's activation starts: their join date** (ADR-0169 §2). A membership made active since
 * P18.96-T2 always carries one; a row that predates it and migration 0040 falls back to its `joinedAt` as an office
 * date (ADR-0102's default), and the clock's own now covers one with neither.
 */
function startOf(member: MembershipDocument, timezone: string, clock: Clock): LocalDate {
  return member.joinDate ?? clock.localDateFor(timezone, member.joinedAt ?? undefined);
}
