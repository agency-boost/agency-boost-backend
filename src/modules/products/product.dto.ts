import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Allow, ArrayMaxSize, ArrayNotEmpty, ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString,
  Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import {
  PDF_DETAIL_BLOCKS, PRODUCT_AGE_BANDS, PRODUCT_BUDGET_BANDS, PRODUCT_CATEGORIES, PRODUCT_CHANNELS, PRODUCT_CURRENCIES,
  PRODUCT_KINDS, PRODUCT_NEEDS, PRODUCT_OBJECTION_TEXT_MAX_LENGTH, PRODUCT_OBJECTIONS_MAX, PRODUCT_TAGLINE_MAX_LENGTH,
  PROPOSAL, PROPOSAL_DEFAULT_INSURED, PROPOSAL_FIELD_TYPES, PROPOSAL_TEXT_MAX,
} from '@/domain/constants';
import { field } from '@/common/validation/violations';
import { PRODUCTS_REFUSALS } from './products.messages';

const AGE_BAND_MAX = PRODUCT_AGE_BANDS.length;
const BUDGET_BAND_MAX = PRODUCT_BUDGET_BANDS.length;

/**
 * **One objection card** (P19.4-T4 AC-1, B1-1; ADR-0209 §9): what the customer says and the reply, each plain text
 * with its line breaks kept (B1-2), each at most the bound the one pair had.
 */
export class ObjectionDto {
  @ApiProperty({ description: 'What the customer says — *Dia berkata*.', example: 'Preminya terlalu mahal.' })
  @IsString() @MaxLength(PRODUCT_OBJECTION_TEXT_MAX_LENGTH)
  objection!: string;

  @ApiProperty({ description: 'The reply — *Anda menjawab*.' })
  @IsString() @MaxLength(PRODUCT_OBJECTION_TEXT_MAX_LENGTH)
  answer!: string;
}

/**
 * A product's default attack plan, as the Super Admin writes it. **Named apart from the Sales Attack Plan's own
 * `AttackPlanDto`** (`product-catalog.response.dto.ts`): the API document keys a schema by its class name, and the two
 * shared one until P19.4-T4, so `defaultAttackPlan` was documented as the plan an agent reads.
 */
export class DefaultAttackPlanDto {
  @ApiProperty({ description: '0 · Good fit for', example: 'Young families with a first mortgage' })
  @IsString() @MaxLength(400)
  goodFit!: string;

  @ApiProperty({ description: '1 · Opening line' })
  @IsString() @MaxLength(1000)
  opening!: string;

  @ApiProperty({ type: [String], description: '2 · Lead with these benefits' })
  @IsArray() @IsString({ each: true }) @MaxLength(400, { each: true })
  benefits!: string[];

  @ApiProperty({ description: '3 · Full script' })
  @IsString() @MaxLength(4000)
  fullScript!: string;

  @ApiProperty({
    type: [ObjectionDto],
    maxItems: PRODUCT_OBJECTIONS_MAX,
    description: `4 · If they push back: every objection and its reply, in order — at most ${PRODUCT_OBJECTIONS_MAX} `
      + 'cards (`PRODUCT_OBJECTIONS_MAX`). A card with neither side written is dropped. It replaced the one pair, '
      + '`objectionTheySay` and `objectionYouSay` (ADR-0209 §9).',
  })
  @IsArray() @ArrayMaxSize(PRODUCT_OBJECTIONS_MAX) @ValidateNested({ each: true }) @Type(() => ObjectionDto)
  objections!: ObjectionDto[];

  @ApiProperty({ description: '5 · Next action' })
  @IsString() @MaxLength(1000)
  nextAction!: string;
}

export class CommissionYearDto {
  @ApiProperty({ example: 1, minimum: 1, maximum: 50, description: 'Policy year, from 1; at most 50 years.' })
  @IsInt() @Min(1) @Max(50)
  year!: number;

  @ApiProperty({
    example: 0.4,
    description: 'A proportion, not a percentage: `0.4` is 40%. The company states it; nothing here invents one (parity F-15).',
  })
  @IsNumber() @Min(0) @Max(1)
  rate!: number;
}

