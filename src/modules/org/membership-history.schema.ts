import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import { HierarchyRole } from './membership.schema';

export type MembershipHistoryDocument = HydratedDocument<MembershipHistory>;

/**
 * **The hierarchy's events: who the member reports to, on which rung, and whether they are here.**
 *
 * One edge at a time. A membership has at most one of these rows open (`validTo: null`), and it is
 * the current edge (roles §6.1, `domain-invariants.md` §5): opening the next closes every one still
 * open, whichever event opened it (`MembershipHistoryRepository.openEdge`, P11-T3).
 */
export const EDGE_EVENTS = ['joined', 'role_changed', 're_parented', 'removed', 'reinstated'] as const;

/**
 * **Admin rights, a second chain beside the edges** (P3-T10 AC-2: independent of the hierarchy
 * role). A grant changes no leader and no rung, so it neither closes an edge nor is closed by one:
 * `AdminDelegationService` closes its own. A removal closes both.
 */
export const ADMIN_EVENTS = ['admin_granted', 'admin_revoked'] as const;

export type EdgeEvent = (typeof EDGE_EVENTS)[number];
export type MembershipEvent = EdgeEvent | (typeof ADMIN_EVENTS)[number];

/**
 * Append-only. Nothing is deleted, and closing a row is the one update: it writes `validTo`.
 *
 * Written from the first commit that can create a membership, not from the commit that
 * builds the screen showing it: history cannot be reconstructed after the fact
 * (`domain-invariants.md` §5). The Role change log and the Removed tab arrive in P3-T6
 * and P3-T7 and will read rows that already exist.
 *
 * The current edge is the row with `validTo: null`, and there is one (`EDGE_EVENTS`). Closing
 * one writes `validTo`; it never overwrites.
 *
 * **`to*` is where the row leaves the member**, so the open edge states all of it: a re-parent
 * carries the rung the member keeps, and a role change the leader they keep. `from*` is what the
 * event changed, and only that. Rows written before P11-T3 carry only what changed.
 */
@Schema({ ...baseSchemaOptions, collection: 'membershipHistory' })
export class MembershipHistory {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true, index: true })
  membershipId!: string;

  @Prop({
    type: String,
    enum: [...EDGE_EVENTS, ...ADMIN_EVENTS],
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
