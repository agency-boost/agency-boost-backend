import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type ActivationTemplateDocument = HydratedDocument<ActivationTemplate>;

/** One item of one aspect. `autoLink` is `null` for an item a leader ticks. */
@Schema({ _id: false })
export class ActivationItem {
  /** `FIRST_CASE_CLOSED`. A hire's progress names it by this, so it never changes or is reused. */
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  @Prop({ type: String, required: true, trim: true })
  label!: string;

  /** Within its aspect. Presentation only — nothing binds to it (invariant §4). */
  @Prop({ type: Number, required: true })
  displayOrder!: number;

  /** `feature:goals`, `training:PROSPECT_LIST`, or `null` for a manual item. */
  @Prop({ type: String, default: null, trim: true })
  autoLink!: string | null;
}

export const ActivationItemSchema = SchemaFactory.createForClass(ActivationItem);

/** One of the checklist's sections — the prototype's *1. Introduction* and its four siblings. */
@Schema({ _id: false })
export class ActivationAspect {
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  code!: string;

  @Prop({ type: String, required: true, trim: true })
  label!: string;

  @Prop({ type: Number, required: true })
  displayOrder!: number;

  @Prop({ type: [ActivationItemSchema], default: [] })
  items!: ActivationItem[];
}

export const ActivationAspectSchema = SchemaFactory.createForClass(ActivationAspect);

/**
 * An office's 90-day activation checklist, **versioned whole** (P5-T3).
 *
 * **Not rows, and not in the office's snapshot.** Every other office setting is rows published
 * through `configSnapshots`; this is one document with immutable published versions, because a
 * hire's `activationProgress` pins `(templateId, templateVersion)` at creation. A checklist edited
 * in March must not move the denominator of somebody who started in February, and a pin is only
 * worth having if what it points at cannot change.
 *
 * The draft row **becomes** the published row when it is published, as a company template's does:
 * the id the Owner has been editing is the id hires will record, and two rows where one will do is
 * a second place for them to disagree.
 */
@Schema({ ...configSchemaOptions, collection: 'activationTemplates' })
export class ActivationTemplate {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** 1, 2, 3… A draft carries the version it *will* be, so the screen can say so. */
  @Prop({ type: Number, required: true })
  version!: number;

  @Prop({ type: String, enum: ['draft', 'published'], default: 'draft', index: true })
  status!: 'draft' | 'published';

  @Prop({ type: Date, default: null })
  publishedAt!: Date | null;

  @Prop({ type: [ActivationAspectSchema], default: [] })
  aspects!: ActivationAspect[];

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const ActivationTemplateSchema = SchemaFactory.createForClass(ActivationTemplate);

/** One row per version per office — the draft included, since it holds the version it will become. */
ActivationTemplateSchema.index(
  { kpmId: 1, version: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);

/** The two reads: this office's draft, and its newest published version. */
ActivationTemplateSchema.index({ kpmId: 1, status: 1, version: -1 });