// ---------------------------------------------------------------- the proposal's fields (P19.7-T1; ADR-0225 §1, §2)
/*
 * **The shapes, documented; the rules, the service's.** Each proposal key is `@Allow()`ed through the pipe and read
 * whole by `checkProposalSettings`, which refuses the first broken rule with `400 VALIDATION_FAILED` and
 * `details.field` naming its path (`proposalFields[2].options`) — a path the pipe's nested errors could not name.
 */

export class ProposalOptionDto {
  @ApiProperty({ maxLength: PROPOSAL_TEXT_MAX.OPTION_LABEL, example: 'Gold' })
  label!: string;

  @ApiPropertyOptional({
    type: Number, nullable: true, minimum: 1, maximum: PROPOSAL.PAYMENT_YEARS_MAX,
    description: 'On the `paymentYears` field: the term\'s whole years, `null` where it is none (*s.d. usia 60*).',
  })
  years?: number | null;

  @ApiPropertyOptional({
    enum: PRODUCT_CURRENCIES, nullable: true,
    description: 'On the `currency` field: one of the product\'s `currencies`. Not kept on any other field.',
  })
  currency?: string | null;
}

export class ProposalFieldDto {
  @ApiProperty({
    example: 'up',
    description: '`^[a-z][a-z0-9_]{0,39}$`, unique in the product; `insured` and `premium` are reserved.',
  })
  key!: string;

  @ApiProperty({ maxLength: PROPOSAL_TEXT_MAX.FIELD_LABEL, example: 'Uang pertanggungan' })
  label!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: PROPOSAL_TEXT_MAX.FIELD_LABEL, example: 'Santunan asuransi' })
  labelSyariah?: string | null;

  @ApiProperty({ enum: PROPOSAL_FIELD_TYPES })
  type!: string;

  @ApiPropertyOptional({
    type: [ProposalOptionDto], maxItems: PROPOSAL.CHIP_OPTIONS_MAX,
    description: '`chips`: 1 to 8, labels unique. `fixed`: exactly one, its label the text shown. `money`: none.',
  })
  options?: ProposalOptionDto[];

  @ApiPropertyOptional({
    type: String, nullable: true,
    description: '`chips`: one of the option labels, **required** — every chips field is preselected. `fixed`: its one '
      + 'option. `money`: none.',
  })
  default?: string | null;

  @ApiPropertyOptional({
    type: [Number], maxItems: PROPOSAL.QUICK_AMOUNTS_MAX,
    description: '`money` only: positive whole IDR minor units, ascending (*100 jt · 250 jt · 500 jt · 1 M*).',
  })
  quickAmounts?: number[];

  @ApiPropertyOptional({ type: Number, nullable: true, description: '`money` only: the least sum, IDR minor units.' })
  minMinor?: number | null;

  @ApiPropertyOptional({ type: Boolean, default: true, description: 'Printed on page 2.' })
  showOnPdf?: boolean;

  @ApiPropertyOptional({
    type: Boolean, default: false,
    description: `Printed on page 1 — at most ${PROPOSAL.SUMMARY_FIELDS_MAX} fields of a product.`,
  })
  showOnSummary?: boolean;

  @ApiPropertyOptional({
    type: Boolean, default: false,
    description: 'The field whose option\'s `years` makes *Total dibayar* — a `chips` or `fixed` field, at most one.',
  })
  paymentYears?: boolean;

  @ApiPropertyOptional({ type: Boolean, default: false, description: 'The `chips` field naming the plans, at most one.' })
  plan?: boolean;

  @ApiPropertyOptional({
    type: Boolean, default: false, description: 'The `chips` field deciding the item\'s currency, at most one.',
  })
  currency?: boolean;

  @ApiPropertyOptional({
    type: Boolean, default: false,
    description: '*Perlu dicek* (the Prudential draft\'s *[cek]*, OD-273): the Super Admin\'s mark, never an agent\'s.',
  })
  draft?: boolean;
}

export class PlanHighlightDto {
  @ApiProperty({ maxLength: PROPOSAL_TEXT_MAX.HIGHLIGHT_LABEL, example: 'Kamar per hari' })
  label!: string;

  @ApiProperty({ maxLength: PROPOSAL_TEXT_MAX.HIGHLIGHT_VALUE, example: 'Rp 1,5 jt' })
  value!: string;
}

