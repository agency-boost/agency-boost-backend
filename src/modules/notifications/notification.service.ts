import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { can } from '@/modules/rbac/permissions';
import { describeNotification, IN_APP_TEMPLATES, inboxAddress } from './inbox-copy';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { INBOX_PAGE } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationRepository } from './notification.repository';
import {
  Notification, NotificationDocument,
  NotificationPreferences, NotificationPreferencesDocument,
} from './notification.schema';
import {
  DeliveryStatus, NotificationChannel, NotificationChannelAdapter,
  NotificationTemplateId, RenderedMessage, SendRequest, TEMPLATE_CHANNELS,
} from './notification.types';

/** One channel's delivery record, as `notifications.delivery` holds it. */
type Delivery = { status: DeliveryStatus; at?: Date; error?: string };

/** The recipient's choices, as `send` reads them. `null` when they have made none. */
type Preferences = { optedOutChannels?: NotificationChannel[]; mutedTemplates?: string[] } | null;

/**
 * **The channels delivered inside the request** (P12.1-T1): the in-app channel, whose delivery *is* the
 * row `send` writes. Every other channel (email today, WhatsApp later) goes to a server this product does
 * not run, so it is dispatched without being awaited: recorded `pending` on the row, and its outcome
 * recorded when it settles.
 */
const INLINE_CHANNELS: readonly NotificationChannel[] = ['in_app'];

/** An external channel's delivery, started and not awaited, whose outcome is recorded when it settles. */
interface Dispatch {
  channel: NotificationChannel;
  outcome: Promise<Delivery>;
}

/**
 * **How long a shutdown waits for the deliveries still in flight** (P18.7-T1, ADR-0152), in
 * milliseconds. A deploy stops the old container with SIGTERM and gives it 30 s before SIGKILL
 * (`stop_grace_period` in `deploy/compose.yml`). An SMTP send is bounded by `SMTP_TIMEOUT_MS`
 * (5 s by default) per dial and per greeting, so ten seconds covers a slow relay and leaves the
 * rest of the grace period for the HTTP server and the database to close. It is an operational
 * bound, not a business number, so it lives here beside the code that waits.
 */
export const NOTIFICATION_DRAIN_TIMEOUT_MS = 10_000;

/** A delivery started and not awaited, while it is in flight: what a shutdown waits for, and names if it cannot. */
export interface InFlightDelivery {
  templateId: string;
  channel: NotificationChannel;
  /** The row it will be recorded on, when that is known as it starts: a held email learns its row by claiming it. */
  notificationId?: string;
  coalesceKey?: string;
}

/** What `deliver` decided: the delivery map to write, and the deliveries still in flight. */
interface Delivered {
  delivery: Record<string, Delivery>;
  dispatched: Dispatch[];
}

/** A coalesced notice (P11-T8): one notification for several writes carrying the same key. */
export interface CoalescedSendRequest extends SendRequest {
  readonly userId: string;
  /** A coalesced notice always concerns an office. */
  readonly kpmId: string;
  /** `{sessionId}:{round}` — see `Notification.coalesceKey`. */
  readonly coalesceKey: string;
}

/** The channel whose delivery a coalesced notice holds until its session is finalized. */
const HELD_CHANNEL: NotificationChannel = 'email';

/**
 * The registered channel adapters. An injection token rather than a default parameter,
 * so adding the email or WhatsApp adapter is a provider change in one module rather
 * than a constructor edit here (ADR-0010).
 */
export const NOTIFICATION_ADAPTERS = 'NOTIFICATION_ADAPTERS';

/** MongoDB's duplicate-key error: a unique index refused an insert. */
const DUPLICATE_KEY = 11000;

/**
 * **The office a coalesced notice belongs to, as a context the tenant repository scopes by.** Its callers
 * name the office rather than hand over a request: `releaseHeld` runs after the finalize has answered, as a
 * background job on that one office would.
 */
function officeOf(kpmId: string): RequestContext {
  return RequestContext.forJob(kpmId, 'coalesced-notice');
}

