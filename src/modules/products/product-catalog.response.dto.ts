import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PRODUCT_CATEGORIES, PRODUCT_CHANNELS, PRODUCT_CURRENCIES, PRODUCT_DOCUMENT_SLOTS, PRODUCT_LIFECYCLES, PRODUCT_NEEDS,
} from '@/domain/constants';
import { ObjectionDto } from './product.dto';

/**
 * **What a field member is answered about the office's products** (`functional/sales-tools.md`, the
 * Data contract for the Product Catalog and the Sales Attack Plan).
 *
 * Every word in these is the office's **approved** word or the company's, field by field, through the
 * one effective rule (ADR-0037, ADR-0120). No draft, no review state and no `overrides` is in any of
 * them: a field reader has no use for an office's drafts, and the settings reads that carry them are
 * the office's own.
 */

export class CatalogCategoryDto {
  @ApiProperty({ enum: PRODUCT_CATEGORIES })
  code!: string;

  @ApiProperty({ type: String, example: 'Investment-linked', description: 'The catalog’s own word for it.' })
  label!: string;
}

export class CatalogCardDto {
  @ApiProperty({ type: String, example: 'PRUMAPAN', description: 'The product’s permanent code: its address.' })
  code!: string;

  @ApiProperty({ type: String, example: 'PRUMapan', description: 'The office’s display name, else the company’s name.' })
  name!: string;

  @ApiProperty({
    type: String,
    description:
      'The office’s **approved** description (*Short description (shown to agents)*), else the company’s '
      + 'tagline. A description waiting on approval is never here.',
  })
  tagline!: string;

  @ApiProperty({ type: CatalogCategoryDto })
  category!: CatalogCategoryDto;

  @ApiProperty({ enum: PRODUCT_CHANNELS })
  channel!: string;

  @ApiProperty({
    enum: PRODUCT_LIFECYCLES.filter((l) => l !== 'withdrawn'),
    description: '`closed_to_new_business` is *In run-off*. A withdrawn product is on no field read.',
  })
  lifecycle!: string;

  @ApiProperty({ enum: PRODUCT_NEEDS, isArray: true, description: 'The customer needs it serves.' })
  needs!: string[];

  @ApiProperty({
    enum: PRODUCT_CURRENCIES,
    isArray: true,
    description: 'The currencies it is sold in, `IDR` first: shown on the card as *IDR*, *USD* or *IDR + USD* '
      + '(ADR-0209 §8). A label, not money.',
  })
  currencies!: string[];
}

export class CatalogListDto {
  @ApiProperty({
    type: [CatalogCardDto],
    description:
      'Every product the office keeps on — the company’s `activeByDefault` until the office decided, never '
      + 'a withdrawn one — in the company’s order. Empty for an office whose company has no catalog, or '
      + 'which keeps nothing on.',
  })
  products!: CatalogCardDto[];
}

export class CommissionRateDto {
  @ApiProperty({ type: Number, example: 1, description: 'The policy year, from 1.' })
  year!: number;

  @ApiProperty({ type: Number, example: 0.4, description: 'A proportion, not a percentage: `0.4` is 40%.' })
  rate!: number;
}

export class CatalogScriptDto {
  @ApiProperty({ type: String, description: '0 · Good fit for' })
  goodFit!: string;

  @ApiProperty({ type: String, description: '1 · Opening line' })
  opening!: string;

  @ApiProperty({ type: [String], description: '2 · Lead with these benefits' })
  benefits!: string[];

  @ApiProperty({ type: String, description: '3 · Full script. Blank for a product with no authored script.' })
  fullScript!: string;

  @ApiProperty({
    type: [ObjectionDto],
    description: '4 · If they push back: every objection and its reply, in order (ADR-0209 §9).',
  })
  objections!: ObjectionDto[];

  @ApiProperty({ type: String, description: '5 · Next action' })
  nextAction!: string;
}

/** A rider an agent may add to a base (ADR-0209 §3). */
export class CatalogRiderDto {
  @ApiProperty({ type: String, example: 'CI_COVERAGE_PLUS' })
  code!: string;

  @ApiProperty({ type: String, example: 'CI Coverage+ Insurance', description: 'The company’s name for it.' })
  name!: string;
}

export class CatalogDocumentDto {
  @ApiProperty({ enum: PRODUCT_DOCUMENT_SLOTS.map((s) => s.key) })
  slot!: string;

  @ApiProperty({ type: String, example: 'Illustration / Simulation' })
  label!: string;

