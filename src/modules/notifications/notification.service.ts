import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { can } from '@/modules/rbac/permissions';
import { describeNotification, IN_APP_TEMPLATES, inboxAddress } from './inbox-copy';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
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

export interface Inbox {
  items: InboxItem[];
  unread: number;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly adapters = new Map<NotificationChannel, NotificationChannelAdapter>();

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
    @Inject(NOTIFICATION_ADAPTERS) adapters: NotificationChannelAdapter[] = [],
  ) {
    for (const adapter of adapters) this.adapters.set(adapter.channel, adapter);
  }

  async send(request: SendRequest & { userId: string; kpmId?: string | null }): Promise<void> {
    const prefs = await this.preferencesOf(request.userId);

    // Guard the arrays, not just the document: a preferences row written before a
    // field existed, or a partial upsert, leaves them undefined — and a crash here
    // would take down whatever operation triggered the notification.
    if (prefs?.mutedTemplates?.includes(request.templateId)) {
      this.logger.debug({ templateId: request.templateId }, 'template muted by recipient');
      return;
    }

    const delivery = await this.deliver(request, prefs, null);

    await this.notifications.create({
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

    const delivery = await this.deliver(request, prefs, HELD_CHANNEL);
    try {
      await this.coalesced.create(office, {
        ...notice,
        membershipId: request.membershipId ?? null,
        // A coalesced template has an inbox row, so its payload is one somebody reads (`send`, above).
        payload: request.payload,
        delivery,
        readAt: null,
      } as Partial<NotificationDocument>);
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
  async releaseHeld(kpmId: string, coalesceKey: string, templateId: NotificationTemplateId): Promise<void> {
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
   * `held` channel is kept back for `releaseHeld`, and the rest go through their adapters now.
   */
  private async deliver(
    request: SendRequest, prefs: Preferences, held: NotificationChannel | null,
  ): Promise<Record<string, Delivery>> {
    const rendered = this.renderer.render(request.templateId, request.payload);
    const delivery: Record<string, Delivery> = {};
    for (const channel of TEMPLATE_CHANNELS[request.templateId] ?? []) {
      delivery[channel] = channel === held && !prefs?.optedOutChannels?.includes(channel)
        ? { status: 'held', at: this.clock.now() }
        : await this.deliverOne(channel, request, prefs, rendered);
    }
    return delivery;
  }

  /** One channel, through its adapter. A failing adapter is recorded and logged, and never thrown. */
  private async deliverOne(
    channel: NotificationChannel, request: SendRequest, prefs: Preferences, rendered: RenderedMessage,
  ): Promise<Delivery> {
    if (prefs?.optedOutChannels?.includes(channel)) return { status: 'suppressed', at: this.clock.now() };
    const adapter = this.adapters.get(channel);
    if (!adapter) return { status: 'failed', at: this.clock.now(), error: 'no adapter' };
    try {
      await adapter.send(request, rendered);
      return { status: 'sent', at: this.clock.now() };
    } catch (err) {
      this.logger.error({ err, channel, templateId: request.templateId }, 'delivery failed');
      return { status: 'failed', at: this.clock.now(), error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Somebody's own inbox, newest first.
   *
   * **Read by `userId`, on the model, and deliberately not through the tenant-scoped
   * repository.** `notifications.kpmId` is nullable by design: email verification and
   * password reset are sent before anybody has joined an office, so a tenant filter would
   * hide exactly the notifications a newcomer needs. The codebase already records this —
   * `CROSS_TENANT_INDEXES` in `index-conventions.tenancy.spec.ts` justifies the
   * `{ userId, readAt, createdAt }` index in the same words.
   *
   * That is not a hole in the isolation rule; it is the rule applied to a collection that
   * belongs to a **person**, not to a tenant. The filter is the reader's own `userId`,
   * taken from the request context and never from a parameter — there is no id a caller
   * could supply to read somebody else's, and a test proves it.
   */
  async inbox(ctx: RequestContext, limit = 50): Promise<Inbox> {
    this.require(ctx, 'notification:read_inbox');

    const [items, unread] = await Promise.all([
      this.notifications
        // Only what belongs in an inbox. Email verification and password reset are
        // `email` only (`TEMPLATE_CHANNELS`), and a row saying "we emailed you a reset
        // link" is noise at best — at worst it is somewhere a token could surface.
        .find({ userId: ctx.userId, deletedAt: null, templateId: { $in: IN_APP_TEMPLATES } })
        .sort({ createdAt: -1 })
        .limit(Math.min(Math.max(limit, 1), 100))
        .exec(),
      this.notifications.countDocuments({
        userId: ctx.userId,
        readAt: null,
        deletedAt: null,
        templateId: { $in: IN_APP_TEMPLATES },
      }),
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
    };
  }

  /**
   * Mark one read.
   *
   * The `userId` is part of the filter, not checked after the fact: a row that is not
   * yours does not match, so it is a `404` rather than a `403`. A `403` would confirm the
   * notification exists — the same reasoning as a member in another office.
   */
  async markRead(ctx: RequestContext, notificationId: string): Promise<Inbox> {
    this.require(ctx, 'notification:mark_read');

    const result = await this.notifications
      .updateOne(
        { _id: notificationId, userId: ctx.userId, deletedAt: null, readAt: null },
        { $set: { readAt: this.clock.now() } },
      )
      .exec()
      // A malformed id is "not here", not a 500.
      .catch(() => ({ matchedCount: 0 }));

    if (result.matchedCount === 0) {
      // Already read is not an error — pressing twice should settle, not complain. Only
      // an id that is not this reader's is refused.
      const exists = await this.notifications
        .exists({ _id: notificationId, userId: ctx.userId, deletedAt: null })
        .catch(() => null);
      if (!exists) throw new NotFoundException('Notification');
    }

    return this.inbox(ctx);
  }

  /** Everything at once, which is what somebody does after a week away. */
  async markAllRead(ctx: RequestContext): Promise<Inbox> {
    this.require(ctx, 'notification:mark_read');
    await this.notifications
      .updateMany(
        { userId: ctx.userId, readAt: null, deletedAt: null },
        { $set: { readAt: this.clock.now() } },
      )
      .exec();
    return this.inbox(ctx);
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
