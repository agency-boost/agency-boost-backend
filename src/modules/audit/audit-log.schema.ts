import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type AuditLogDocument = HydratedDocument<AuditLog>;

/**
 * Append-only. Never updated, never deleted, never rotated with operational logs —
 * it is business evidence, not telemetry.
 *
 * Under impersonation both actors are recorded: `actorUserId` is the real Super Admin,
 * `effectiveUserId` is who they acted as.
 */
@Schema({ ...baseSchemaOptions, collection: 'auditLog' })
export class AuditLog {
  /** Null for platform-level actions that belong to no tenant. */
  @Prop({ type: String, default: null, index: true })
  kpmId!: string | null;

  @Prop({ type: String, required: true })
  actorUserId!: string;

  @Prop({ type: String, default: null })
  effectiveUserId!: string | null;

  @Prop({ type: String, default: null })
  actorMembershipId!: string | null;

  /** Dotted verb: `goal.override`, `upload.commit`, `member.role_changed`. */
  @Prop({ type: String, required: true, index: true })
  action!: string;

  @Prop({ type: String, required: true })
  targetCollection!: string;

  @Prop({ type: String, default: null })
  targetId!: string | null;

  @Prop({ type: String, default: null })
  targetMembershipId!: string | null;

  @Prop({ type: Object, default: null })
  before!: Record<string, unknown> | null;

  @Prop({ type: Object, default: null })
  after!: Record<string, unknown> | null;

  /** True when a leader or admin acted on someone else's record. */
  @Prop({ type: Boolean, default: false })
  onBehalfOf!: boolean;

  @Prop({ type: String, default: null })
  ip!: string | null;

  @Prop({ type: String, default: null })
  userAgent!: string | null;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
AuditLogSchema.index({ kpmId: 1, createdAt: -1 });
/**
 * **The audit page's order, straight off the index** (P19.2-T2 AC-6; §B.32): newest first with ties broken by id, which
 * is what the cursor names — so a page reads in the index's order rather than sorting every row of a scope in memory.
 */
AuditLogSchema.index({ kpmId: 1, createdAt: -1, _id: -1 });
AuditLogSchema.index({ kpmId: 1, targetCollection: 1, targetId: 1 });
AuditLogSchema.index({ kpmId: 1, actorMembershipId: 1, createdAt: -1 });
