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

  /**
   * Whether this company started from the platform's own presets, or from nothing.
   *
   * **It is recorded rather than inferred, and it is read long after creation.** The eight
   * Company template kinds are not written at creation — `template.service.read()` hands back
   * `STARTING_PAYLOAD` for a kind nobody has authored yet, so a blank company would otherwise
   * show twelve activity types the moment a Super Admin opened the tab and have no way to say
   * it did not want them.
   *
   * False also means provisioning skipped the product catalog and the carrier's qualification
   * rules. It never skips the **role ladder**: `memberships.orgLevelId` resolves against it on
   * every join, so a company without one is an office nobody can join (ADR-0012 §3).
   */
  @Prop({ type: Boolean, required: true, default: true })
  usesPlatformDefaults!: boolean;

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
