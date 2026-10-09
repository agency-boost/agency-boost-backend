import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { PRODUCT_DOCUMENT_LABEL_MAX_LENGTH, PRODUCT_TAGLINE_MAX_LENGTH } from '@/domain/constants';

export class SetProductActiveDto {
  @ApiPropertyOptional({
    type: Boolean,
    nullable: true,
    description:
      'True to sell it, false not to, and **null to inherit the company’s default** — which is not '
      + 'the same as writing that default’s value today.',
  })
  @IsOptional() @IsBoolean()
  active?: boolean | null;
}

/**
 * The display name, the description and the seven script fields, and nothing else.
 *
 * `whitelist: true` strips unknown keys before this is read, so the service's by-name refusal is
 * what a caller actually meets — which is why the service refuses rather than trusting the pipe.
 */
export class SaveProductOverridesDto {
  @ApiPropertyOptional({ description: 'What this office calls the product.' })
  @IsOptional() @IsString() @MaxLength(200)
  displayName?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: PRODUCT_TAGLINE_MAX_LENGTH,
    description:
      '*Short description (shown to agents)* (`KPM_Owner.html:1781`, OD-136): the office’s sentence '
      + 'in place of the company’s tagline. Trimmed. **Held for approval with the script** '
      + '(ADR-0037, ADR-0120): agents read the company’s tagline until the office approves it. '
      + '`null`, or a blank, gives it back to the company — the same as `DELETE '
      + '…/overrides/description`.',
  })
  // `@IsOptional` lets `null` through, and `null` is a request: give it back to the company.
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @MaxLength(PRODUCT_TAGLINE_MAX_LENGTH)
  description?: string | null;

  @ApiPropertyOptional({ description: '0 · Good fit for' })
  @IsOptional() @IsString() @MaxLength(400)
  goodFit?: string;

  @ApiPropertyOptional({ description: '1 · Opening line' })
  @IsOptional() @IsString() @MaxLength(1000)
  opening?: string;

  @ApiPropertyOptional({ type: [String], description: '2 · Lead with these benefits' })
  @IsOptional() @IsArray() @IsString({ each: true }) @MaxLength(400, { each: true })
  benefits?: string[];

  @ApiPropertyOptional({ description: '3 · Full script' })
  @IsOptional() @IsString() @MaxLength(4000)
  fullScript?: string;

  @ApiPropertyOptional({ description: '4a · If they push back — they say' })
  @IsOptional() @IsString() @MaxLength(1000)
  objectionTheySay?: string;

  @ApiPropertyOptional({ description: '4b · If they push back — you say' })
  @IsOptional() @IsString() @MaxLength(1000)
  objectionYouSay?: string;

  @ApiPropertyOptional({ description: '5 · Next action' })
  @IsOptional() @IsString() @MaxLength(1000)
  nextAction?: string;
}

export class AttachProductDocumentDto {
  @ApiProperty({
    description:
      'A key this office was signed by `POST /kpm/settings/products/uploads`, its bytes sent. The attach '
      + 'confirms it against what storage holds itself — no separate confirm — and refuses anything but a PDF '
      + 'of at most 25 MB there.',
  })
  @IsString() @MaxLength(300)
  storageKey!: string;

  @ApiProperty({
    maxLength: PRODUCT_DOCUMENT_LABEL_MAX_LENGTH,
    description: `What the row calls it on screen. Trimmed, and cut to ${PRODUCT_DOCUMENT_LABEL_MAX_LENGTH} characters rather than refused.`,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().slice(0, PRODUCT_DOCUMENT_LABEL_MAX_LENGTH) : value))
  @IsString() @MaxLength(PRODUCT_DOCUMENT_LABEL_MAX_LENGTH)
  label!: string;
}

export class RejectScriptDto {
  @ApiProperty({
    description:
      'Required. "No" on its own is not something the person who wrote the script can act on.',
  })
  @IsString() @MaxLength(1000)
  reason!: string;
}
