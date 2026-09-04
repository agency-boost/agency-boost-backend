import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import { DEFAULT_CURRENCY, DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';

export type CompanyDocument = HydratedDocument<Company>;

/** The principal insurer a KPM operates under — Prudential in the prototypes. */
@Schema({ ...baseSchemaOptions, collection: 'companies' })
export class Company {
  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: String, required: true, unique: true, lowercase: true, trim: true })
  slug!: string;

  @Prop({ type: String, default: DEFAULT_CURRENCY })
  defaultCurrency!: string;

  @Prop({ type: String, default: 'id-ID' })
  defaultLocale!: string;

  @Prop({ type: String, default: DEFAULT_TENANT_TIMEZONE })
  defaultTimezone!: string;

  @Prop({ type: String, enum: ['active', 'suspended'], default: 'active' })
  status!: 'active' | 'suspended';

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;
}

export const CompanySchema = SchemaFactory.createForClass(Company);
