import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Two shapes the console returns straight from Mongoose, which is why they are described
 * here rather than generated from a service interface.
 *
 * Both are worth flagging: a raw document is what put an ObjectId in a column headed
 * **Owner** before P3.5-T14, and returning one means the wire shape is whatever the
 * schema happens to hold. `CompanyResponseDto` documents what a client may rely on.
 */
export class CompanyResponseDto {
  @ApiProperty({ type: String })
  _id!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String, description: 'Derived from the name by the console, and unique among companies that are not deleted.' })
  slug!: string;

  @ApiProperty({ type: String, example: 'IDR', description: 'Fixed for v1 (ADR-0016). Every office inherits it.' })
  defaultCurrency!: string;

  @ApiProperty({ type: String, example: 'id-ID', description: 'Fixed for v1.' })
  defaultLocale!: string;

  @ApiProperty({ type: String, example: 'Asia/Jakarta', description: 'Fixed for v1 (ADR-0016). Every day boundary in every office of this company resolves here.' })
  defaultTimezone!: string;

  @ApiProperty({ type: String, enum: ['active', 'suspended'] })
  status!: string;
}

/** One row of the append-only platform log. Read-only by construction — there is no edit. */
export class AuditEntryResponseDto {
  @ApiProperty({ type: String })
  _id!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Null for a platform-level action, which belongs to no office.' })
  kpmId!: string | null;

  @ApiProperty({ type: String, example: 'kpm.provisioned' })
  action!: string;

  @ApiProperty({ type: String, example: 'kpms' })
  targetCollection!: string;

  @ApiProperty({ type: String, nullable: true })
  targetId!: string | null;

  @ApiProperty({ type: String, description: 'The real actor. Under impersonation this stays the Super Admin.' })
  actorUserId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Who they were acting as, when this was a support session.' })
  effectiveUserId!: string | null;

  @ApiProperty({ type: Boolean })
  onBehalfOf!: boolean;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true })
  before?: Record<string, unknown> | null;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true })
  after?: Record<string, unknown> | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}
