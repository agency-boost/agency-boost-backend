import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { ASSET_LIMITS } from '@/domain/constants';

/** The folders a training upload may land in. Anything else is another module's business. */
export const TRAINING_UPLOAD_FOLDERS = ['training'] as const;

export class RequestUploadDto {
  @ApiProperty({ example: 'module.pdf' })
  @IsString() @MaxLength(255)
  filename!: string;

  @ApiProperty({ enum: ASSET_LIMITS.ALLOWED_MIME_TYPES })
  @IsIn(ASSET_LIMITS.ALLOWED_MIME_TYPES as unknown as string[])
  mimeType!: string;

  @ApiProperty({
    example: 1048576,
    description:
      'What the browser is about to send. Checked here so an oversized file is refused before '
      + 'it is uploaded, and checked again against what storage reports (ADR-0040).',
  })
  @IsInt() @Min(0)
  bytes!: number;
}

export class ConfirmUploadDto {
  @ApiProperty({ example: 'dev/66f0.../training/01ABC' })
  @IsString() @MaxLength(300)
  storageKey!: string;
}

/**
 * The whole content document, not a patch (P5-T2 AC-6).
 *
 * The fields are read by `checkTrainingContent`, which collects every violation before refusing
 * — a module with three bad rows hears about three. These declarations are for OpenAPI and for
 * the shape; the rules are in one place, beside the data they describe.
 */
export class SaveModuleContentDto {
  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object' },
    description: '`{ id?, label, storageKey, mimeType, bytes }` per file, each already confirmed.',
  })
  @IsOptional() @IsArray()
  files?: unknown[];

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object' },
    description: 'Short videos, same shape. Anything longer than the cap is a link (ADR-0032).',
  })
  @IsOptional() @IsArray()
  videos?: unknown[];

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object' },
    description: '`{ id?, label, url }` per link. `https` only — a plain-http page is one an '
      + 'agent’s phone blocks or warns about.',
  })
  @IsOptional() @IsArray()
  links?: unknown[];
}
