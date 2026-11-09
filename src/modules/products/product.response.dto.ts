import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PRODUCT_CATEGORIES, PRODUCT_CHANNELS, PRODUCT_CURRENCIES, PRODUCT_KINDS, PRODUCT_LIFECYCLES, PRODUCT_NEEDS,
  PROPOSAL_DEFAULT_INSURED,
} from '@/domain/constants';
import {
  CommissionYearDto, DefaultAttackPlanDto, FaqEntryDto, PdfDetailBlockDto, PlanOptionDto, ProposalFieldDto,
} from './product.dto';

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

  @ApiProperty({ type: String, enum: PRODUCT_KINDS, description: '*Produk dasar* or *Rider* (ADR-0209 §1).' })
  kind!: string;

  @ApiProperty({
    type: [String],
    description: 'A rider\'s base products, by id; `[]` for a base. Empty on a rider is a rider no base offers: '
      + 'hidden from agents, and the screen says *"Rider ini tidak terpasang ke produk aktif mana pun"*.',
  })
  attachesTo!: string[];

  @ApiProperty({ type: [String], enum: PRODUCT_CURRENCIES, description: 'The currencies it is sold in, `IDR` first.' })
  currencies!: string[];

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

  @ApiProperty({ type: DefaultAttackPlanDto })
  defaultAttackPlan!: DefaultAttackPlanDto;

  @ApiPropertyOptional({
    type: [CommissionYearDto],
    description:
      'Left out entirely for a reader without `commission_rates:read` (ADR-0038) — not sent and '
      + 'hidden. Empty where the company has stated no schedule; nothing is ever defaulted (F-15).',
  })
  commissionSchedule?: CommissionYearDto[];

  @ApiProperty({
    type: [ProposalFieldDto],
    description: 'The proposal panel\'s fields, in order, each with every flag (ADR-0225 §1). `[]` until set.',
  })
  proposalFields!: ProposalFieldDto[];

  @ApiProperty({ type: [PlanOptionDto], description: 'The plan cards, cheapest first. `[]` until set.' })
  planOptions!: PlanOptionDto[];

  @ApiProperty({ type: [FaqEntryDto], description: 'The company\'s *Tanya-jawab*. `[]` until set.' })
  faq!: FaqEntryDto[];

  @ApiProperty({ type: [PdfDetailBlockDto], description: 'Page 2\'s detail blocks, with their sources. `[]` until set.' })
  pdfDetail!: PdfDetailBlockDto[];

  @ApiProperty({ type: String, nullable: true })
  syariahName!: string | null;

  @ApiProperty({
    type: String, enum: PROPOSAL_DEFAULT_INSURED, nullable: true,
    description: 'As stored; `null` reads the category\'s — *Anak* for `education`, *Klien* for the rest.',
  })
  defaultInsured!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'As stored; `null` reads the category\'s label.' })
  proposalTypeLabel!: string | null;

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
