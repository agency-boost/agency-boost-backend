import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';
import { RECRUITMENT_PITCH_SLOTS, type RecruitmentPitchSlotCode } from '@/domain/constants';

export type RecruitmentPitchSlotDocument = HydratedDocument<RecruitmentPitchSlot>;

/**
 * **One tick of a slot's checklist** (D-replace): which item, by which membership, when. The membership,
 * never a user or a name (invariant §2). The agents' and the settings' read says only whether an item is
 * ticked — never who ticked it (T4 AC-5); the audit log holds who and when.
 */
@Schema({ _id: false })
export class PitchConfirmation {
  @Prop({ type: String, required: true })
  item!: string;

  @Prop({ type: String, required: true })
  byMembershipId!: string;

  @Prop({ type: Date, required: true })
  at!: Date;
}

export const PitchConfirmationSchema = SchemaFactory.createForClass(PitchConfirmation);

/**
 * **One of an office's four recruitment pitch documents** (D-model, D-slots; collection
 * `kpmRecruitmentPitchDocuments`): the file the office uploaded to a slot, and the confirmations it ticked
 * against that file.
 *
 * **The office's own** (ADR-0032): its `kpmId` leads every index, every read and write goes through
 * `RecruitmentPitchRepository`, and its file is an office asset in the office's `recruitment-pitch` folder.
 * A row exists only once a file is attached — a slot with no row is *Missing* — so **no row ever points at
 * a file storage does not hold** (D-seed).
 *
 * **`version` tracks the file** (D-replace): every attach moves it by one and clears every confirmation in
 * the same write; a tick names the version it was made against and does not move it, so a tick sent
 * against a file replaced since is refused (`409 VERSION_CONFLICT`).
 */
@Schema({ ...configSchemaOptions, collection: 'kpmRecruitmentPitchDocuments' })
export class RecruitmentPitchSlot {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true, enum: RECRUITMENT_PITCH_SLOTS.map((s) => s.code) })
  slot!: RecruitmentPitchSlotCode;

  /** The office's asset (`assets.storageKey`) — never a URL, which is minted per read and expires. */
  @Prop({ type: String, required: true })
  storageKey!: string;

  /** The name the file was uploaded under, shown on the card as text (H-22). */
  @Prop({ type: String, required: true })
  fileName!: string;

  /** What storage reported, not what the browser claimed (ADR-0040). */
  @Prop({ type: String, required: true })
  mimeType!: string;

  @Prop({ type: Number, required: true })
  bytes!: number;

  /** When this file was attached; the card's day is this instant's day in the office's calendar. */
  @Prop({ type: Date, required: true })
  uploadedAt!: Date;

  @Prop({ type: String, default: null })
  uploadedByMembershipId!: string | null;

  @Prop({ type: [PitchConfirmationSchema], default: [] })
  confirmations!: PitchConfirmation[];

  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const RecruitmentPitchSlotSchema = SchemaFactory.createForClass(RecruitmentPitchSlot);

/** One live row per office and slot (D-model). */
RecruitmentPitchSlotSchema.index(
  { kpmId: 1, slot: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
