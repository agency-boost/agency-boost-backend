import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';
import { Notification, NotificationDocument } from './notification.schema';
import type { DeliveryStatus, NotificationChannel } from './notification.types';

/** Which coalesced notice a write is about: one per key, template and recipient in an office. */
export interface CoalescedNoticeKey {
  userId: string;
  coalesceKey: string;
  templateId: string;
}

/**
 * **The coalesced notices, through the chokepoint** (invariant §1; P11-T8; Phase 11 exit review, N3).
 *
 * A coalesced notice — one notification for every goal a leader saves through one coaching session — always
 * concerns an office, and its unique index leads with `kpmId`. So its writes go through here, with the
 * office injected from the context and `deletedAt: null` applied, like every tenant-scoped write.
 *
 * **Only these.** The rest of `notifications` is a person's inbox, read by `userId` across offices and
 * written before anybody has joined one (verification, password reset), so `NotificationService` keeps
 * the model for it — `CROSS_TENANT_INDEXES` and `raw-writes.tenancy.spec.ts` record why.
 */
@Injectable()
export class NotificationRepository extends TenantScopedRepository<NotificationDocument> {
  constructor(@InjectModel(Notification.name) model: Model<NotificationDocument>) {
    super(model, 'notifications');
  }

  /**
   * **A later write to a coalesced notice**: the last value, unread again — one conditional write. `null`
   * when the office holds no such notice yet.
   */
  async refreshCoalesced(
    ctx: RequestContext, key: CoalescedNoticeKey, payload: Record<string, unknown>,
  ): Promise<NotificationDocument | null> {
    return this.model
      .findOneAndUpdate(
        this.scope(ctx, 'refreshCoalesced', { ...key } as FilterQuery<NotificationDocument>),
        { $set: { payload, readAt: null } },
        { new: true },
      )
      .exec();
  }

  /**
   * **Claim a held delivery**, `held` → `pending`, in one conditional write, so two releases of the same
   * key send it once. `null` when nothing under the key is held on that channel.
   */
  async claimHeld(
    ctx: RequestContext,
    key: { coalesceKey: string; templateId: string },
    channel: NotificationChannel,
    at: Date,
  ): Promise<NotificationDocument | null> {
    return this.model
      .findOneAndUpdate(
        this.scope(ctx, 'claimHeld', {
          ...key, [`delivery.${channel}.status`]: 'held',
        } as FilterQuery<NotificationDocument>),
        { $set: { [`delivery.${channel}`]: { status: 'pending', at } } },
        { new: true },
      )
      .exec();
  }

  /** What became of one channel's delivery, recorded on the notice. */
  async recordDelivery(
    ctx: RequestContext,
    id: string,
    channel: NotificationChannel,
    outcome: { status: DeliveryStatus; at?: Date; error?: string },
  ): Promise<void> {
    await this.model
      .updateOne(
        this.scope(ctx, 'recordDelivery', { _id: id } as FilterQuery<NotificationDocument>),
        { $set: { [`delivery.${channel}`]: outcome } },
      )
      .exec();
  }
}
