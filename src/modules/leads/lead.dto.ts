import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  Allow, ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional, IsString, MaxLength, Min,
} from 'class-validator';
import { LEAD_FLAGS, type LeadFlag } from './lead-attention';
import { LEAD_SORT_KEYS, type LeadSortKey } from './lead-order';
import { LEAD_OUTCOMES, LEAD_TYPES } from './lead.schema';

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
    description:
      'Both optional, both clearable, sent as a pair. **No lawful basis is asked for since 2026-10-07** '
      + '(ADR-0108 §1): `lawfulBasis` is no longer a field, and a body carrying it is refused with '
      + '`400 VALIDATION_FAILED` like any other unknown field.',
  })
  @Allow()
  contact?: { phone?: string | null; email?: string | null } | null;

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
      + 'lead has moved on — two people in one 1-on-1 on two devices is the realistic case. Optional '
      + 'for the lead’s owner; **required of anybody else**, `400 VALIDATION_FAILED` without it.',
  })
  @Allow()
  version?: number;
}

/**
 * What every pinning route takes beside its own field.
 *
 * **Required of anybody but the lead's owner** (P11-T4 AC-3): a leader's write from the coaching card,
 * or from their own `/leads`, without one is `VALIDATION_FAILED` — the service's rule, because only the
 * stored row says whose lead it is. Validated here as the whole number it is, so a string or an object is
 * refused by the pipe rather than compared.
 */
class PinnedVersion {
  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    example: 3,
    description: 'The version this write was read at. Optional for the lead’s owner; required of anybody else.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
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

/**
 * ***Selesai*** **or** ***Urungkan*** **on a lead's next action, from Calendar** (UI V1, UI-104 point 4): the whole state
 * and the version it was read at — **always pinned**, since a tick clears the next action and an undo writes it back.
 */
export class SetNextActionDoneDto {
  @ApiProperty({ type: Boolean, description: '`true` ticks the next action done; `false` puts the one last ticked back.' })
  @IsBoolean()
  done!: boolean;

  @ApiProperty({ type: Number, minimum: 1, example: 3, description: 'The version the lead was read at.' })
  @IsInt()
  @Min(1)
  version!: number;
}

/**
 * The screen's search, filter, sort and page, as they arrive on the query string.
 *
 * **Every field is validated as the string, number or enum it is; none is `@Allow()`.** The pipe
 * refuses a field it does not know, but `@Allow()` passes a known field in any shape, and Express
 * parses `?search[$ne]=x` into an object: `search` reached `.trim()` and answered 500, and
 * `statusCode` would have reached the database as an operator on the field (found at the Phase 10.1
 * exit review, 2026-10-01). Neither could leave the caller's scope, which `ownersInScope` sets in the
 * service — so this is a wrong answer closed, not a leak — but a 500 is not a refusal and an operator
 * is not a filter. The two numbers opt in to conversion explicitly: query strings arrive as strings,
 * and `VALIDATION_PIPE_OPTIONS` says why implicit conversion is off.
 */
export class ListLeadsQueryDto {
  @ApiPropertyOptional({
    type: String,
    maxLength: 120,
    description:
      'Over the name and the remarks, ignoring case, as the words typed — never a pattern. Narrows the '
      + 'leads your grant reaches and never widens them. The leads screen sends it with `type` and '
      + '`statusCode`; the coaching card with `type`.',
  })
  // P18.95-T4 (ADR-0167 §4): `/leads` sends all three since the client's UI review of 2026-10-26 (UI-016).
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  /**
   * **One member's leads** (P11-T4 AC-3): the coaching session's Leads card. Resolved against the
   * caller's grant on `lead:read` — a coachee, or the caller themselves — and a 404 outside it. Every
   * other filter applies beside it.
   */
  @ApiPropertyOptional({
    type: String,
    maxLength: 64,
    description: 'Whose leads: a membership id. Yours, or somebody your grant reaches; 404 outside it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  owner?: string;

  @ApiPropertyOptional({ enum: [...LEAD_TYPES, 'unassigned'] })
  @IsOptional()
  @IsIn([...LEAD_TYPES, 'unassigned'])
  type?: 'sales' | 'recruitment' | 'unassigned';

  @ApiPropertyOptional({ type: String, maxLength: 64, description: 'A stage code of either ladder.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  statusCode?: string;

  @ApiPropertyOptional({ enum: [...LEAD_OUTCOMES, 'open'] })
  @IsOptional()
  @IsIn([...LEAD_OUTCOMES, 'open'])
  outcome?: 'won' | 'lost' | 'open';

  @ApiPropertyOptional({ enum: [...LEAD_FLAGS] })
  @IsOptional()
  @IsIn(LEAD_FLAGS as unknown as string[])
  attention?: LeadFlag;

  /**
   * **Validated first, on 2026-09-30, when its neighbours were still only allowed through.** An
   * unknown key used to reach the database as a sort on a field no lead has, and answered 200 in
   * whatever order the index returned. That looks like a sort that works (P10.1-T4). The rest
   * followed on 2026-10-01 — see the class comment.
   */
  @ApiPropertyOptional({
    enum: [...LEAD_SORT_KEYS],
    description:
      '`name` ignores case and accents. `type` orders blank, Sales, Recruitment. `status` orders '
      + 'by the stage’s place in its own ladder as the office last published it, blank first; '
      + 'equal places are ordered by type and then by registration, oldest first. Every order '
      + 'ends on the id, so equal leads keep their places from one page to the next. `desc` '
      + 'reverses the whole order. Sorted before the page is cut. **Omitted, the list is in its '
      + 'owner’s own order** — where `PATCH /leads/order` put each lead, a new one at the top (ADR-0161 §1).',
  })
  @IsOptional()
  @IsIn(LEAD_SORT_KEYS as unknown as string[])
  sort?: LeadSortKey;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], description: 'With `sort`; omitted is `desc`. The owner’s own order has no direction.' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  dir?: 'asc' | 'desc';

  @ApiPropertyOptional({ type: Number, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  // Above 200 is answered as 200 — the service's clamp, which `/leads` asks for by name.
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

/**
 * `POST /leads?owner=` (P11-T4): a leader's *+ Add lead* on the coaching card creates the lead in the
 * coachee's pipeline. Absent, the lead is the caller's own, as it always was.
 */
export class CreateLeadQueryDto {
  @ApiPropertyOptional({
    type: String,
    maxLength: 64,
    description:
      'Whose pipeline: somebody you coach. The lead is theirs, and its creation is attributed to you. '
      + '404 outside `COACH`, yourself included.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  owner?: string;
}


/**
 * `PATCH /leads/order` (P18.8-T7, ADR-0161 §1): the caller's open leads, every one, in the order they want them.
 *
 * **The shape here, the rule in the service.** The pipe refuses what is not a list of ids; whether those
 * are exactly the caller's open leads needs the database, so `LeadService.reorder` answers that — with the
 * same `400 VALIDATION_FAILED`. The ceiling is ten times the 50 open leads an agent is planned for
 * (`performance-and-scale.md`), and above the 500 an agent holds in a working lifetime.
 */
export class ReorderLeadsDto {
  @ApiProperty({
    type: [String],
    example: ['66f0…a1', '66f0…a2'],
    description:
      'Every one of your open leads, once each, top first. A closed or deleted lead, somebody else’s, '
      + 'another office’s, a repeat or one left out is `400 VALIDATION_FAILED`, and nothing is written.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsMongoId({ each: true })
  ids!: string[];
}
