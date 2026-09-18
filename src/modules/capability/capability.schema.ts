import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type CapabilityCatalogDocument = HydratedDocument<CapabilityCatalog>;

/** Anything a leader ticks. A stable code, a label somebody may correct, and a status. */
@Schema({ _id: false })
export class CapabilityEntry {
  /**
   * The identity. **Minted once, never reused, never changed by a rename** (ADR-0025).
   *
   * Two of the prototype's four grids have none: a tick is bound to the label, so renaming
   * *"Approach & appointment setting"* orphans every record that used it.
   */
  @Prop({ type: String, required: true })
  code!: string;

  @Prop({ type: String, required: true, trim: true })
  label!: string;

  @Prop({ type: Number, required: true })
  displayOrder!: number;

  /** Archived items stay readable on assessments that already reference them, and take no new ones. */
  @Prop({ type: String, enum: ['active', 'archived'], default: 'active' })
  status!: 'active' | 'archived';
}

export const CapabilityEntrySchema = SchemaFactory.createForClass(CapabilityEntry);

@Schema({ _id: false })
export class CapabilityStageRow {
  @Prop({ type: String, required: true })
  code!: string;

  @Prop({ type: String, required: true, trim: true })
  label!: string;

  /** Named milestones, never a count: a stage means what it lists. */
  @Prop({ type: [String], default: [] })
  requiredMilestoneCodes!: string[];

  /**
   * How senior the stage is — **not where it sits on screen**.
   *
   * Separate from `displayOrder` on purpose (AC-6): an office reordering the ladder for readability
   * must not move anybody's stage, which is what the prototype's array index does.
   */
  @Prop({ type: Number, required: true })
  stageOrder!: number;

  @Prop({ type: Number, required: true })
  displayOrder!: number;

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active' })
  status!: 'active' | 'archived';
}

export const CapabilityStageRowSchema = SchemaFactory.createForClass(CapabilityStageRow);

@Schema({ _id: false })
export class CapabilityGridRow {
  @Prop({ type: String, required: true })
  code!: string;

  @Prop({ type: String, required: true, trim: true })
  label!: string;

  /** Grids 3 and 4 render N/A for somebody with no downline; the prototype disables them. */
  @Prop({ type: Boolean, default: false })
  requiresDownline!: boolean;

  @Prop({ type: Number, required: true })
  displayOrder!: number;

  @Prop({ type: [CapabilityEntrySchema], default: [] })
  items!: CapabilityEntry[];

  @Prop({ type: String, enum: ['active', 'archived'], default: 'active' })
  status!: 'active' | 'archived';
}

export const CapabilityGridRowSchema = SchemaFactory.createForClass(CapabilityGridRow);

/**
 * One office's capability catalog (P5-T8, ADR-0025, ADR-0036).
 *
 * **One document per office**, because the three lists are read and rendered together and an
 * assessment binds to the **item codes** inside rather than to a version of the whole. The office
 * owns its copy: it renames, reorders, adds and archives, and it never deletes.
 *
 * One catalog per office is what makes two leaders' assessments comparable. A grid each leader
 * could extend is a grid nobody can roll up (ADR-0036).
 */
@Schema({ ...configSchemaOptions, collection: 'capabilityCatalogs' })
export class CapabilityCatalog {
  /**
   * No `index: true` here: the unique index below is already `kpmId_1`, and declaring both asks
   * Mongo for two indexes of one name — which fails at startup, not at write time.
   */
  @Prop({ type: String, required: true })
  kpmId!: string;

  @Prop({ type: [CapabilityStageRowSchema], default: [] })
  stages!: CapabilityStageRow[];

  @Prop({ type: [CapabilityEntrySchema], default: [] })
  milestones!: CapabilityEntry[];

  @Prop({ type: [CapabilityGridRowSchema], default: [] })
  grids!: CapabilityGridRow[];

  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const CapabilityCatalogSchema = SchemaFactory.createForClass(CapabilityCatalog);

/** One catalog per office: two would make two leaders' assessments incomparable. */
CapabilityCatalogSchema.index(
  { kpmId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/**
 * The scoped read's own filter, leading with `kpmId` (invariant §1).
 *
 * The unique index above is single-field, so it does not serve the `{kpmId, deletedAt}` shape every
 * repository read uses — and an index that does not lead with `kpmId` invites a plan that scans
 * across tenants, which is the whole reason the convention exists.
 */
CapabilityCatalogSchema.index({ kpmId: 1, deletedAt: 1 });