export class PlanOptionDto {
  @ApiProperty({ maxLength: PROPOSAL_TEXT_MAX.PLAN_NAME, description: 'An option label of the `plan` field, once.' })
  name!: string;

  @ApiProperty({ type: [PlanHighlightDto], minItems: 1, maxItems: PROPOSAL.PLAN_HIGHLIGHTS_MAX })
  highlights!: PlanHighlightDto[];

  @ApiPropertyOptional({ type: Boolean, default: false, description: '*Paling banyak dipilih* — at most one plan.' })
  popular?: boolean;
}

export class FaqEntryDto {
  @ApiProperty({ maxLength: PROPOSAL_TEXT_MAX.FAQ_QUESTION, description: 'One line.' })
  question!: string;

  @ApiProperty({ maxLength: PROPOSAL_TEXT_MAX.FAQ_ANSWER, description: 'Its line breaks kept.' })
  answer!: string;
}

export class PdfDetailRowDto {
  @ApiProperty({ maxLength: PROPOSAL_TEXT_MAX.DETAIL_LABEL, example: 'Meninggal dunia' })
  label!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: PROPOSAL_TEXT_MAX.DETAIL_NOTE })
  note?: string | null;

  @ApiPropertyOptional({
    type: String, nullable: true, maxLength: PROPOSAL.FORMULA_MAX_LENGTH, example: '200% × up',
    description: 'Numbers, `%`, `×`/`*`, `/`, `+`, `−`/`-`, brackets, and **only this product\'s `money` keys** — '
      + 'anything else is `400` with *"`{name}` bukan kolom uang produk ini."*. Parsed by our own parser, never '
      + 'evaluated as code. Exactly one of `formula` and `text`.',
  })
  formula?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: PROPOSAL_TEXT_MAX.DETAIL_LABEL })
  text?: string | null;
}

export class PdfDetailSourceDto {
  @ApiProperty({ maxLength: PROPOSAL_TEXT_MAX.SOURCE_FILE })
  file!: string;

  @ApiProperty({ type: Number, minimum: 1 })
  page!: number;

  @ApiProperty({ type: String, example: '2026-11-01', description: 'A past day, `YYYY-MM-DD`.' })
  date!: string;
}

export class PdfDetailBlockDto {
  @ApiProperty({ enum: PDF_DETAIL_BLOCKS, description: 'Each block at most once.' })
  block!: string;

  @ApiProperty({
    type: [PdfDetailRowDto], minItems: 1, maxItems: PROPOSAL.PDF_DETAIL_ROWS_MAX,
    description: `At most ${PROPOSAL.PDF_DETAIL_ROWS_MAX} rows; \`pengecualian\` at most ${PROPOSAL.EXCLUSIONS_MAX}.`,
  })
  rows!: PdfDetailRowDto[];

  @ApiProperty({ type: PdfDetailSourceDto, description: 'The illustration it was read from — the Super Admin\'s only.' })
  source!: PdfDetailSourceDto;

  @ApiPropertyOptional({ type: Boolean, default: false, description: '*tidak dijamin*, on `nilai_tunai` only.' })
  notGuaranteed?: boolean;
}

