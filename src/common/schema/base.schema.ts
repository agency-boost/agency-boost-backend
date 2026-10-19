import { Prop, Schema } from '@nestjs/mongoose';
import { SchemaOptions } from 'mongoose';

/**
 * Shared options for every document. Timestamps are automatic; `_id` stays an ObjectId.
 */
export const baseSchemaOptions: SchemaOptions = {
  timestamps: true,
  versionKey: 'version',
};

/**
 * Options for **published configuration**, where `version` is the domain's word.
 *
 * `domain-invariants.md` §3 requires every configuration collection to carry "a
 * monotonically increasing `version`" — the number an office's taxonomy is *at*, bumped
 * when somebody publishes a change. `baseSchemaOptions` has already spent that name on
 * Mongoose's optimistic-concurrency counter, and Mongoose will happily accept both: it
 * keeps the declared path and writes its own counter into the same field. The domain
 * number would then move whenever Mongoose felt like moving it.
 *
 * So configuration hands the internal counter back its default name and keeps `version`
 * for the meaning the rule gives it. Two numbers, two fields, neither pretending to be
 * the other.
 */
export const configSchemaOptions: SchemaOptions = {
  timestamps: true,
  versionKey: '__v',
};

/**
 * Fields every tenant-scoped document carries.
 *
 * `kpmId` is required and leads every compound index — a scoped index that does not
 * start with it invites a plan that scans across tenants
 * (docs/02-specs/data-model/multi-tenancy-and-scoping.md).
 */
@Schema({ ...baseSchemaOptions })
export abstract class TenantScopedEntity {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** Soft delete. Nothing in this product is hard-deleted. */
  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  /** Membership id of the actor, never a userId and never a name. */
  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

/**
 * Per-user documents additionally key on the membership, because identity is global
 * and participation is tenant-scoped. A person who leaves and rejoins gets a new
 * membership, and their history stays with the tenant that owns it.
 */
@Schema({ ...baseSchemaOptions })
export abstract class MemberScopedEntity extends TenantScopedEntity {
  @Prop({ type: String, required: true, index: true })
  membershipId!: string;
}
