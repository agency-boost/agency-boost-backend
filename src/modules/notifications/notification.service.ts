import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { can } from '@/modules/rbac/permissions';
import { describeNotification, IN_APP_TEMPLATES } from './inbox-copy';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import {
  Notification, NotificationDocument,
  NotificationPreferences, NotificationPreferencesDocument,
} from './notification.schema';
import {
  DeliveryStatus, NotificationChannel, NotificationChannelAdapter,
  RenderedMessage, SendRequest, TEMPLATE_CHANNELS,
} from './notification.types';

/**
 * The registered channel adapters. An injection token rather than a default parameter,
 * so adding the email or WhatsApp adapter is a provider change in one module rather
 * than a constructor edit here (ADR-0010).
 */
export const NOTIFICATION_ADAPTERS = 'NOTIFICATION_ADAPTERS';

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
    @InjectModel(NotificationPreferences.name)
    private readonly preferences: Model<NotificationPreferencesDocument>,
    private readonly renderer: TemplateRenderer,
    private readonly clock: Clock,
    @Inject(NOTIFICATION_ADAPTERS) adapters: NotificationChannelAdapter[] = [],
  ) {
    for (const adapter of adapters) this.adapters.set(adapter.channel, adapter);
  }

  async send(request: SendRequest & { userId: string; kpmId?: string | null }): Promise<void> {
    const channels = TEMPLATE_CHANNELS[request.templateId] ?? [];
    const prefs = await this.preferences.findOne({ userId: request.userId }).exec();

    // Guard the arrays, not just the document: a preferences row written before a
    // field existed, or a partial upsert, leaves them undefined — and a crash here
    // would take down whatever operation triggered the notification.
    if (prefs?.mutedTemplates?.includes(request.templateId)) {
      this.logger.debug({ templateId: request.templateId }, 'template muted by recipient');
      return;
    }

    const rendered = this.renderer.render(request.templateId, request.payload);
    const delivery: Record<string, { status: DeliveryStatus; at?: Date; error?: string }> = {};

    for (const channel of channels) {
      if (prefs?.optedOutChannels?.includes(channel)) {
        delivery[channel] = { status: 'suppressed', at: this.clock.now() };
        continue;
      }
      const adapter = this.adapters.get(channel);
      if (!adapter) {
        delivery[channel] = { status: 'failed', at: this.clock.now(), error: 'no adapter' };
        continue;
      }
      try {
        await adapter.send(request, rendered);
        delivery[channel] = { status: 'sent', at: this.clock.now() };
      } catch (err) {
        delivery[channel] = {
          status: 'failed',
          at: this.clock.now(),
          error: err instanceof Error ? err.message : String(err),
        };
        this.logger.error({ err, channel, templateId: request.templateId }, 'delivery failed');
      }
    }

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

  registerAdapter(adapter: NotificationChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
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
