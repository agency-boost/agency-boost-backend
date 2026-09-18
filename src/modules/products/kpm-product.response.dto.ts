import { ApiProperty } from '@nestjs/swagger';
import { PRODUCT_DOCUMENT_SLOTS, SCRIPT_REVIEW_STATES } from '@/domain/constants';

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
    enum: ['kpm', 'company', 'none'],
    description: 'The prototype’s own *"Uploaded by KPM"* against *"From the catalog"*.',
  })
  source!: string;
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

  @ApiProperty({ type: Object, description: 'The seven script fields, each with its own overridden flag.' })
  script!: Record<string, EffectiveFieldDto>;

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
