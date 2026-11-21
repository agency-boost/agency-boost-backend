import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type PlatformSettingsDocument = HydratedDocument<PlatformSettings>;

/**
 * ***Pengaturan platform*** (P19.23-T6 AC-3; ADR-0279): the platform's own settings, **one document**, keyed `platform`.
 * Platform-level — no KPM owns it — and written by the Super Admin alone, every change audited.
 *
 * **What is not here, on purpose:** the AI reading key. It lives in the environment (`ANTHROPIC_API_KEY`, ADR-0262 §4,
 * OD-358) and the console shows only whether it is set; a secret is never stored in the database or returned by the API.
 * Nor the default look, which the console shows and does not yet change (OD-426).
 */
@Schema({ ...baseSchemaOptions, collection: 'platformSettings' })
export class PlatformSettings {
  /** The one document's key. Unique, so two first saves racing write one document. */
  @Prop({ type: String, required: true, unique: true })
  key!: 'platform';

  /**
   * ***Nomor WhatsApp pengirim***: the number AgencyBoost's messages give as the one to reach it on WhatsApp — the
   * subscription offer, the PDF — stored as `+62` and its national digits (`normalisePhone`). `null` until set.
   */
  @Prop({ type: String, default: null })
  whatsappNumber!: string | null;

  /** Who saved last: a user id, for the console's *diubah oleh*; the audit row is the history. */
  @Prop({ type: String, default: null })
  updatedByUserId!: string | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

export const PlatformSettingsSchema = SchemaFactory.createForClass(PlatformSettings);
