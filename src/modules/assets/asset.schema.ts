import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type AssetDocument = HydratedDocument<Asset>;

/**
 * The central registry for every uploaded file.
 *
 * Without it, Cloudinary references scatter across training modules, product documents,
 * event posters, coaching exports and upload batches — and there is no way to find an
 * orphan, account for storage per tenant, or say who uploaded what.
 */
@Schema({ ...baseSchemaOptions, collection: 'assets' })
export class Asset {
  /**
   * **A row has exactly one owner** (ADR-0032).
   *
   * `kpmId` set and `companyId` null — an office's own upload, read through the scoped
   * repository like every other tenant document.
   *
   * `companyId` set and `kpmId` null — the **company's** training material, written only by
   * Super Admin and shared by reference with every office of that company. It is not any
   * office's data, so it is read through an explicitly named unscoped method filtered by
   * company, never by the scoped repository. That is also what keeps the shared reference
   * compatible with erasure (ADR-0007): an office's erasure takes its own uploads and leaves
   * the company's material, which was never its to delete.
   */
  @Prop({ type: String, default: null, index: true })
  kpmId!: string | null;

  @Prop({ type: String, default: null, index: true })
  companyId!: string | null;

  /** Cloudinary public_id, including the tenant folder prefix. */
  @Prop({ type: String, required: true, unique: true })
  storageKey!: string;

  @Prop({ type: String, required: true })
  mimeType!: string;

  @Prop({ type: Number, required: true })
  bytes!: number;

  @Prop({ type: String, default: null })
  originalFilename!: string | null;

  /** Null for the company's material: a Super Admin is a member of no office (ADR-0032). */
  @Prop({ type: String, default: null })
  uploadedByMembershipId!: string | null;

  /** How many documents reference this asset. Zero for 30 days means it is an orphan. */
  @Prop({ type: Number, default: 0 })
  refCount!: number;

  /**
   * Whether the bytes are known to have arrived (ADR-0040).
   *
   * `pending` — a signature was issued and the browser may or may not have finished.
   * `confirmed` — storage was asked, the object is there, and `mimeType` and `bytes` above hold
   * what storage reported rather than what the client claimed.
   *
   * **This is not a malware check and never was one.** It replaced a `scanStatus` of
   * `pending | clean | infected` that nothing ever moved out of `pending`, so every upload was
   * permanently undeliverable while the schema told every reader the file had been inspected.
   * v1 does not scan; ADR-0040 records what stands in place of one, and what that accepts.
   */
  @Prop({ type: String, enum: ['pending', 'confirmed'], default: 'pending' })
  uploadState!: 'pending' | 'confirmed';

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;
}

export const AssetSchema = SchemaFactory.createForClass(Asset);
AssetSchema.index({ kpmId: 1, createdAt: -1 });
AssetSchema.index({ kpmId: 1, refCount: 1, createdAt: 1 });
/** The company's shared material, read by every office of that company (ADR-0032). */
AssetSchema.index({ companyId: 1, createdAt: -1 });

/**
 * Exactly one owner, enforced by the database rather than by every caller remembering.
 *
 * A row with both would be an office's file and a company's at once — deliverable to offices
 * that must not see it, and undeletable by the erasure that should take it. A row with
 * neither belongs to nobody and no scoped read would ever find it again.
 */
AssetSchema.pre('validate', function enforceOneOwner(next) {
  const doc = this as unknown as { kpmId: string | null; companyId: string | null };
  const owners = [doc.kpmId, doc.companyId].filter((v) => v !== null && v !== undefined);
  if (owners.length !== 1) {
    next(new Error(
      'An asset belongs to exactly one owner: a kpmId for an office\'s upload, or a companyId '
      + 'for the company\'s shared material (ADR-0032).',
    ));
    return;
  }
  next();
});
