import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import { LAWFUL_BASES, LEAD_OUTCOMES, LEAD_TYPES } from './lead.schema';

/**
 * **`@Allow()`, and the whole body is read by `checkLead` instead.**
 *
 * The global pipe runs with `whitelist` and `forbidNonWhitelisted`, so a property with no
 * validation decorator is stripped **before** a service ever sees it — which is how three event
 * and campaign DTOs shipped unable to accept the fields they documented (found at the Phase 5
 * exit review). A lead's rules need the stored row beside the patch, so they cannot live in
 * decorators; `@Allow()` is what keeps the pipe from eating the body on the way past.
 */
export class CreateLeadDto {
  @ApiProperty({ example: 'Pak Budi', minLength: 2, maxLength: 120 })
  @Allow()
  name!: string;

  @ApiPropertyOptional({ enum: LEAD_TYPES, nullable: true, description: 'Null until the agent picks a ladder.' })
  @Allow()
  type?: 'sales' | 'recruitment' | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: false,
    properties: { phone: { type: 'string' }, email: { type: 'string' } },
    description: 'Refused without a lawful basis — LEAD_CONSENT_REQUIRED.',
  })
  @Allow()
  contact?: { phone?: string | null; email?: string | null } | null;

  @ApiPropertyOptional({ enum: LAWFUL_BASES, nullable: true, description: 'Why these details may be held (UU 27/2022).' })
  @Allow()
  lawfulBasis?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @Allow()
  remarks?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2026-10-02', description: 'A day, YYYY-MM-DD.' })
  @Allow()
  nextActionDate?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @Allow()
  nextActionNote?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @Allow()
  source?: string | null;

  @ApiPropertyOptional({ type: Boolean, description: 'The agent’s own commitment for the month.' })
  @Allow()
  thisMonth?: boolean;
}

/** The same fields, all optional. A patch never carries a status: moving is its own route. */
export class UpdateLeadDto extends CreateLeadDto {
  @ApiPropertyOptional({ example: 'Pak Budi', minLength: 2, maxLength: 120 })
  @Allow()
  declare name: string;

  @ApiPropertyOptional({
    type: Number,
    example: 3,
    description:
      'The `version` this patch was written against. Refused with `409 VERSION_CONFLICT` if the '
      + 'lead has moved on — two people in one 1-on-1 on two devices is the realistic case.',
  })
  @Allow()
  version?: number;
}

/** What every pinning route takes beside its own field. */
class PinnedVersion {
  @ApiPropertyOptional({ type: Number, example: 3, description: 'The version this write was read at.' })
  @Allow()
  version?: number;
}

export class SetLeadStatusDto extends PinnedVersion {
  @ApiProperty({
    example: 'FOLLOW_UP',
    description:
      'Any **active** stage of this lead’s own ladder, at any time (ADR-0045). Refused for the '
      + 'other pipeline’s stages, for an archived one, and for a lead that is already closed.',
  })
  @Allow()
  statusCode!: string;
}

export class SetLeadOutcomeDto extends PinnedVersion {
  @ApiProperty({
    enum: [...LEAD_OUTCOMES, null],
    nullable: true,
    description:
      '`won` needs the stage that closes the pipeline; `lost` needs nothing; `null` reopens. '
      + 'Reopening appends no transition — the lead has not moved.',
  })
  @Allow()
  outcome!: 'won' | 'lost' | null;
}

/** The screen's search, filter, sort and page, as they arrive on the query string. */
export class ListLeadsQueryDto {
  @ApiPropertyOptional({ type: String, description: 'Over the name and the remarks.' })
  @Allow()
  search?: string;

  @ApiPropertyOptional({ enum: [...LEAD_TYPES, 'unassigned'] })
  @Allow()
  type?: 'sales' | 'recruitment' | 'unassigned';

  @ApiPropertyOptional({ type: String })
  @Allow()
  statusCode?: string;

  @ApiPropertyOptional({ enum: [...LEAD_OUTCOMES, 'open'] })
  @Allow()
  outcome?: 'won' | 'lost' | 'open';

  @ApiPropertyOptional({ enum: ['overdue', 'no-next-action', 'no-remarks'] })
  @Allow()
  attention?: 'overdue' | 'no-next-action' | 'no-remarks';

  @ApiPropertyOptional({ enum: ['dateRegistered', 'name', 'nextActionDate'] })
  @Allow()
  sort?: 'dateRegistered' | 'name' | 'nextActionDate';

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @Allow()
  dir?: 'asc' | 'desc';

  @ApiPropertyOptional({ type: Number, minimum: 1 })
  @Allow()
  page?: number;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 200 })
  @Allow()
  pageSize?: number;
}
