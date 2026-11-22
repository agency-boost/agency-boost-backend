import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsMongoId, IsString, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { field } from '@/common/validation/violations';
import { TENANTS_REFUSALS } from './tenants.messages';

/** Where a new company starts (ADR-0278 §3): the Default template, or a copy of another company. */
export const COMPANY_STARTS = ['default', 'company'] as const;
export type CompanyStart = (typeof COMPANY_STARTS)[number];

/** `POST /admin/companies/setup` (P19.23-T4 AC-1; ADR-0278 §3): *Perusahaan baru*. */
export class SetUpCompanyDto {
  @ApiProperty({ example: 'AIA Financial', minLength: 2, maxLength: 120 })
  @IsString() @MinLength(2) @MaxLength(120)
  name!: string;

  @ApiProperty({
    example: 'aia-financial',
    maxLength: 64,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    description: 'Derived from the name by the console. A clash is refused with COMPANY_SLUG_TAKEN, naming the company.',
  })
  @IsString() @MaxLength(64)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: field(TENANTS_REFUSALS.VALIDATION_FAILED.slugShape) })
  slug!: string;

  @ApiProperty({
    enum: COMPANY_STARTS,
    description: '*Mulai dari*: `default` — the Default template (the Template library): its ladder, carrier rules and '
      + 'default template; `company` — another company’s ladder, carrier rules and default template. Never products.',
  })
  @IsIn(COMPANY_STARTS as unknown as string[])
  from!: CompanyStart;

  @ApiPropertyOptional({ description: 'With `from: company`: the company copied. Required then; ignored otherwise.' })
  @ValidateIf((o: SetUpCompanyDto) => o.from === 'company')
  @IsMongoId()
  fromCompanyId?: string;
}
