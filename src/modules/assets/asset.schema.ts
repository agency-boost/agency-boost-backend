import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type AssetDocument = HydratedDocument<Asset>;

/**
 * The central registry for every uploaded file.
 *
 * Without it, Cloudinary references scatter across training modules, product documents,
 * event posters, coaching exports and upload batches — and there is no way to find an
 * orphan, account for storage per tenant, or prove a file was scanned.
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

  @Prop({ type: String, enum: ['pending', 'clean', 'infected'], default: 'pending' })
  scanStatus!: 'pending' | 'clean' | 'infected';

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;
}

export const AssetSchema = SchemaFactory.createForClass(Asset);
AssetSchema.index({ kpmId: 1, createdAt: -1 });
AssetSchema.index({ kpmId: 1, refCount: 1, createdAt: 1 });