/** Everything a product carries except its identity and its lifecycle. */
export class ProductFieldsDto {
  @ApiPropertyOptional({ example: 'PRUMapan' })
  @IsOptional() @IsString() @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 'Proteksi jiwa dengan premi tetap' })
  @IsOptional() @IsString() @MaxLength(PRODUCT_TAGLINE_MAX_LENGTH)
  tagline?: string;

  @ApiPropertyOptional({ enum: PRODUCT_CHANNELS })
  @IsOptional() @IsIn(PRODUCT_CHANNELS as unknown as string[])
  channel?: string;

  @ApiPropertyOptional({ enum: PRODUCT_CATEGORIES })
  @IsOptional() @IsIn(PRODUCT_CATEGORIES as unknown as string[])
  category?: string;

  @ApiPropertyOptional({
    enum: PRODUCT_KINDS,
    description: '*Produk dasar* or *Rider* (ADR-0209 §1). A rider needs `attachesTo`; a rider some base lists, or a '
      + 'base some rider attaches to, cannot change kind: `409 PRODUCT_KIND_IN_USE`.',
  })
  @IsOptional() @IsIn(PRODUCT_KINDS as unknown as string[])
  kind?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'A rider\'s base products (*Bisa ditambahkan ke*): ids of this company\'s **active base** products, at '
      + 'least one — empty is `400 VALIDATION_FAILED` *"Pilih minimal satu produk dasar"*, `details.field: '
      + '\'attachesTo\'`; a rider, a product not on sale or another company\'s id is `400` too. `[]` for a base.',
  })
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(64, { each: true })
  attachesTo?: string[];

  @ApiPropertyOptional({
    enum: PRODUCT_CURRENCIES,
    isArray: true,
    description: 'The currencies its policies are sold in (ADR-0209 §8): `IDR`, `USD` or both, at least one, no '
      + 'repeats, stored `IDR` first. A label, not money. `[\'IDR\']` until stated.',
  })
  @IsOptional() @IsArray() @ArrayNotEmpty() @ArrayUnique() @IsIn(PRODUCT_CURRENCIES as unknown as string[], { each: true })
  currencies?: string[];

  @ApiPropertyOptional({
    enum: PRODUCT_NEEDS,
    isArray: true,
    description: '`accident` is a need, not a category — accident products sit under `health`.',
  })
  @IsOptional() @IsArray() @IsIn(PRODUCT_NEEDS as unknown as string[], { each: true })
  primaryNeeds?: string[];

  @ApiPropertyOptional({ type: [Number], description: `Band numbers, 1–${AGE_BAND_MAX}.` })
  @IsOptional() @IsArray() @IsInt({ each: true })
  @Min(1, { each: true }) @Max(AGE_BAND_MAX, { each: true })
  eligibleAgeBands?: number[];

  @ApiPropertyOptional({
    type: [Number],
    description: `Band numbers, 1–${BUDGET_BAND_MAX}. The seven-band scale of the prototype's `
      + '`Overall.html` copy, which the ERD records; `Sales_Attack_Plan.html` scores the same '
      + 'products on five.',
  })
  @IsOptional() @IsArray() @IsInt({ each: true })
  @Min(1, { each: true }) @Max(BUDGET_BAND_MAX, { each: true })
  eligibleBudgetBands?: number[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(400, { each: true })
  benefits?: string[];

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(1000)
  differentiator?: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(1000)
  bestFor?: string;

  @ApiPropertyOptional({ type: DefaultAttackPlanDto })
  @IsOptional() @ValidateNested() @Type(() => DefaultAttackPlanDto)
  defaultAttackPlan?: DefaultAttackPlanDto;

  @ApiPropertyOptional({
    type: [CommissionYearDto],
    description: 'Empty until the company states one. An empty list is shown as "not set", never as a default. '
      + 'A rate per policy year from year 1, none missing and none twice (OD-135, ADR-0119); the '
      + 'whole schedule is sent, and stored in year order.',
  })
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CommissionYearDto)
  commissionSchedule?: CommissionYearDto[];

  @ApiPropertyOptional({
    description: 'What an office sells before its Owner has an opinion about the product (ADR-0033).',
  })
  @IsOptional() @IsBoolean()
  activeByDefault?: boolean;

  @ApiPropertyOptional({
    type: [ProposalFieldDto], maxItems: PROPOSAL.FIELDS_MAX,
    description: '**The proposal panel\'s fields** between *Tertanggung* and the premium, in order (ADR-0225 '
      + `§1, §2): at most ${PROPOSAL.FIELDS_MAX}, ${PROPOSAL.SUMMARY_FIELDS_MAX} on the summary, one \`paymentYears\`, one `
      + '`plan` and one `currency`. The whole list is sent. Every broken rule is `400 VALIDATION_FAILED`, '
      + '`details.field` its path. A rider carries none: it is never offered alone.',
  })
  @Allow()
  proposalFields?: ProposalFieldDto[];

  @ApiPropertyOptional({
    type: [PlanOptionDto], maxItems: PROPOSAL.PLAN_OPTIONS_MAX,
    description: '*Lihat semua plan*\'s cards, cheapest first; each names an option of the `plan` field once.',
  })
  @Allow()
  planOptions?: PlanOptionDto[];

  @ApiPropertyOptional({
    type: [FaqEntryDto], maxItems: PROPOSAL.FAQ_MAX,
    description: '*Tanya-jawab*, for the agent only and never printed. An office may replace it (ADR-0225 §5).',
  })
  @Allow()
  faq?: FaqEntryDto[];

  @ApiPropertyOptional({
    type: [PdfDetailBlockDto], maxItems: PDF_DETAIL_BLOCKS.length,
    description: 'Page 2\'s detail blocks (*Manfaat utama*, *Jadwal*, *Masa*, *Yang tidak ditanggung*, *Nilai tunai*).',
  })
  @Allow()
  pdfDetail?: PdfDetailBlockDto[];

  @ApiPropertyOptional({
    type: String, nullable: true, maxLength: PROPOSAL_TEXT_MAX.SYARIAH_NAME,
    description: 'A `conventional` product\'s name on a *Syariah* proposal — only where its syariah version is no '
      + 'product of its own (ADR-0225 §3). `null` clears it.',
  })
  @Allow()
  syariahName?: string | null;

  @ApiPropertyOptional({
    enum: PROPOSAL_DEFAULT_INSURED, nullable: true,
    description: 'Who it insures by default; `null` reads *Anak* for `education`, *Klien* for the rest.',
  })
  @Allow()
  defaultInsured?: string | null;

  @ApiPropertyOptional({
    type: String, nullable: true, maxLength: PROPOSAL_TEXT_MAX.TYPE_LABEL,
    description: 'The PDF\'s type label, printed in capitals; `null` reads the category\'s (*KESEHATAN* …).',
  })
  @Allow()
  proposalTypeLabel?: string | null;
}