/** Renders a template id + payload into a subject and body. */
export abstract class TemplateRenderer {
  abstract render(templateId: string, payload: Record<string, unknown>): RenderedMessage;
}

/**
 * Channel-agnostic dispatch.
 *
 * Callers name a template and a recipient. This service decides the channels, honours
 * opt-outs, records per-channel delivery status, and never lets a channel failure take
 * down the operation that triggered the notification.
 */

/** One row of somebody's own inbox. */
export interface InboxItem {
  notificationId: string;
  templateId: string;
  /** What it says, composed on the server — see `inbox-copy.ts` for why. */
  title: string;
  detail: string | null;
  /**
   * Where it opens, composed on the server beside its words (`inboxAddress`): `/coaching/me?session=…`
   * for a finalized coaching session (ADR-0078), `null` for every other item.
   */
  href: string | null;
  /** The office it concerns, or null — auth notifications predate any office. */
  kpmId: string | null;
  createdAt: string;
  readAt: string | null;
}

/**
 * One page of somebody's own inbox, newest first (P12.1-T4). `unread` counts the whole inbox, not the
 * page, so the bell and the list can never disagree; `total` is how many items the inbox holds.
 */
export interface Inbox {
  items: InboxItem[];
  unread: number;
  total: number;
  page: number;
  pageSize: number;
}

/** One notification's read state after it was marked, with the inbox's unread count beside it. */
export interface NotificationReadState {
  notificationId: string;
  readAt: string | null;
  unread: number;
}

/** The inbox's unread count after *Mark all read*. */
export interface UnreadCount {
  unread: number;
}

/**
 * The furthest a page may skip, as an int32 so the driver sends it as one. A page past the last is an
 * empty page however far past it is, and a `page` near `Number.MAX_SAFE_INTEGER` must not reach the
 * database as a skip it refuses.
 */
