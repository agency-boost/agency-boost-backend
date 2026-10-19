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
