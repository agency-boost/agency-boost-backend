import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PRODUCT_CATEGORIES, PRODUCT_CHANNELS, PRODUCT_LIFECYCLES, PRODUCT_NEEDS } from '@/domain/constants';
import { AttackPlanDto, CommissionYearDto } from './product.dto';

/** One product of a company's shelf, as every route here returns it. */
export class ProductResponseDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  companyId!: string;

  @ApiProperty({ type: String, example: 'PRUMAPAN', description: 'The identity. Immutable, and unique within the company counting withdrawn rows.' })
  code!: string;

  @ApiProperty({ type: String, example: 'PRUMapan' })
  name!: string;

  @ApiProperty({ type: String })
  tagline!: string;

  @ApiProperty({ type: String, enum: PRODUCT_CHANNELS })
  channel!: string;

  @ApiProperty({ type: String, enum: PRODUCT_CATEGORIES })
  category!: string;

  @ApiProperty({ type: [String], enum: PRODUCT_NEEDS })
  primaryNeeds!: string[];

  @ApiProperty({ type: [Number] })
  eligibleAgeBands!: number[];

  @ApiProperty({ type: [Number] })
  eligibleBudgetBands!: number[];

  @ApiProperty({ type: [String] })
  benefits!: string[];

  @ApiProperty({ type: String })
  differentiator!: string;

  @ApiProperty({ type: String })
  bestFor!: string;

  @ApiProperty({ type: AttackPlanDto })
  defaultAttackPlan!: AttackPlanDto;

  @ApiPropertyOptional({
    type: [CommissionYearDto],
    description:
      'Left out entirely for a reader without `commission_rates:read` (ADR-0038) — not sent and '
      + 'hidden. Empty where the company has stated no schedule; nothing is ever defaulted (F-15).',
  })
  commissionSchedule?: CommissionYearDto[];

  @ApiProperty({ type: String, enum: PRODUCT_LIFECYCLES })
  lifecycle!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The successor, where a run-off product has one.' })
  replacedByProductId!: string | null;

  @ApiProperty({ type: Boolean, description: 'What an office sells before its Owner has an opinion (ADR-0033).' })
  activeByDefault!: boolean;

  @ApiProperty({ type: Number, description: 'Presentation. Reordering bumps no version.' })
  sortOrder!: number;

  @ApiProperty({ type: Number })
  version!: number;
}
