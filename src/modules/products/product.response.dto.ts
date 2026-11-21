import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PRODUCT_CATEGORIES, PRODUCT_CHANNELS, PRODUCT_CURRENCIES, PRODUCT_KINDS, PRODUCT_LIFECYCLES, PRODUCT_NEEDS,
  PROPOSAL_CALC_TYPES, PROPOSAL_DEFAULT_INSURED, PROPOSAL_NEED_TAGS, PROPOSAL_PAY_FREQUENCIES,
} from '@/domain/constants';
import {
  CommissionYearDto, DefaultAttackPlanDto, EntryAgeDto, FaqEntryDto, PayTermDto, PdfDetailBlockDto, PlanOptionDto,
  PlanRuleDto, ProposalFieldDto,
} from './product.dto';
import type { ProductDraftView, ProductReleaseState } from './product-draft.service';
import type { ProductDraft } from './product.schema';

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

  @ApiProperty({ enum: PROPOSAL_CALC_TYPES, description: 'ADR-0255 §4. `manual` where none is stored.' })
  calcType!: string;

  @ApiProperty({ type: EntryAgeDto, nullable: true })
  entryAge!: EntryAgeDto | null;

  @ApiProperty({ type: [PayTermDto] })
  payTerms!: PayTermDto[];

  @ApiProperty({ enum: PROPOSAL_PAY_FREQUENCIES, isArray: true, description: 'As stored: `[]` reads the four periodic ones.' })
  frequencies!: string[];

  @ApiProperty({ type: Boolean })
  smokerRated!: boolean;

  @ApiProperty({ type: PlanRuleDto, nullable: true })
  planRule!: PlanRuleDto | null;

  @ApiProperty({ type: Number, nullable: true }) upStep!: number | null;
  @ApiProperty({ type: Number, nullable: true }) upMin!: number | null;
  @ApiProperty({ type: Number, nullable: true }) upMax!: number | null;
  @ApiProperty({ type: Number, nullable: true }) premiumMin!: number | null;
  @ApiProperty({ type: Number, nullable: true }) premiumMax!: number | null;

  @ApiProperty({ type: String, nullable: true, description: '`null` — every product until 19.15 — is `manual`.' })
  rateTableId!: string | null;

  @ApiProperty({ enum: PROPOSAL_NEED_TAGS, nullable: true, description: 'As stored; `null` reads its needs\' or category\'s.' })
  needTag!: string | null;

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

/** *Brosur / file*: the company's brochure for a product, by its label. */
export class ProductBrochureRefDto {
  @ApiProperty({ type: String, example: 'Brosur PRUMapan' })
  label!: string;
}

/**
 * **One product's draft and its release** (ADR-0278 §4): what *Produk & proposal* and *Terbitkan ke KPM* read, and what
 * saving or discarding a draft answers. `implements` the service's view, so the two cannot drift.
 */
export class ProductDraftDto implements ProductDraftView {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String, example: 'PRUMAPAN' })
  code!: string;

  @ApiProperty({ type: String, example: 'PRUMapan' })
  name!: string;

  @ApiProperty({
    enum: ['unpublished', 'draft', 'published'],
    description: '`unpublished`: a new product no KPM has yet. `draft`: published, with edits waiting. `published`: '
      + 'nothing waiting.',
  })
  state!: ProductReleaseState;

  @ApiProperty({
    type: Object, nullable: true,
    description: 'The edits waiting, by field — the product’s own fields and `alsoFits` — or `null` when none. A new '
      + 'product’s edits are the product itself, so it never has one.',
  })
  draft!: ProductDraft | null;

  @ApiProperty({
    type: [String], nullable: true,
    description: '`null`: every KPM of the company. A list: the KPMs it was published to; `[]` for a new product '
      + 'published to none yet.',
  })
  releasedTo!: string[] | null;

  @ApiProperty({
    type: String, format: 'date-time', nullable: true,
    description: 'When it was first published to a KPM; `null` for a new product, or one made before releases were kept.',
  })
  firstPublishedAt!: string | null;

  @ApiProperty({ type: [String], description: '*Juga sesuai*, as published: codes of the company’s other products.' })
  alsoFits!: string[];

  @ApiProperty({
    type: () => ProductBrochureRefDto, nullable: true,
    description: 'The company’s brochure for it, by its label, or `null` where none is stored.',
  })
  brochure!: ProductBrochureRefDto | null;
}
