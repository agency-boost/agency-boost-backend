import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import type { CellsByKode } from './monthly-agent-data.schema';

export type UnregisteredAgentDataDocument = HydratedDocument<UnregisteredAgentData>;

/** A held row waits for its code to register; a moved one was written onto the membership that took the code. */
export const HELD_ROW_STATUSES = ['held', 'moved'] as const;
export type HeldRowStatus = (typeof HELD_ROW_STATUSES)[number];

/**
 * **A month of an agent code no member of the KPM holds yet — *Belum terdaftar*** (P19.5-T2 AC-5; ADR-0214 §8, decision
 * 1(c)).
 *
 * Under the template's `unknownAgent: 'flag'` an upload's row whose code matches nobody is **kept, apart**: a
 * `monthlyAgentData` row needs a membership (invariant §2), and this has none. It is keyed by the code instead, as
 * ADR-0052 normalises it (upper case, trimmed).
 *
 * - **It counts in nothing**: not MAA, not a total, not the completeness denominator, not a peer value. The month table
 *   lists it after the members, read-only.
 * - **It moves when the code registers** in the KPM — any write that gives a membership of the KPM that code. Each held
 *   month is written onto the membership, a held cell filling only an empty one, and the row becomes `moved`, never
 *   deleted (`production.held_rows_moved` in the audit log).
 * - **A revert** of the import that held it soft-deletes it.
 *
 * Unique on `(kpmId, agentCode, month)` among live rows; `kpmId` leads every index (invariant §1).
 */
@Schema({ ...baseSchemaOptions, collection: 'unregisteredAgentData' })
export class UnregisteredAgentData {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** As ADR-0052 normalises it: trimmed, upper case. */
  @Prop({ type: String, required: true })
  agentCode!: string;

  /** The name the file gave, for the reader to recognise. Never matched on. */
  @Prop({ type: String, default: '' })
  fileName!: string;

  /** `YYYY-MM`, the office's calendar month. */
  @Prop({ type: String, required: true })
  month!: string;

  @Prop({ type: Object, default: () => ({}) })
  values!: CellsByKode;

  @Prop({ type: Object, default: () => ({}) })
  ytdValues!: CellsByKode;

  @Prop({ type: String, default: null })
  templateId!: string | null;

  @Prop({ type: Number, default: null })
  templateVersion!: number | null;

  @Prop({ type: String, default: null })
  asOf!: string | null;

  /** The import that held it — what a revert of that import removes. */
  @Prop({ type: String, required: true })
  sourceBatchId!: string;

  @Prop({ type: String, enum: HELD_ROW_STATUSES, default: 'held' })
  status!: HeldRowStatus;

  @Prop({ type: String, default: null })
  movedToMembershipId!: string | null;

  @Prop({ type: Date, default: null })
  movedAt!: Date | null;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const UnregisteredAgentDataSchema = SchemaFactory.createForClass(UnregisteredAgentData);

/** One held row per code per month. Partial, so a reverted (soft-deleted) one does not block holding it again. */
UnregisteredAgentDataSchema.index(
  { kpmId: 1, agentCode: 1, month: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
/** The month table's *Belum terdaftar* rows: one month's held rows. */
UnregisteredAgentDataSchema.index({ kpmId: 1, month: 1, status: 1, deletedAt: 1 });
