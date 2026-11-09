import { ApiProperty } from '@nestjs/swagger';
import { PRODUCT_DOCUMENT_SLOTS, PRODUCT_KINDS, SCRIPT_REVIEW_STATES } from '@/domain/constants';

export class EffectiveFieldDto {
  @ApiProperty({ description: 'The value this office reads.' })
  value!: unknown;

  @ApiProperty({ type: Boolean, description: 'True when this office replaced the company’s.' })
  overridden!: boolean;
}

export class ProductDocumentSlotDto {
  @ApiProperty({ enum: PRODUCT_DOCUMENT_SLOTS.map((s) => s.key) })
  slot!: string;

  @ApiProperty({ type: String })
  label!: string;

  @ApiProperty({ type: String, nullable: true })
  storageKey!: string | null;

  @ApiProperty({ type: String, nullable: true })
  filename!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'application/pdf',
    description: 'What storage holds: `application/pdf`, or `text/html`, drawn only inside a sandboxed frame (ADR-0217 '
      + '§4). Null for an empty slot.',
  })
  mimeType!: string | null;

  @ApiProperty({
    enum: ['kpm', 'company', 'none'],
    description: 'The prototype’s own *"Uploaded by KPM"* against *"From the catalog"*.',
  })
  source!: string;
}

/** One of the company's plans as an office reads it on its settings (ADR-0225 §5). */
export class KpmProductPlanDto {
  @ApiProperty({ type: String, description: 'The company\'s plan, by its name — an option of the `plan` field.' })
  name!: string;

  @ApiProperty({ type: Boolean, description: '*Paling banyak dipilih*, the company\'s mark.' })
  popular!: boolean;

  @ApiProperty({
    type: EffectiveFieldDto,
    description: 'Its highlights, `{ label, value }[]`: this office\'s draft, else the company\'s. Held for approval.',
  })
  highlights!: EffectiveFieldDto;
}

export class KpmProductDto {
  @ApiProperty({ type: String })
  productId!: string;

  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String, description: 'What the company calls it, always.' })
  companyName!: string;

  @ApiProperty({ type: String })
  channel!: string;

  @ApiProperty({ type: String })
  category!: string;

  @ApiProperty({
    type: String,
    enum: PRODUCT_KINDS,
    description: '*Produk dasar* or *Rider* (ADR-0209 §6). A rider sits under each of its bases with no switch of its '
      + 'own: `active` is derived — on exactly when one of its bases is on — and every write about it is `409 '
      + 'PRODUCT_IS_RIDER`.',
  })
  kind!: string;

  @ApiProperty({ type: [String], description: 'A rider\'s base products, by id; `[]` for a base.' })
  attachesTo!: string[];

  @ApiProperty({ type: String })
  lifecycle!: string;

  @ApiProperty({
    type: Boolean,
    description: 'False once the company withdraws it, whatever this office decided, and with no office action.',
  })
  sellable!: boolean;

  @ApiProperty({ type: EffectiveFieldDto })
  active!: EffectiveFieldDto;

  @ApiProperty({ type: EffectiveFieldDto })
  displayName!: EffectiveFieldDto;

  @ApiProperty({
    type: EffectiveFieldDto,
    description:
      '*Short description (shown to agents)* (OD-136): this office’s **draft**, else the company’s '
      + 'tagline. Held for approval with the script, so what agents read is the effective read’s '
      + '`description`, not this.',
  })
  description!: EffectiveFieldDto;

  @ApiProperty({
    type: Object,
    description: 'The script fields, each with its own overridden flag: `objections` a list of `{ objection, answer }` '
      + 'cards (ADR-0209 §9).',
  })
  script!: Record<string, EffectiveFieldDto>;

  @ApiProperty({
    type: EffectiveFieldDto,
    description: '*Tanya-jawab*, `{ question, answer }[]` (ADR-0225 §5): this office\'s draft — the '
      + 'whole list — else the company\'s FAQ. **Held for approval with the script**: agents read the approved one.',
  })
  faq!: EffectiveFieldDto;

  @ApiProperty({
    type: [KpmProductPlanDto],
    description: 'The company\'s plans in its order, each with its highlights as this office drafted them, else the '
      + 'company\'s. A plan the company no longer has is not here. `[]` for a product with no plans.',
  })
  plans!: KpmProductPlanDto[];

  @ApiProperty({ enum: SCRIPT_REVIEW_STATES })
  reviewState!: string;

  @ApiProperty({ type: String, nullable: true })
  rejectionReason!: string | null;

  @ApiProperty({ type: [ProductDocumentSlotDto] })
  documents!: ProductDocumentSlotDto[];
}

export class SignedUrlDto {
  @ApiProperty({ type: String, description: 'Valid for 300 seconds.' })
  url!: string;
}

export class EffectiveScriptDto {
  @ApiProperty({
    enum: ['kpm', 'company'],
    description:
      'Whose words these are. `kpm` only when the office approved its own override — of the script '
      + 'or the description; otherwise the company’s, which the company published.',
  })
  source!: string;

  @ApiProperty({
    type: Object,
    description: 'The script fields, each the effective value — `objections` a list of cards. No markup, ever.',
  })
  script!: Record<string, unknown>;

  @ApiProperty({
    type: String,
    description:
      'What agents read in place of the tagline (OD-136, ADR-0120): the office’s **approved** '
      + 'description, else the company’s tagline. A pending one is never here.',
  })
  description!: string;
}
