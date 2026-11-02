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
      key: 'dev/66f0…/recruitment-pitch/01J…', 'Content-Type': 'application/pdf',
      'x-goog-date': '20261019T030000Z',
      'x-goog-credential': 'api-runtime@agencyboost-staging.iam.gserviceaccount.com/20261019/auto/storage/goog4_request',
      'x-goog-algorithm': 'GOOG4-RSA-SHA256', policy: 'eyJjb25kaXRpb25zIjpb…', 'x-goog-signature': '3f2a…',
    },
    description:
      'The exact form fields storage needs beside `file`, every one sent as it is and **before** `file`, which '
      + 'goes last — the browser need not know which they are. Today, a Cloud Storage V4 POST policy: `key`, '
      + '`Content-Type`, `x-goog-date`, `x-goog-credential`, `x-goog-algorithm`, `policy` and `x-goog-signature`. '
      + 'Storage answers a successful upload `204` with no body.',
  })
  fields!: Record<string, string>;
}
