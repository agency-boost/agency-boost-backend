import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type MembershipDocument = HydratedDocument<Membership>;

export type HierarchyRole = 'ab' | 'aab' | 'agent';
export type MembershipStatus = 'active' | 'pending' | 'removed';

/** Delegated tenant-admin rights. Orthogonal to hierarchy role — an AB may hold them. */
export class AdminAccess {
  isKpmAdmin!: boolean;
  grantedByUserId!: string | null;
  grantedAt!: Date | null;
  revokedAt!: Date | null;
}

/**
 * Participation in one office.
 *
 * Identity is global and participation is tenant-scoped, so this — not `users` — is what
 * every per-user document points at. `membershipId` is the foreign key; `userId` is not,
 * and neither is a name (`domain-invariants.md` §2). A person who leaves and rejoins
 * gets a new membership, and their history stays with the tenant that owns it.
 */
@Schema({ ...baseSchemaOptions, collection: 'memberships' })
export class Membership {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true, index: true })
  userId!: string;

  /**
   * `KPM0417-001`. Server-issued from the tenant counter and immutable: the monthly
   * production import joins on it, so changing one silently breaks the attribution of
   * every row already imported under the old value.
   *
   * Unique within the office, not globally — two offices may both have a `-001`.
   */
  @Prop({ type: String, required: true })
  agentCode!: string;

  /**
   * The sequence inside the code, kept as a number because the roster orders by it.
   *
   * Ordering on the string breaks at four digits: `KPM0417-1000` sorts before
   * `KPM0417-999`, which would silently reorder the directory and — worse — make the
   * cursor skip rows, since the cursor is a `$gt` on the sort key. Padding wide enough
   * to hide it would change a format the prototype already shows to users.
   */
  @Prop({ type: Number, required: true })
  agentSeq!: number;

  @Prop({ type: String, enum: ['ab', 'aab', 'agent'], required: true })
  role!: HierarchyRole;

  /** → `memberships._id`. Null for a top-level AB. */
  @Prop({ type: String, default: null, index: true })
  leaderId!: string | null;

  /** Materialised, root-first, excluding self. Multikey-indexed — the descendant query. */
  @Prop({ type: [String], default: [] })
  ancestorIds!: string[];

  @Prop({ type: Number, default: 0 })
  depth!: number;

  /**
   * Caches, rebuilt on re-parenting. `total` is what makes someone a leader (OD-23) —
   * the role does not.
   */
  @Prop({ type: Object, default: () => ({ ab: 0, aab: 0, agent: 0, total: 0 }) })
  directCounts!: { ab: number; aab: number; agent: number; total: number };

  @Prop({ type: Number, default: 0 })
  subtreeCount!: number;

  @Prop({ type: String, enum: ['active', 'pending', 'removed'], default: 'pending', index: true })
  status!: MembershipStatus;

  @Prop({ type: Date, default: null })
  joinedAt!: Date | null;

  @Prop({ type: Date, default: null })
  removedAt!: Date | null;

  @Prop({ type: Boolean, default: false })
  isCoreLeader!: boolean;

  @Prop({ type: [String], default: [] })
  groupIds!: string[];

  @Prop({
    type: Object,
    default: () => ({ isKpmAdmin: false, grantedByUserId: null, grantedAt: null, revokedAt: null }),
  })
  adminAccess!: AdminAccess;

  /** Who brought them in, and from which recruitment lead. Attribution, set at join. */
  @Prop({ type: String, default: null })
  recruitedByMembershipId!: string | null;

  @Prop({ type: String, default: null })
  sourceLeadId!: string | null;

  @Prop({ type: Date, default: null })
  activationGraduatedAt!: Date | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const MembershipSchema = SchemaFactory.createForClass(Membership);

/** `kpmId` leads every index — a scoped index that does not invites a cross-tenant scan. */
MembershipSchema.index({ kpmId: 1, agentCode: 1 }, { unique: true });

/**
 * At most one live membership per person per office, enforced by the database rather
 * than a read-then-write two concurrent joins would race past. `removed` rows are
 * exempt: re-joining creates a new membership and the old one stays (P3-T7).
 */
MembershipSchema.index(
  { kpmId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['active', 'pending'] } } },
);

MembershipSchema.index({ kpmId: 1, leaderId: 1, status: 1 });
/** The descendant query — the most common in the product, behind every rollup. */
MembershipSchema.index({ kpmId: 1, ancestorIds: 1, status: 1 });
MembershipSchema.index({ kpmId: 1, status: 1, agentSeq: 1 });