export class CreateProductDto extends ProductFieldsDto {
  /**
   * The identity, typed once. Immutable afterwards and never reused, because a policy, a lead and
   * a plan's address (`/attack-plan?product=…`) all point at it (ADR-0006).
   */
  @ApiProperty({ example: 'PRUMAPAN', description: 'Upper case, letters, digits and `_`. Immutable once created.' })
  @IsString() @MaxLength(60)
  @Matches(/^[A-Za-z][A-Za-z0-9_]*$/, {
    // The DTO's own sentence, in both languages (P18.10-T5 AC-3).
    message: field(PRODUCTS_REFUSALS.VALIDATION_FAILED.productCodeShape),
  })
  code!: string;

  @ApiProperty({ example: 'PRUMapan' })
  @IsString() @MaxLength(200)
  declare name: string;

  @ApiProperty({ enum: PRODUCT_CHANNELS })
  @IsIn(PRODUCT_CHANNELS as unknown as string[])
  declare channel: string;

  @ApiProperty({ enum: PRODUCT_CATEGORIES })
  @IsIn(PRODUCT_CATEGORIES as unknown as string[])
  declare category: string;
}

/** No `code` and no `lifecycle`: the first never changes, the second moves through its own routes. */
export class UpdateProductDto extends ProductFieldsDto {
  /**
   * The product's `version` as the editor read it (P19-T6 AC-2; the 11-03 handover's B1-10). The editor always
   * sends it; absent, the write lands whatever the version, as before.
   */
  @ApiPropertyOptional({
    example: 4,
    minimum: 1,
    description: 'The product\'s `version` as read. A product saved, closed or withdrawn since is refused '
      + '`409 VERSION_CONFLICT` with `details.expectedVersion` and `details.actualVersion`, and nothing is written. '
      + 'Absent, the write lands whatever the version.',
  })
  @IsOptional() @IsInt() @Min(1)
  expectedVersion?: number;
}

export class CloseToNewBusinessDto {
  @ApiPropertyOptional({
    description: 'The successor, where there is one — a product of the same company. The prototype’s `legacy` boolean could not say.',
  })
  @IsOptional() @IsString() @MaxLength(64)
  replacedByProductId?: string;
}

export class ReorderProductsDto {
  /** The whole shelf, so two people reordering at once cannot interleave into a new order. */
  @ApiProperty({ type: [String], description: 'Every product of the company, once each, in the order wanted.' })
  @IsArray() @ArrayNotEmpty() @IsString({ each: true })
  productIds!: string[];
}
