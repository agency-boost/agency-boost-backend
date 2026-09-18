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
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  /** Cloudinary public_id, including the tenant folder prefix. */
  @Prop({ type: String, required: true, unique: true })
  storageKey!: string;

  @Prop({ type: String, required: true })
  mimeType!: string;

  @Prop({ type: Number, required: true })
  bytes!: number;

  @Prop({ type: String, default: null })
  originalFilename!: string | null;

  @Prop({ type: String, required: true })
  uploadedByMembershipId!: string;

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
