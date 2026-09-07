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

  @Prop({ type: String, required: true, lowercase: true, trim: true })
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

/**
 * Unique among the **living**, like every other unique index in this codebase
 * (`invite-code`, `join-request`, `group`, `membership`, `kpm-request`). A bare
 * `unique: true` let a soft-deleted company hold its slug for ever, which invariant 6
 * says nothing may do — deleting is disabling, not erasing, and it must not reserve a
 * name nobody can see.
 */
CompanySchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
