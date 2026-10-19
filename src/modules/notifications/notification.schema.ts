import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import { DeliveryStatus, NotificationChannel } from './notification.types';

export type NotificationDocument = HydratedDocument<Notification>;

@Schema({ ...baseSchemaOptions, collection: 'notifications' })
export class Notification {
  @Prop({ type: String, default: null, index: true })
  kpmId!: string | null;

  @Prop({ type: String, default: null, index: true })
  membershipId!: string | null;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  @Prop({ type: String, required: true })
  templateId!: string;

  @Prop({ type: Object, default: {} })
  payload!: Record<string, unknown>;

  /** Per-channel delivery state, so a silent email failure is visible, not assumed. */
  @Prop({ type: Object, default: {} })
  delivery!: Record<NotificationChannel, { status: DeliveryStatus; at?: Date; error?: string }>;

  @Prop({ type: Date, default: null })
  readAt!: Date | null;

  /**
   * **One notice for several writes** (P11-T8; `functional/coaching.md`, *One notice per session*): every
   * goal a leader saves through one coaching session, in one round, lands on the notification carrying
   * this key — the session's id and how many times it has been reopened, `{sessionId}:{round}`. The
   * first write creates it, delivers it in-app and holds its email (`delivery.email.status: 'held'`); a
   * later one takes the new payload and marks it unread again; finalize sends the held email once.
   * `null` on every notification that is one per write, which is all the others.
   */
  @Prop({ type: String, default: null })
  coalesceKey!: string | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ kpmId: 1, membershipId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
/**
 * **One page of a person's inbox** (P12.1-T4): their own, not deleted, newest first with the id breaking
 * a tie — the order `inbox` sorts by, so a page is read off the index rather than sorted in memory, and
 * the total is counted from it. Per-user and cross-office like the index above, for the same reason
 * (`CROSS_TENANT_INDEXES`).
 */
NotificationSchema.index({ userId: 1, deletedAt: 1, createdAt: -1, _id: -1 });
/**
 * **At most one notice per key and template in an office**, held by the database rather than a
 * read-then-write, so two saves racing in one session write one notice. Partial: only a coalesced notice
 * carries a key. A coalesced notice always concerns an office, so `kpmId` leads (invariant §1).
 */
NotificationSchema.index(
  { kpmId: 1, coalesceKey: 1, templateId: 1 },
  { unique: true, partialFilterExpression: { coalesceKey: { $type: 'string' } } },
);

export type NotificationPreferencesDocument = HydratedDocument<NotificationPreferences>;

/**
 * Per-channel opt-out, present from the first release. An opt-out that arrives with
 * the channel is an opt-out nobody has to backfill (ADR-0010).
 */
@Schema({ ...baseSchemaOptions, collection: 'notificationPreferences' })
export class NotificationPreferences {
  @Prop({ type: String, required: true, unique: true, index: true })
  userId!: string;

  @Prop({ type: [String], default: [] })
  optedOutChannels!: NotificationChannel[];

  /** Template ids the user has muted individually. */
  @Prop({ type: [String], default: [] })
  mutedTemplates!: string[];

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

export const NotificationPreferencesSchema =
  SchemaFactory.createForClass(NotificationPreferences);
