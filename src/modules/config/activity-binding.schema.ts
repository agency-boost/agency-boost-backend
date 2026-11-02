import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type ActivityBindingDocument = HydratedDocument<ActivityBinding>;

/**
 * **Which of the office's activity types each cascade role counts** (ADR-0163 §1) — one row per office.
 *
 * The three roles are the goal cascade's columns, in the client's words *Set appointment* (`leads`),
 * *Sales meeting* (`appointments`) and *Submission polis* (`closings`). Each holds a **list** of activity
 * type codes, and a role's count is the sum over its list: replacing an activity is `[A]` → `[A, B]`, so
 * the old code's history keeps counting for the periods it was logged in and the new one counts from now.
 *
 * - **By code, never by position** (invariant §4). A code must be one of the office's activity types; it
 *   may be archived, because its history still counts, but never unknown.
 * - **Config** (invariant §3): a `version` bumped on every write, `status` and `archivedAt` like every
 *   configuration row, and carried in each published snapshot (`TenantConfigView.activityBinding`).
 * - **Kept by the Super Admin**, per office (`PUT /admin/tenants/:kpmId/activity-binding`), and copied
 *   from the template's `activity_taxonomy` payload when an office is provisioned. The Owner and the
 *   Admin read it; neither writes it.
 *
 * `ActivityBindingService.resolveCascadeBinding` is the one reader every count goes through.
 */
@Schema({ ...configSchemaOptions, collection: 'activityBindings' })
export class ActivityBinding {
  // Indexed by the compound index below, which leads with it.
  @Prop({ type: String, required: true })
  kpmId!: string;

  /** *Set appointment*: the codes the cascade's leads column counts. */
  @Prop({ type: [String], required: true, default: [] })
  leads!: string[];

  /** *Sales meeting*: the codes the appointments column counts. */
  @Prop({ type: [String], required: true, default: [] })
  appointments!: string[];

  /** *Submission polis*: the codes the closings column, and the pace sentence's *N*, count. */
  @Prop({ type: [String], required: true, default: [] })
  closings!: string[];

  /** The domain's version (invariant §3). See `configSchemaOptions`. */
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

export const ActivityBindingSchema = SchemaFactory.createForClass(ActivityBinding);

/**
 * **One active binding per office**, and the resolver's read: `{ kpmId, status: 'active', deletedAt: null }` on
 * every count. An archived row may sit beside it.
 */
ActivityBindingSchema.index(
  { kpmId: 1, status: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null, status: 'active' } },
);
