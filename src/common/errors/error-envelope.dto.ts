import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * The one error shape the whole API returns, as a documented class.
 *
 * `error.filter.ts` owns the runtime shape and this owns its description; they are the
 * same object and a divergence is a defect. It lives as a class rather than an interface
 * because Swagger generates schemas from decorated classes — a TypeScript interface is
 * erased before the document is built, which is why every failure in this API was
 * undocumented until P3.5-T11.
 */
export class ApiErrorBody {
  @ApiProperty({
    example: 'PERM_DENIED',
    description: 'A stable code from `docs/02-specs/api/error-catalog.md`. Branch on this, never on the message.',
  })
  code!: string;

  @ApiProperty({
    example: 'You do not have permission to do that.',
    description: 'Written for a person. Wording may change; the code will not.',
  })
  message!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'What is specific to this failure — the permission that was missing, the field that was wrong, the code already taken.',
    example: { permission: 'kpm:create' },
  })
  details?: Record<string, unknown>;

  @ApiProperty({
    example: '9f2c1a8e-4b7d-4f21-9a3e-6c5d2b1f0a44',
    description: 'On every response and in every log line. Quote it to support.',
  })
  requestId!: string;
}

export class ApiErrorEnvelope {
  @ApiProperty({ type: ApiErrorBody })
  error!: ApiErrorBody;
}
