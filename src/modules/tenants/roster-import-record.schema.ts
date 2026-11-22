import { Injectable } from '@nestjs/common';
import { InjectModel, Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Model } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import { TenantScopedRepository } from '@/common/tenancy/tenant-scoped.repository';

/**
 * **One file of *Import people*, saved** (P19.20-T5 AC-3; ADR-0273 §6): *Riwayat unggah* — the file, when, by whom, *n
 * baru*, *n diperbarui*. Written by `RosterImportService` once a commit has landed, never by a preview and never by an
 * import that was undone. Counts and a file name only: the people are in `memberships`, and their codes in the audit
 * log's `roster.imported` (PDP, UU 27/2022 — no personal datum is copied here).
 *
 * Tenant-scoped, `kpmId` leading its one index (invariant §1); never hard-deleted (`deletedAt`, invariant §6).
 */
@Schema({ ...baseSchemaOptions, collection: 'rosterImports' })
export class RosterImportRecord {
  @Prop({ type: String, required: true })
  kpmId!: string;

  /** As the browser named it — *anggota_nov_2026.xlsx* — or `null` for rows pasted or rebuilt from a corrected preview. */
  @Prop({ type: String, default: null, maxlength: 255 })
  fileName!: string | null;

  /** *n baru*: new people with an account, and those invited on WhatsApp (ADR-0250 §4). */
  @Prop({ type: Number, required: true, min: 0 })
  created!: number;

  /** *n diperbarui*: members already in the office, by agent code. */
  @Prop({ type: Number, required: true, min: 0 })
  updated!: number;

  /** Of `created`, invited on WhatsApp rather than given an account. */
  @Prop({ type: Number, default: 0, min: 0 })
  invited!: number;

  /** Rows the file held that were not saved. */
  @Prop({ type: Number, default: 0, min: 0 })
  skipped!: number;

  /** Who saved it: their membership — `null` for the Super Admin inside the KPM, who holds none (ADR-0268 §3). */
  @Prop({ type: String, default: null })
  actorMembershipId!: string | null;

  /** Their account, always: the Super Admin's when they saved it. */
  @Prop({ type: String, default: null })
  actorUserId!: string | null;

  @Prop({ type: Date, required: true })
  importedAt!: Date;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;
}

export type RosterImportRecordDocument = HydratedDocument<RosterImportRecord>;
export const RosterImportRecordSchema = SchemaFactory.createForClass(RosterImportRecord);

/** *Riwayat unggah*, newest first. */
RosterImportRecordSchema.index({ kpmId: 1, importedAt: -1 });

/** An office's saved imports, through the tenant scope (invariant §1). */
@Injectable()
export class RosterImportRecordRepository extends TenantScopedRepository<RosterImportRecordDocument> {
  constructor(@InjectModel(RosterImportRecord.name) model: Model<RosterImportRecordDocument>) {
    super(model, 'rosterImports');
  }
}
