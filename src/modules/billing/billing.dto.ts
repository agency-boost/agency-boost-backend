import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn, IsInt, IsMongoId, IsOptional, IsString, Matches, MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { SUBSCRIPTION_PLANS, type SubscriptionPlan } from '@/domain/constants';
import { field } from '@/common/validation/violations';
import { BILLING_REFUSALS } from './billing.messages';

const SAY = BILLING_REFUSALS.VALIDATION_FAILED;

/** How `GET /admin/billing/kpms` may be ordered: by a column of the list (ADR-0211 §3). */
export const BILLING_KPM_SORTS = ['kpm', 'company', 'leaders', 'tier', 'plan', 'renewal', 'status'] as const;
export type BillingKpmSort = (typeof BILLING_KPM_SORTS)[number];

/** `GET /admin/billing/kpms?companyId=&sort=&dir=` (ADR-0211 §3). Every field optional; anything else is refused. */
export class BillingKpmsQueryDto {
  @ApiPropertyOptional({ description: 'Only this company’s KPMs. An id that is not a company’s answers an empty list.' })
  @IsOptional()
  @IsMongoId()
  companyId?: string;

  @ApiPropertyOptional({
    enum: BILLING_KPM_SORTS,
    description: 'The column to order by: `kpm` (the code, the default), `company`, `leaders`, `tier`, `plan`, '
      + '`renewal` (an office with none last) or `status`.',
  })
  @IsOptional()
  @IsIn(BILLING_KPM_SORTS)
  sort?: BillingKpmSort;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], description: 'Ascending by default.' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  dir?: 'asc' | 'desc';
}

/** The manual override, normalised by the browser: a percent as decimal digits, or an amount in sen. */
export class QuoteDiscountDto {
  @ApiProperty({ enum: ['percent', 'flat'] })
  @IsIn(['percent', 'flat'], { message: field(SAY.discountType) })
  type!: 'percent' | 'flat';

  @ApiPropertyOptional({
    example: '10.5',
    description: 'With `percent`: from 0 to 100, a `.` before any decimals — the browser reads a typed comma as one.',
  })
  @ValidateIf((o: QuoteDiscountDto) => o.type === 'percent')
  @IsString({ message: field(SAY.percent) })
  @Matches(/^\d{1,3}(?:\.\d{1,4})?$/, { message: field(SAY.percent) })
  percent?: string;

  @ApiPropertyOptional({
    example: 2_500_000,
    description: 'With `flat`: per leader per month, IDR minor units (sen), whole rupiah, from 0 to the plan’s rate.',
  })
  @ValidateIf((o: QuoteDiscountDto) => o.type === 'flat')
  @IsInt({ message: field(SAY.amount) })
  @Min(0, { message: field(SAY.amount) })
  amountMinor?: number;
}

/**
 * **`POST /admin/tenants/:kpmId/quote`** (ADR-0211 §5): the calculator's inputs and the dialog's fields. **No figure**:
 * the server prices the quote from these (`price-quote.ts`), so a total the browser worked out is never trusted.
 */
export class SendQuoteDto {
  @ApiProperty({ example: 8, minimum: 1, description: 'The leaders priced — the KPM’s leaders used, or as typed.' })
  @IsInt({ message: field(SAY.leaders) })
  @Min(1, { message: field(SAY.leaders) })
  leaders!: number;

  @ApiProperty({ enum: SUBSCRIPTION_PLANS, description: '*6 bulan* (`six_months`) or *Tahunan* (`annual`).' })
  @IsIn(SUBSCRIPTION_PLANS, { message: field(SAY.plan) })
  plan!: SubscriptionPlan;

  @ApiPropertyOptional({ type: QuoteDiscountDto, nullable: true, description: 'The manual override; absent or null, none.' })
  @IsOptional()
  @ValidateNested()
  @Type(() => QuoteDiscountDto)
  discount?: QuoteDiscountDto | null;

  @ApiProperty({ example: '2026-11-12', description: '*Tanggal mulai*, an office date, YYYY-MM-DD.' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: field(SAY.date) })
  startDate!: string;

  @ApiProperty({ example: '2027-05-11', description: '*Tanggal berakhir*, on or after the start.' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: field(SAY.date) })
  endDate!: string;

  @ApiProperty({ example: 'Andi Wijaya', description: '*Nama PIC* — the Owner’s name, filled in; as typed.' })
  @IsString()
  @MinLength(1, { message: field(SAY.name) })
  @MaxLength(120)
  pic!: string;

  @ApiProperty({ example: 'Maya', description: '*Diisi oleh sales*, as typed.' })
  @IsString()
  @MinLength(1, { message: field(SAY.name) })
  @MaxLength(120)
  salesBy!: string;
}