const MAX_SKIP = 2_147_483_647;

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly adapters = new Map<NotificationChannel, NotificationChannelAdapter>();
  /**
   * Every delivery started and not awaited, until it settles (P18.7-T1). Keyed by a promise that never
   * rejects, so waiting on them all cannot fail, and removed by that same promise once it settles.
   */
  private readonly inFlight = new Map<Promise<void>, InFlightDelivery>();

  constructor(
    @InjectModel(Notification.name)
    private readonly notifications: Model<NotificationDocument>,
    /*
     * **A coalesced notice's writes go through the tenant repository** (invariant §1; Phase 11 exit
     * review, N3): it always concerns an office, and the office is injected rather than written into each
     * filter. The model above stays for the person's own inbox, which is read by `userId` across offices.
     */
    private readonly coalesced: NotificationRepository,
    @InjectModel(NotificationPreferences.name)
    private readonly preferences: Model<NotificationPreferencesDocument>,
    private readonly renderer: TemplateRenderer,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    @Inject(NOTIFICATION_ADAPTERS) adapters: NotificationChannelAdapter[] = [],
  ) {
    for (const adapter of adapters) this.adapters.set(adapter.channel, adapter);
  }

  /**
   * **One notification, written now; its email sent after** (P12.1-T1).
   *
   * The inbox row — the in-app channel's whole delivery — is written inside the caller's request. Each
   * external channel is started at once and **not awaited**: the row records it `pending`, and its
   * outcome (`sent`, or `failed` with the error's text) is written onto the delivery map when it settles.
   * Measured on the dev server before this: an invitation's save took 10–11 s, because it waited for an
   * SMTP relay to time out; the same save without an invitee took under a second.
   *
   * The recipient's choices apply exactly as before: a muted template writes nothing and sends nothing,
   * and an opted-out channel is `suppressed` without its adapter being asked. A failure of the adapter or
   * of the recording is logged at error level and never reaches the caller.
   *
   * *A host that freezes a function once its response is sent* (Vercel, ADR-0041) may pause the email
   * until its next invocation, or end it — as coaching's held email already accepts. It then stays
   * `pending` on its row: visible on the delivery map, rather than lost silently.
   */
  async send(request: SendRequest & { userId: string; kpmId?: string | null }): Promise<void> {
    const prefs = await this.preferencesOf(request.userId);

    // Guard the arrays, not just the document: a preferences row written before a
    // field existed, or a partial upsert, leaves them undefined — and a crash here
    // would take down whatever operation triggered the notification.
    if (prefs?.mutedTemplates?.includes(request.templateId)) {
      this.logger.debug({ templateId: request.templateId }, 'template muted by recipient');
      return;
    }

    const { delivery, dispatched } = await this.deliver(request, prefs, null);

    const created = await this.notifications.create({
      kpmId: request.kpmId ?? null,
      membershipId: request.membershipId ?? null,
      userId: request.userId,
      templateId: request.templateId,
      /*
       * **The payload is kept only for a row somebody can actually read** (ADR-0019).
       *
       * `EMAIL_VERIFICATION` and `PASSWORD_RESET` carry a live single-use token in theirs,
       * and neither has an `in_app` channel — so the row they write is never rendered by
       * anything, because the inbox filters to `IN_APP_TEMPLATES`. It sat there holding a
       * credential nobody would ever read on purpose.
       *
       * `authTokens` deliberately stores only `tokenHash`, so that a database read cannot
       * reset somebody's password. Persisting the raw token in the row beside it undid
       * exactly that, for no benefit at all.
       */
      payload: IN_APP_TEMPLATES.includes(request.templateId) ? request.payload : {},
      delivery,
      readAt: null,
    });

    this.settle(dispatched, request.templateId, String(created._id), (channel, outcome) => this.notifications
      .updateOne(
        // Only over the `pending` this call wrote: an outcome never overwrites one recorded since.
        { _id: created._id, [`delivery.${channel}.status`]: 'pending' },
        { $set: { [`delivery.${channel}`]: outcome } },
      )
      .exec());
  }

  /**
   * **One notice for several writes, emailed once** (P11-T8; `functional/coaching.md`, *One notice per
   * session*).
   *
   * - **The first write for a key** creates the notification, delivers it in-app at once, and **holds**
   *   its email (`delivery.email.status: 'held'`), which `releaseHeld` sends when the session is
   *   finalized. A draft never finalized never sends it; the coachee was told in-app.
   * - **Each later write** creates nothing. The same notification takes the new payload — the last
   *   value — and is marked unread again, so somebody who read the first value sees the change.
   * - **The recipient's choices apply as `send` applies them**: a muted template writes nothing, and an
   *   opted-out channel is `suppressed` rather than held.
   *
   * Two first writes racing are settled by the unique index on `(kpmId, coalesceKey, templateId)`: the
   * second insert fails, and that write becomes a later one. Anything else that fails is the caller's to
   * contain — the goal save that calls this catches it, because a notice must never fail a save.
   */
  async sendCoalesced(request: CoalescedSendRequest): Promise<void> {
    const prefs = await this.preferencesOf(request.userId);
    if (prefs?.mutedTemplates?.includes(request.templateId)) {
      this.logger.debug({ templateId: request.templateId }, 'template muted by recipient');
      return;
    }

    const office = officeOf(request.kpmId);
    const notice = { userId: request.userId, coalesceKey: request.coalesceKey, templateId: request.templateId };
    if (await this.coalesced.refreshCoalesced(office, notice, request.payload)) return;

    // Email is the held channel, so nothing is dispatched here today; a later external channel (WhatsApp)
    // would be, and its outcome is recorded on the notice as `send` records one.
    const { delivery, dispatched } = await this.deliver(request, prefs, HELD_CHANNEL);
    try {
      const created = await this.coalesced.create(office, {
        ...notice,
        membershipId: request.membershipId ?? null,
        // A coalesced template has an inbox row, so its payload is one somebody reads (`send`, above).
        payload: request.payload,
        delivery,
        readAt: null,
      } as Partial<NotificationDocument>);
      this.settle(dispatched, request.templateId, String(created._id), (channel, outcome) =>
        this.coalesced.recordDelivery(office, String(created._id), channel, outcome));
    } catch (err) {
      if ((err as { code?: unknown }).code !== DUPLICATE_KEY) throw err;
      // Another first write got there between the read and the insert: this one is a later write.
      await this.coalesced.refreshCoalesced(office, notice, request.payload);
    }
  }

  /**
   * **Send a coalesced notice's held email, once** (P11-T8): what finalize calls for the session's round.
   *
   * The held state is **claimed** before anything is sent — `held` becomes `pending` in one conditional
   * write — so two finalizes, or a retry, cannot send it twice; a key with nothing held is a no-op. The
   * email is rendered from the notice's payload, which is the last value saved, and its outcome is
   * recorded on the delivery map as `send` records one. The recipient's choices are read again here,
   * since they may have changed while the session was open.
   */
  /**
   * **The notices about one calendar entry that one person has now dealt with, read.** An invitee who answers
   * an invitation has read the notice that announced it, so the bell stops counting it. Scoped to the
   * office in `ctx` through the tenant repository. Answers how many it marked.
   */
  async markEntryNoticesRead(
    ctx: RequestContext, userId: string, templateId: NotificationTemplateId, entryId: string,
  ): Promise<number> {
    return this.coalesced.markEntryNoticesRead(ctx, userId, templateId, entryId, this.clock.now());
  }

  releaseHeld(kpmId: string, coalesceKey: string, templateId: NotificationTemplateId): Promise<void> {
    // Its callers never await it (the finalize has answered), so it is tracked here, where it starts.
    const release = this.sendHeld(kpmId, coalesceKey, templateId);
    this.track(release, { templateId, channel: HELD_CHANNEL, coalesceKey });
    return release;
  }

  /**
   * **Every delivery in flight, awaited, for at most `timeoutMs`** (P18.7-T1): what a shutdown calls
   * once the HTTP server has stopped and its last requests have finished (`GracefulShutdown`, in
   * `src/graceful-shutdown.ts`), before the database connection closes, so each outcome is recorded. A delivery that starts while it waits (a
   * request the server was still finishing) is waited for too. Whatever is still in flight when the time is
   * up is logged at warn level, by template, channel and row, and answered: its row stays `pending`, which
   * is where somebody looking for it will find it.
   */
  async drain(timeoutMs: number = NOTIFICATION_DRAIN_TIMEOUT_MS, signal?: string): Promise<InFlightDelivery[]> {
    if (this.inFlight.size === 0) return [];
    this.logger.log({ inFlight: this.inFlight.size, signal }, 'waiting for deliveries in flight before shutting down');

    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<'expired'>((resolve) => { timer = setTimeout(() => resolve('expired'), timeoutMs); });
    try {
      while (this.inFlight.size > 0) {
        const drained = Promise.all(this.inFlight.keys()).then(() => 'drained' as const);
        if (await Promise.race([drained, expired]) === 'expired') break;
      }
    } finally {
      clearTimeout(timer);
    }

    const pending = [...this.inFlight.values()];
    if (pending.length > 0) {
      this.logger.warn({ pending, timeoutMs }, 'shutting down with deliveries still in flight; their rows stay pending');
    }
    return pending;
  }

  /** `releaseHeld`'s work: claim the held email, send it, record the outcome. */
  private async sendHeld(kpmId: string, coalesceKey: string, templateId: NotificationTemplateId): Promise<void> {
    const office = officeOf(kpmId);
    const claimed = await this.coalesced.claimHeld(office, { coalesceKey, templateId }, HELD_CHANNEL, this.clock.now());
    if (!claimed) return;

    const prefs = await this.preferencesOf(claimed.userId);
    const request: SendRequest = {
      userId: claimed.userId,
      membershipId: claimed.membershipId ?? undefined,
      templateId,
      payload: claimed.payload,
    };
    const outcome = prefs?.mutedTemplates?.includes(templateId)
      ? { status: 'suppressed' as const, at: this.clock.now() }
      : await this.deliverOne(HELD_CHANNEL, request, prefs, this.renderer.render(templateId, claimed.payload));
    await this.coalesced.recordDelivery(office, String(claimed._id), HELD_CHANNEL, outcome);
  }

  registerAdapter(adapter: NotificationChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }

  private async preferencesOf(userId: string): Promise<Preferences> {
    return this.preferences.findOne({ userId }).exec();
  }

  /**
   * Every channel the template declares, delivered or recorded as not: opted out is `suppressed`, the
   * `held` channel is kept back for `releaseHeld`, a channel with no adapter is `failed`, the in-app
   * channel is delivered now, and every other channel is **started now and not awaited** — `pending` on
   * the map, with its delivery handed back to be recorded when it settles (P12.1-T1).
   */
  private async deliver(
    request: SendRequest, prefs: Preferences, held: NotificationChannel | null,
  ): Promise<Delivered> {
    const rendered = this.renderer.render(request.templateId, request.payload);
    const delivery: Record<string, Delivery> = {};
    const dispatched: Dispatch[] = [];
    for (const channel of TEMPLATE_CHANNELS[request.templateId] ?? []) {
      // Held before the adapter is looked for, as it always was: whether one exists is `releaseHeld`'s question.
      const settled = channel === held && !prefs?.optedOutChannels?.includes(channel)
        ? { status: 'held' as const, at: this.clock.now() }
        : this.undeliverable(channel, prefs);
      if (settled) {
        delivery[channel] = settled;
      } else if (INLINE_CHANNELS.includes(channel)) {
        delivery[channel] = await this.deliverOne(channel, request, prefs, rendered);
      } else {
        delivery[channel] = { status: 'pending', at: this.clock.now() };
        dispatched.push({ channel, outcome: this.deliverOne(channel, request, prefs, rendered) });
      }
    }
    return { delivery, dispatched };
  }

  /**
   * **Record each dispatched delivery's outcome when it settles, without waiting for it.** Caught whole,
   * so a failed recording is a log line at error level, never an unhandled rejection and never the
   * caller's failure. The adapter's own failures, a rejection or a synchronous throw, are `deliverOne`'s
   * and arrive here as a `failed` outcome; `record` runs inside the `then`, so a synchronous throw of its
   * own is a rejection the `catch` sees.
   */
  private settle(
    dispatched: readonly Dispatch[],
    templateId: string,
    notificationId: string,
    record: (channel: NotificationChannel, outcome: Delivery) => Promise<unknown>,
  ): void {
    for (const { channel, outcome } of dispatched) {
      const recorded = outcome
        .then((settled) => record(channel, settled))
        .catch((err: unknown) => this.logger.error({ err, channel, templateId }, 'failed to record a delivery'));
      // Tracked until it is recorded, not only sent: a shutdown that waited for the send alone could close
      // the database under the write that records it.
      this.track(recorded, { templateId, channel, notificationId });
    }
  }

  /**
   * Hold `work` in the in-flight set until it settles, whichever way (P18.7-T1). The key is a promise that
   * never rejects, so `drain` can wait on all of them without one failure ending the wait. `work` itself is
   * left as it is: whoever started it still sees its rejection.
   */
  private track(work: Promise<unknown>, about: InFlightDelivery): void {
    const settled: Promise<void> = work
      .then(() => undefined, () => undefined)
      .then(() => { this.inFlight.delete(settled); });
    this.inFlight.set(settled, about);
  }

  /** A channel settled without asking its adapter: opted out is `suppressed`, no adapter is `failed`. */
  private undeliverable(channel: NotificationChannel, prefs: Preferences): Delivery | null {
    if (prefs?.optedOutChannels?.includes(channel)) return { status: 'suppressed', at: this.clock.now() };
    if (!this.adapters.has(channel)) return { status: 'failed', at: this.clock.now(), error: 'no adapter' };
    return null;
  }

  /**
   * One channel, through its adapter. A failing adapter — a rejection or a synchronous throw — is recorded
   * and logged at error level, and never thrown.
   */
  private async deliverOne(
    channel: NotificationChannel, request: SendRequest, prefs: Preferences, rendered: RenderedMessage,
  ): Promise<Delivery> {
    const settled = this.undeliverable(channel, prefs);
    if (settled) return settled;
    const adapter = this.adapters.get(channel) as NotificationChannelAdapter;
    try {
      await adapter.send(request, rendered);
      return { status: 'sent', at: this.clock.now() };
    } catch (err) {
      this.logger.error({ err, channel, templateId: request.templateId }, 'delivery failed');
      return { status: 'failed', at: this.clock.now(), error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * One page of somebody's own inbox, newest first (P12.1-T4).
   *
   * **Read by `userId`, on the model, and deliberately not through the tenant-scoped
   * repository.** `notifications.kpmId` is nullable by design: email verification and
   * password reset are sent before anybody has joined an office, so a tenant filter would
   * hide exactly the notifications a newcomer needs. The codebase already records this —
   * `CROSS_TENANT_INDEXES` in `index-conventions.tenancy.spec.ts` justifies the
   * `{ userId, readAt, createdAt }` and `{ userId, deletedAt, createdAt, _id }` indexes in the
   * same words.
   *
   * That is not a hole in the isolation rule; it is the rule applied to a collection that
   * belongs to a **person**, not to a tenant. The filter is the reader's own `userId`,
   * taken from the request context and never from a parameter — there is no id a caller
   * could supply to read somebody else's, and a test proves it.
   *
   * **Newest first, ties broken by id**, so two notices written in one millisecond keep their places
   * from one page to the next. The page and its size are clamped as well as validated: a page past the
   * last is an empty page, never an error.
   */
  async inbox(ctx: RequestContext, page = 1, pageSize: number = INBOX_PAGE.DEFAULT_SIZE): Promise<Inbox> {
    this.require(ctx, 'notification:read_inbox');
    const at = Math.max(Math.trunc(page) || 1, 1);
    const size = Math.min(Math.max(Math.trunc(pageSize) || 1, 1), INBOX_PAGE.MAX_SIZE);
    const mine = this.inboxFilter(ctx);

    const [items, total, unread] = await Promise.all([
      this.notifications
        .find(mine)
        .sort({ createdAt: -1, _id: -1 })
        .skip(Math.min((at - 1) * size, MAX_SKIP))
        .limit(size)
        .exec(),
      this.notifications.countDocuments(mine).exec(),
      this.unreadOf(ctx),
    ]);

    return {
      items: items.map((n) => ({
        notificationId: String(n._id),
        templateId: n.templateId,
        ...describeNotification(n.templateId, n.payload),
        href: inboxAddress(n.templateId, n.payload),
        kpmId: n.kpmId,
        createdAt: n.get('createdAt')?.toISOString() ?? '',
        readAt: n.readAt?.toISOString() ?? null,
      })),
      unread,
      total,
      page: at,
      pageSize: size,
    };
  }

  /**
   * Mark one read. **Idempotent**: one already read keeps the moment it was first read.
   *
   * The `userId` is part of the filter, not checked after the fact: a row that is not
   * yours does not match, so it is a `404` rather than a `403`. A `403` would confirm the
   * notification exists — the same reasoning as a member in another office. So is a row
   * that is yours but never in your inbox (an email-only auth notice), and a malformed id.
   */
  async markRead(ctx: RequestContext, notificationId: string): Promise<NotificationReadState> {
    this.require(ctx, 'notification:mark_read');
    const mine = this.oneOfMine(ctx, notificationId);
    const row = await this.notifications
      .findOneAndUpdate({ ...mine, readAt: null }, { $set: { readAt: this.clock.now() } }, { new: true })
      .exec()
      // Already read is not an error: pressing twice settles, and answers when it was first read.
      ?? await this.notifications.findOne(mine).exec();
    const state = await this.readState(ctx, row);
    await this.recordSupportMark(ctx, 'notification.marked_read', state.notificationId);
    return state;
  }

  /**
   * Mark one unread again (P12.1-T4), so it counts on the bell until it is dealt with. **Idempotent**,
   * and refused exactly as `markRead` refuses: a `404` for anything that is not an item of the reader's
   * own inbox.
   */
  async markUnread(ctx: RequestContext, notificationId: string): Promise<NotificationReadState> {
    this.require(ctx, 'notification:mark_read');
    const row = await this.notifications
      .findOneAndUpdate(this.oneOfMine(ctx, notificationId), { $set: { readAt: null } }, { new: true })
      .exec();
    const state = await this.readState(ctx, row);
    await this.recordSupportMark(ctx, 'notification.marked_unread', state.notificationId);
    return state;
  }

  /**
   * Everything at once, which is what somebody does after a week away. Answers the count it leaves:
   * none, unless a notice arrived between the write and the count.
   *
   * **Only what the inbox shows** (Phase 12.1 exit review, N3): the same filter as the reads and the
   * single marks, so an email-only auth row, which `markRead` answers 404, is not marked here either.
   */
  async markAllRead(ctx: RequestContext): Promise<UnreadCount> {
    this.require(ctx, 'notification:mark_read');
    await this.notifications
      .updateMany({ ...this.inboxFilter(ctx), readAt: null }, { $set: { readAt: this.clock.now() } })
      .exec();
    await this.recordSupportMark(ctx, 'notification.marked_all_read', null);
    return { unread: await this.unreadOf(ctx) };
  }

  /**
   * **A mark made in a support session, recorded** (Phase 12.1 exit review, B1; `roles-and-permissions.md`
   * §7.4): the Super Admin as the actor and the member as the effective user, which `AuditService.record`
   * adds, and the notification's id — never its words. A member marking their own inbox is not recorded:
   * it is their own reading, and a row per click would bury the audit log. A support session is the one
   * case where somebody else changes what the member's bell counts, so it is the one case written down.
   * The audit write fails open, as everywhere: the mark stands.
   */
  private async recordSupportMark(
    ctx: RequestContext,
    action: 'notification.marked_read' | 'notification.marked_unread' | 'notification.marked_all_read',
    notificationId: string | null,
  ): Promise<void> {
    if (!ctx.isImpersonating) return;
    await this.audit.record(ctx, {
      action,
      targetCollection: 'notifications',
      targetId: notificationId,
      targetMembershipId: ctx.membershipId,
    });
  }

  /**
   * What belongs in the reader's inbox: their own, not deleted, and only what an inbox shows. Email
   * verification and password reset are `email` only (`TEMPLATE_CHANNELS`), and a row saying "we emailed
   * you a reset link" is noise at best — at worst it is somewhere a token could surface.
   */
  private inboxFilter(ctx: RequestContext) {
    return { userId: ctx.userId, deletedAt: null, templateId: { $in: IN_APP_TEMPLATES } };
  }

  /**
   * One item of the reader's inbox, by id. A malformed id is "not here", a `404`, rather than a cast the
   * database fails with a 500.
   */
  private oneOfMine(ctx: RequestContext, notificationId: string) {
    if (!isValidObjectId(notificationId)) throw new NotFoundException('Notification');
    return { ...this.inboxFilter(ctx), _id: notificationId };
  }

  private async unreadOf(ctx: RequestContext): Promise<number> {
    return this.notifications.countDocuments({ ...this.inboxFilter(ctx), readAt: null }).exec();
  }

  /** What a mark answers: the row's read state, and the inbox's unread count after it. */
  private async readState(ctx: RequestContext, row: NotificationDocument | null): Promise<NotificationReadState> {
    if (!row) throw new NotFoundException('Notification');
    return {
      notificationId: String(row._id),
      readAt: row.readAt?.toISOString() ?? null,
      unread: await this.unreadOf(ctx),
    };
  }

  private require(ctx: RequestContext, permission: Parameters<typeof can>[1]): void {
    if (!can(ctx, permission)) {
      throw new DomainException(
        ErrorCode.PERM_DENIED,
        'You cannot do that.',
        HttpStatus.FORBIDDEN,
        { permission },
      );
    }
  }

}