  @ApiProperty({
    type: Boolean,
    description: 'Whether the office’s file, or else the company’s, is in this slot — so *Open link →* can be asked for.',
  })
  available!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'application/pdf',
    description: 'What the slot holds: `application/pdf`, or `text/html`, which the app draws only inside a sandboxed '
      + 'frame and never opens on its own (ADR-0217 §4). Null for an empty slot.',
  })
  mimeType!: string | null;
}

export class CatalogProductDto extends CatalogCardDto {
  @ApiProperty({ type: [String], description: '*Benefits*, the company’s.' })
  benefits!: string[];

  @ApiProperty({ type: String, description: '*How it stands out*.' })
  differentiator!: string;

  @ApiProperty({ type: String, description: '*Best-fit customer*.' })
  bestFit!: string;

  @ApiProperty({ type: [String], example: ['25–34', '35–49'], description: 'The age bands it is eligible for, by label.' })
  ageBands!: string[];

  @ApiProperty({ type: [String], example: ['Rp 2 jt–Rp 5 jt'], description: 'The monthly budget bands it is eligible for, by label.' })
  budgetBands!: string[];

  @ApiProperty({ type: String, nullable: true, description: 'The drawer’s run-off note, for a product in run-off; else null.' })
  runOffNote!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The code of the product that replaced it, where the company named one.' })
  successorCode!: string | null;

  @ApiPropertyOptional({
    type: [CommissionRateDto],
    description:
      'The company’s schedule, a row per year — **absent** for a reader without `commission_rates:read`, '
      + 'and empty while the company has not stated one. Never a default.',
  })
  commissionSchedule?: CommissionRateDto[];

  @ApiProperty({
    type: CatalogScriptDto,
    description: 'The script fields: the office’s approved words field by field, else the company’s.',
  })
  script!: CatalogScriptDto;

  @ApiProperty({ type: [CatalogDocumentDto], description: 'The three slots, in their order.' })
  documents!: CatalogDocumentDto[];

  @ApiProperty({
    type: [CatalogRiderDto],
    description: '*"Bisa ditambah: …"* — the riders on sale attached to this base, in the company’s order; empty for '
      + 'a base with none (ADR-0209 §3). A rider is never listed, filtered, recommended or opened on its own.',
  })
  riders!: CatalogRiderDto[];
}

export class CatalogDocumentUrlDto {
  @ApiProperty({ type: String, description: 'Signed; the office’s file, else the company’s.' })
  url!: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'When the link stops working: 300 seconds after it was signed.' })
  expiresAt!: string;
}

export class AttackPlanBriefDto {
  @ApiProperty({ enum: PRODUCT_NEEDS })
  need!: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: 5, description: 'The age band, 1 (< 25) to 5 (65+).' })
  age!: number;

  @ApiProperty({ type: Number, minimum: 1, maximum: 7, description: 'The monthly budget band, 1 (< Rp 500 rb) to 7 (Lump-sum).' })
  budget!: number;
}

export class AttackPlanAlternativeDto {
  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String, description: 'The office’s display name.' })
  name!: string;
}

export class AttackPlanDto {
  @ApiProperty({ type: AttackPlanBriefDto, description: 'The brief, as read.' })
  brief!: AttackPlanBriefDto;

  @ApiProperty({
    type: CatalogProductDto,
    nullable: true,
    description:
      'The recommended product — or, with `product`, the one switched to — read as the drawer reads it. '
      + 'Null when no product the office keeps on, and still issues, serves the need.',
  })
  product!: CatalogProductDto | null;

  @ApiProperty({
    enum: ['good_fit', 'check_fit'],
    nullable: true,
    description: '*Good fit* when both bands match; *Check fit* otherwise. Null only when `product` is.',
  })
  verdict!: 'good_fit' | 'check_fit' | null;

  @ApiProperty({
    enum: ['age', 'budget'],
    isArray: true,
    description: 'Which of the brief’s bands the product is outside, for the fit note. Empty for *Good fit*.',
  })
  outside!: ('age' | 'budget')[];

  @ApiProperty({
    type: [AttackPlanAlternativeDto],
    description: 'The brief’s other matches in score order, the shown product left out: at most four.',
  })
  alternatives!: AttackPlanAlternativeDto[];

  @ApiProperty({ type: Number, description: 'How many more also match beyond the four.' })
  moreCount!: number;

  @ApiProperty({
    type: Boolean,
    description:
      'True when the office keeps nothing on — its company has no catalog, or every product is turned off. '
      + 'The screen then draws the empty shelf, not *no product matches this need*; `product` is null.',
  })
  shelfEmpty!: boolean;
}
