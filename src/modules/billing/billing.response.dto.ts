import { ApiProperty } from '@nestjs/swagger';
import type { BillingTier } from '@/domain/constants';

/** One tier of the price table, as `GET /admin/billing/prices` serves it. */
export class BillingTierDto implements BillingTier {
  @ApiProperty({
    type: String,
    example: 'TIER_1_10',
    description: 'The tier’s stable code. A tier is named by it, never by its position.',
  })
  code!: string;

  @ApiProperty({ type: Number, example: 1, description: 'The smallest leader count the tier prices, inclusive.' })
  minLeaders!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 10,
    description: 'The largest leader count the tier prices, inclusive; `null` for the open last tier.',
  })
  maxLeaders!: number | null;

  @ApiProperty({
    type: Number,
    example: 50_000_000,
    description: 'The standard rate per leader per month, in IDR minor units (sen). Shown struck through.',
  })
  standardMinor!: number;

  @ApiProperty({
    type: Number,
    example: 40_000_000,
    description: 'The six-month rate per leader per month, in IDR minor units (sen).',
  })
  sixMonthMinor!: number;

  @ApiProperty({
    type: Number,
    example: 38_000_000,
    description:
      'The annual rate per leader per month, in IDR minor units (sen): the six-month rate less ' +
      '`annualDiscountPct` percent, exactly.',
  })
  annualMinor!: number;

  @ApiProperty({
    type: Boolean,
    description: 'Shown publicly as “Custom pricing”: its card draws no rate.',
  })
  customPricing!: boolean;
}

/** The whole table: `GET /admin/billing/prices`. */
export class BillingPricesDto {
  @ApiProperty({ enum: ['IDR'], description: 'The currency of every rate.' })
  currency!: 'IDR';

  @ApiProperty({
    type: [BillingTierDto],
    description: 'Smallest leader count first. Together they cover every count from 1 up, without a gap.',
  })
  tiers!: BillingTierDto[];

  @ApiProperty({
    type: Number,
    example: 5,
    description: 'The annual rate’s discount off the six-month rate, in percent.',
  })
  annualDiscountPct!: number;
}

/** A tier as a row of the list names it: its code and its bounds. */
export class BillingKpmTierDto {
  @ApiProperty({ example: 'TIER_1_10' })
  code!: string;

  @ApiProperty({ example: 1 })
  minLeaders!: number;

  @ApiProperty({ type: Number, nullable: true, example: 10, description: '`null` for the open last tier.' })
  maxLeaders!: number | null;
}

/** A KPM's company, by id and name. */
export class BillingKpmCompanyDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'Prudential' })
  name!: string;
}

/** One KPM on `/admin/billing` (ADR-0211 §3): counts and codes, no member named. */
export class BillingKpmRowDto {
  @ApiProperty()
  kpmId!: string;

  @ApiProperty({ example: '0417' })
  code!: string;

  @ApiProperty({ example: 'Jakarta Selatan' })
  branch!: string;

  @ApiProperty({ type: BillingKpmCompanyDto })
  company!: BillingKpmCompanyDto;

  @ApiProperty({ example: 8, description: '*Leader*: the active members on a leader rung, the Owner included (ADR-0113).' })
  leadersUsed!: number;

  @ApiProperty({ type: BillingKpmTierDto, description: '*Tingkat*: the tier those leaders fall in; under one, the first.' })
  tier!: BillingKpmTierDto;

  @ApiProperty({ type: String, nullable: true, enum: ['six_months', 'annual'], description: '*Paket*; `null`, none.' })
  plan!: 'six_months' | 'annual' | null;

  @ApiProperty({
    type: String, nullable: true, example: '2027-04-30',
    description: '*Perpanjangan*: the subscription’s end date, the last day the office is served; `null`, none.',
  })
  renewalDate!: string | null;

  @ApiProperty({
    enum: ['active', 'ended', 'ended_kept_active', 'none'],
    description: '*Aktif*, *Berakhir*, *Berakhir — tetap aktif*, or *Belum ada langganan* (no end date).',
  })
  status!: 'active' | 'ended' | 'ended_kept_active' | 'none';
}

/** The server's figures for a sent quote, in IDR minor units. */
export class QuotePricingDto {
  @ApiProperty({ example: 8 }) leaders!: number;
  @ApiProperty({ example: 'TIER_1_10' }) tierCode!: string;
  @ApiProperty({ enum: ['six_months', 'annual'] }) plan!: 'six_months' | 'annual';
  @ApiProperty({ enum: [6, 12] }) months!: 6 | 12;
  @ApiProperty() standardMinor!: number;
  @ApiProperty({ description: 'The six-month rate, on either plan.' }) offerMinor!: number;
  @ApiProperty({ description: 'The plan’s rate before the manual discount.' }) baseMinor!: number;
  @ApiProperty() annualDiscountMinor!: number;
  @ApiProperty() manualDiscountMinor!: number;
  @ApiProperty({ description: 'The rate per leader per month, after every discount.' }) finalMinor!: number;
  @ApiProperty() monthlyTotalMinor!: number;
  @ApiProperty() periodTotalMinor!: number;
}

/** Who received the quote. */
export class QuoteRecipientDto {
  @ApiProperty({ example: 'Wulan Kartika' })
  fullName!: string;
}

/** `POST /admin/tenants/:kpmId/quote`: sent, to whom, and the figures the server sent. */
export class QuoteSentDto {
  @ApiProperty()
  kpmId!: string;

  @ApiProperty({ type: QuoteRecipientDto })
  recipient!: QuoteRecipientDto;

  @ApiProperty({ type: QuotePricingDto })
  pricing!: QuotePricingDto;
}
