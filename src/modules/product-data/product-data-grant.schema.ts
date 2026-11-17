import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type ProductDataGrantDocument = HydratedDocument<ProductDataGrant>;

/**
 * ***Kelola data produk*, given to one person for chosen insurers** (ADR-0260 §1; P19.15-T4 AC-2; the P1b spec's
 * *Giving access*, its `user_permission` row).
 *
 * **Keyed by the global `userId`, not a membership, and carrying no `kpmId`.** What it grants is a company's data —
 * the insurer's premium tables, rules and illustrations, which every office of that company reads alike — and no
 * office owns that. A membership id would tie it to one office's record of the person, which is not what the Super
 * Admin chose; `kpmId` would scope it to an office that has no say in it. **Only a KPM Owner or a KPM Admin holds it**,
 * and only while they are one: `ContextResolver` reads it for an active Owner or Admin alone, and `holds` checks the
 * role again (`permissions.ts`, the `grant` grantee).
 *
 * **One live grant per person** (the partial unique index): its companies change in place, audited before and after;
 * removing it writes `revokedAt` and `revokedBy` and keeps the row. Giving it again after a removal is a new row.
 * Nothing is hard-deleted (invariant §6); `deletedAt` is erasure's, never the removal's.
 */
@Schema({ ...baseSchemaOptions, collection: 'productDataGrants' })
export class ProductDataGrant {
  /** The person — `users._id` as a string. */
  @Prop({ type: String, required: true })
  userId!: string;

  /** The insurer companies ticked — `companies._id` as strings, at least one while the grant is live. */
  @Prop({ type: [String], required: true })
  companyIds!: string[];

  /** The Super Admin who gave it, and when — the first time; a change of companies is the audit log's. */
  @Prop({ type: String, required: true })
  grantedBy!: string;

  @Prop({ type: Date, required: true })
  grantedAt!: Date;

  /** Who last changed its companies, and when; `null` until somebody does. */
  @Prop({ type: String, default: null })
  updatedBy!: string | null;

  /** Removed: from this moment it grants nothing. `null` while live. */
  @Prop({ type: Date, default: null })
  revokedAt!: Date | null;

  @Prop({ type: String, default: null })
  revokedBy!: string | null;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;
}

export const ProductDataGrantSchema = SchemaFactory.createForClass(ProductDataGrant);

/*
 * One live grant per person: a second live row for the same person is a duplicate key, which a grant racing another
 * answers by changing the first. Partial on `revokedAt: null` and `deletedAt: null`, so every removed grant stays.
 * What `ContextResolver` reads on each Owner's and Admin's request, by `userId` alone.
 */
ProductDataGrantSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { revokedAt: null, deletedAt: null } },
);
/* The Super Admin's list of live grants, and every person who ever held one for *Perubahan oleh pengelola*. */
ProductDataGrantSchema.index({ revokedAt: 1, deletedAt: 1, grantedAt: -1 });
