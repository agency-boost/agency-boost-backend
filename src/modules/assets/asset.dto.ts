import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, MaxLength, Min } from 'class-validator';
import { ASSET_LIMITS } from '@/domain/constants';

/**
 * **A signed upload for a document: a PDF of at most 25 MB** (Phase 17) — an office's recruitment pitch
 * document, or its own product document. `mimeType` is any string here so that a type other than a PDF meets
 * the same `415 ASSET_TYPE_NOT_ALLOWED` whatever it is, from the service that signs.
 */
export class RequestDocumentUploadDto {
  @ApiProperty({ example: 'Opportunity_Overview_v3.pdf', maxLength: 255 })
  @IsString() @MaxLength(255)
  filename!: string;

  @ApiProperty({
    example: 'application/pdf',
    maxLength: 255,
    description: '`application/pdf`, and nothing else: any other type is refused `415 ASSET_TYPE_NOT_ALLOWED`.',
  })
  @IsString() @MaxLength(255)
  mimeType!: string;

  @ApiProperty({
    example: 2516582,
    minimum: 0,
    // Served, so a client pins it rather than re-declaring it (invariant §7). Not a validator bound: above
    // it the service refuses `413 ASSET_TOO_LARGE`, its own code, rather than the pipe a `400`.
    maximum: ASSET_LIMITS.MAX_BYTES,
    description:
      'What the browser is about to send. Above 25 MB is refused `413 ASSET_TOO_LARGE` before anything is '
      + 'signed, and checked again against what storage reports when the file is attached.',
  })
  @IsInt() @Min(0)
  bytes!: number;
}

