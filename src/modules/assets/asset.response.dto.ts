import { ApiProperty } from '@nestjs/swagger';

/**
 * **A signed upload**: where the browser sends the bytes, the form fields it sends beside them, and the key
 * they land under. Shared by every
 * route that signs one — a training module's material, an office's recruitment pitch document, an office's
 * own product document — so the document describes one shape under one name. It lived with training, the
 * first route to sign one, until Phase 17 gave it a second and a third.
 */
export class SignedUploadDto {
  @ApiProperty({
    type: String,
    description:
      'Where the browser **POSTs** the bytes, as `multipart/form-data`: the file as `file`, and every entry of '
      + '`fields` beside it. The bytes go straight to storage and never transit this API.',
  })
  uploadUrl!: string;

  @ApiProperty({ type: String, description: 'The key the file lands under, which the attach that follows names.' })
  storageKey!: string;

  @ApiProperty({ type: String, description: 'Also in `fields`; kept for the callers that read it here.' })
  signature!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    example: {
      api_key: '123456789012345', timestamp: '1791511200', public_id: 'dev/66f0…/recruitment-pitch/01J…',
      type: 'authenticated', signature: '3f2a…',
    },
    description:
      'The exact form fields storage needs beside `file`, every one sent as it is — the browser need not know '
      + 'which they are. Today: `api_key`, `timestamp`, `public_id`, `type` and `signature`.',
  })
  fields!: Record<string, string>;
}
