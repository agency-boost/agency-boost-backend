import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

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
 * The display name and the seven script fields, and nothing else.
 *
 * `whitelist: true` strips unknown keys before this is read, so the service's by-name refusal is
 * what a caller actually meets — which is why the service refuses rather than trusting the pipe.
 */
export class SaveProductOverridesDto {
  @ApiPropertyOptional({ description: 'What this office calls the product.' })
  @IsOptional() @IsString() @MaxLength(200)
  displayName?: string;

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
  @ApiProperty({ description: 'A key this office has already uploaded and confirmed.' })
  @IsString() @MaxLength(300)
  storageKey!: string;

  @ApiProperty({ description: 'What the row calls it on screen.' })
  @IsString() @MaxLength(200)
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
