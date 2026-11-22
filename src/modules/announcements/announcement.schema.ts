import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import { ANNOUNCEMENT, type AnnouncementAudience } from '@/domain/constants';

export type AnnouncementDocument = HydratedDocument<Announcement>;

/**
 * **One *Pengumuman* sent** (P19.23-T6 AC-4; ADR-0279): what it said, to whom, how many people it reached, who sent it
 * and when. Platform-level — it may reach every KPM — and written once, when it is sent; nothing edits it. Each
 * recipient's copy is their own notification row; this is the record of the send.
 */
@Schema({ ...baseSchemaOptions, collection: 'announcements' })
export class Announcement {
  @Prop({ type: String, required: true })
  message!: string;

  @Prop({ type: String, enum: [...ANNOUNCEMENT.AUDIENCES], required: true })
  audience!: AnnouncementAudience;

  /** With `selected`: the companies chosen. Empty otherwise. */
  @Prop({ type: [String], default: [] })
  companyIds!: string[];

  /** With `selected`: the KPMs chosen. Empty otherwise. */
  @Prop({ type: [String], default: [] })
  kpmIds!: string[];

  /** The people it was sent to, each once. */
  @Prop({ type: Number, required: true })
  recipientCount!: number;

  @Prop({ type: String, required: true })
  sentByUserId!: string;

  @Prop({ type: Date, required: true })
  sentAt!: Date;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

export const AnnouncementSchema = SchemaFactory.createForClass(Announcement);
/** The section's list: newest first, live ones only. */
AnnouncementSchema.index({ deletedAt: 1, sentAt: -1 });
