import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';
import { DEFAULT_CURRENCY, DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';

export type CompanyDocument = HydratedDocument<Company>;

/**
 * **What a company is** (ADR-0164 §1): an `insurer`, which people register under and offices belong to,
 * or the one `template` company, the *Template library*, which holds the platform's templates and nothing
 * else.
 */
export const COMPANY_KINDS = ['insurer', 'template'] as const;
export type CompanyKind = (typeof COMPANY_KINDS)[number];

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

  /**
   * **An insurer, or the Template library** (ADR-0164 §1). Every company `POST /admin/companies` makes is
   * an insurer; the one `template` company is made by migration `0037` and by nothing else. Migration
   * `0036` writes `insurer` on every company that predates the field, so a raw read never meets it absent.
   *
   * A `template` company is not an insurer anybody works for: registration and KPM creation refuse it, and
   * the lists that mean *the insurers* leave it out (`INSURERS_ONLY`, `template-library.ts`).
   */
  @Prop({ type: String, enum: COMPANY_KINDS, required: true, default: 'insurer' })
  kind!: CompanyKind;

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
