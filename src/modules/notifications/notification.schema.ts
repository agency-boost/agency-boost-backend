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

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ kpmId: 1, membershipId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });

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
