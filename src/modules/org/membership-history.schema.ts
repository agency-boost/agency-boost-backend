import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import { HierarchyRole } from './membership.schema';

export type MembershipHistoryDocument = HydratedDocument<MembershipHistory>;

export type MembershipEvent =
  | 'joined'
  | 'role_changed'
  | 're_parented'
  | 'removed'
  | 'reinstated'
  | 'admin_granted'
  | 'admin_revoked';

/**
 * Append-only. Nothing updates or deletes a row here.
 *
 * Written from the first commit that can create a membership, not from the commit that
 * builds the screen showing it: history cannot be reconstructed after the fact
 * (`domain-invariants.md` §5). The Role change log and the Removed tab arrive in P3-T6
 * and P3-T7 and will read rows that already exist.
 *
 * The current edge is the row with `validTo: null`. Closing one writes `validTo`; it
 * never overwrites.
 */
@Schema({ ...baseSchemaOptions, collection: 'membershipHistory' })
export class MembershipHistory {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true, index: true })
  membershipId!: string;

  @Prop({
    type: String,
    enum: ['joined', 'role_changed', 're_parented', 'removed', 'reinstated', 'admin_granted', 'admin_revoked'],
    required: true,
  })
  eventType!: MembershipEvent;

  @Prop({ type: String, default: null })
  fromRole!: HierarchyRole | null;

  @Prop({ type: String, default: null })
  toRole!: HierarchyRole | null;

  /**
   * The rungs the role names referred to **at the time** (P3.5-T8 AC-3).
   *
   * `fromRole`/`toRole` are labels, and a label is renameable: a company that renames
   * `AAB` to *Associate Agency Business* would otherwise leave every past promotion
   * describing a rung by a name that no longer exists. The reference survives the rename,
   * so a history row stays legible after it.
   *
   * Nullable because rows written before this existed have none, and backfilling history
   * would be inventing a fact rather than recording one.
   */
  @Prop({ type: String, default: null })
  fromOrgLevelId!: string | null;

  @Prop({ type: String, default: null })
  toOrgLevelId!: string | null;

  @Prop({ type: String, default: null })
  fromLeaderId!: string | null;

  @Prop({ type: String, default: null })
  toLeaderId!: string | null;

  @Prop({ type: Date, required: true })
  validFrom!: Date;

  /** Null means current. Writing it closes the edge; the row is never deleted. */
  @Prop({ type: Date, default: null })
  validTo!: Date | null;

  /** Membership id of whoever acted — never a userId, never a name. */
  @Prop({ type: String, default: null })
  actorMembershipId!: string | null;

  /** Set when a Super Admin acted through impersonation, so attribution survives. */
  @Prop({ type: String, default: null })
  actorUserId!: string | null;

  @Prop({ type: String, default: null })
  reason!: string | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

export const MembershipHistorySchema = SchemaFactory.createForClass(MembershipHistory);

MembershipHistorySchema.index({ kpmId: 1, membershipId: 1, validFrom: -1 });
/** The as-of-date query: rows live at time T (P3-T2 AC-5). */
MembershipHistorySchema.index({ kpmId: 1, eventType: 1, validFrom: -1 });
