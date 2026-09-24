import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type LeadStatusDocument = HydratedDocument<LeadStatus>;

export const LEAD_PIPELINES = ['sales', 'recruitment'] as const;
export type LeadPipeline = (typeof LEAD_PIPELINES)[number];

/**
 * One stage of one pipeline, owned by one office (P4-T3).
 *
 * **A lead holds the `code`, not the label.** The prototype stores the status string
 * itself on the lead, so renaming a status in the Owner's settings screen would orphan
 * every lead holding the old text (`leads-management.md:214`). That is the defect this
 * collection exists to prevent.
 *
 * **`isTerminal` is a property, not the last element of an array.** The prototype gates
 * *mark successful* by comparing against the end of a hardcoded ladder, so an office
 * adding a stage after *Paid and issued* would silently move the gate.
 */
@Schema({ ...configSchemaOptions, collection: 'leadStatuses' })
export class LeadStatus {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true, enum: LEAD_PIPELINES })
  pipeline!: LeadPipeline;

  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  @Prop({ type: String, required: true, trim: true })
  label!: string;

  /** Order within its own pipeline. Sorting and colour ramp only — reorderable. */
  @Prop({ type: Number, required: true })
  rank!: number;

  /** The stage that closes this pipeline. What gates *mark successful*. */
  @Prop({ type: Boolean, required: true, default: false })
  isTerminal!: boolean;

  /**
   * A stage late enough that the lead is expected to convert this period (ADR-0043).
   *
   * **The source for `RECRUITMENT_EXPECTED_TO_CLOSE`**, the KPM Overview tile that could
   * not be computed until this field existed. Unlike `isTerminal` it is not exclusive:
   * an office may flag as many stages as its ladder warrants, and a ladder whose last
   * open stage is the only late one is a valid answer.
   *
   * **Never true on the terminal stage.** A lead that has closed is not expected to
   * close; counting it would double it against last period's figure.
   *
   * This is the whole of OD-12's second half. The ERD proposed a six-value `stageClass`
   * enum; four of its classes already existed under other names (`won` is `isTerminal`,
   * `lost` is a lead outcome and never a status) and nothing read the other two.
   */
  @Prop({ type: Boolean, required: true, default: false })
  isLateStage!: boolean;

  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active', index: true })
  status!: 'active' | 'archived';

  @Prop({ type: Date, default: null })
  archivedAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const LeadStatusSchema = SchemaFactory.createForClass(LeadStatus);

/**
 * One code per office, **across both pipelines** and counting archived rows.
 *
 * Across both on purpose: a lead carries a status code and a type, and the prototype
 * wipes the status when the type changes. Scoping uniqueness per pipeline would let one
 * code mean two things in one office, and the first cross-pipeline report would have to
 * guess which.
 */
LeadStatusSchema.index(
  { kpmId: 1, code: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/** The pipeline read: one ladder, in order. */
LeadStatusSchema.index({ kpmId: 1, pipeline: 1, rank: 1 });
