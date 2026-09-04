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
