import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LAWFUL_BASES, LEAD_OUTCOMES, LEAD_TYPES } from './lead.schema';
import type { LeadFlag, LeadPage, LeadSummary, LeadView } from './lead.service';

export class LeadContactDto {
  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;
}

export class LeadResponseDto implements LeadView {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String, description: 'The membership whose lead it is, never a user id.' })
  ownerMembershipId!: string;

  @ApiProperty({ enum: LEAD_TYPES, nullable: true })
  type!: 'sales' | 'recruitment' | null;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: LeadContactDto })
  contact!: { phone: string | null; email: string | null };

  @ApiProperty({ enum: LAWFUL_BASES, nullable: true })
  lawfulBasis!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  consentAt!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The code, never the label.' })
  statusCode!: string | null;

  @ApiProperty({
    type: Boolean,
    description:
      '**Derived** (P7-T5): is there a commitment for the office’s current month? Nothing clears '
      + 'it, so it cannot be left true for an agent who has not opened the app since March.',
  })
  thisMonth!: boolean;

  @ApiProperty({
    type: [String],
    example: ['2026-09', '2026-10'],
    description:
      'Every month this lead was promised for, oldest first, in the office’s timezone. The '
      + 'archive behind *did they do what they said* — written when the promise is made rather '
      + 'than swept somewhere when the month ends.',
  })
  committedMonths!: string[];

  @ApiProperty({ type: String, nullable: true })
  remarks!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-10-02' })
  nextActionDate!: string | null;

  @ApiProperty({ type: String, nullable: true })
  nextActionNote!: string | null;

  @ApiProperty({ enum: LEAD_OUTCOMES, nullable: true })
  outcome!: 'won' | 'lost' | null;

  @ApiProperty({ type: String, nullable: true })
  source!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  dateRegistered!: string | null;

  @ApiProperty({ type: Number, description: 'What a later write pins, so two people cannot overwrite each other.' })
  version!: number;

  @ApiProperty({
    type: [String],
    enum: ['overdue', 'no-next-action', 'no-remarks'],
    description:
      'Computed on read, never stored — a stored flag is one that is wrong at midnight. A closed '
      + 'lead carries none. **A commitment for this month does not suppress them**, unlike the '
      + 'prototype, which shows only the green chip on a lead that is also two weeks overdue.',
  })
  flags!: LeadFlag[];

  @ApiProperty({
    type: 'object',
    nullable: true,
    additionalProperties: false,
    properties: { membershipId: { type: 'string' }, name: { type: 'string', nullable: true } },
    description:
      'Who last changed this lead, when that was not the agent whose lead it is (ADR-0044) — '
      + '`null` otherwise. A proxy edit is recognisable by `updatedBy` differing from '
      + '`ownerMembershipId`: two columns, so no flag is needed.',
  })
  lastEditedBy!: { membershipId: string; name: string | null } | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 14,
    description:
      'How late, in the office’s own calendar days — `null` unless `flags` carries `overdue`. '
      + 'Beside `flags` rather than inside it: `flags` is what the list filters on, and a filter '
      + 'key carrying a number is one nobody can match against.',
  })
  overdueDays!: number | null;
}

export class LeadPageDto implements LeadPage {
  @ApiProperty({ type: [LeadResponseDto] })
  rows!: LeadResponseDto[];

  @ApiProperty({ type: Number, description: 'Matching the filter, not on this page.' })
  total!: number;

  @ApiProperty({ type: Number })
  page!: number;

  @ApiProperty({ type: Number })
  pageSize!: number;
}

export class DeletedLeadDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  deletedAt!: string;
}

export class LeadAttentionDto {
  @ApiProperty({ type: Number, description: 'The next-action date has passed.' })
  overdue!: number;

  @ApiProperty({ type: Number, name: 'no-next-action', description: 'No next-action date at all.' })
  'no-next-action'!: number;

  @ApiProperty({ type: Number, name: 'no-remarks', description: 'Nothing written down.' })
  'no-remarks'!: number;
}

export class LeadSummaryDto implements LeadSummary {
  @ApiProperty({ type: Number, description: 'Open leads in scope.' })
  open!: number;

  @ApiProperty({
    type: Number,
    description:
      'Open leads promised for the office’s **current** month — the glossary’s *Commitment*. '
      + 'Nothing clears it: a promise carries the month it was made for (P7-T5).',
  })
  committedThisMonth!: number;

  @ApiProperty({
    type: Number,
    description:
      '`RECRUITMENT_PIPELINE_NOW`: open recruitment candidates not on the stage that closes the '
      + 'pipeline. The office’s own `isTerminal` flag decides which that is (invariant §4).',
  })
  recruitmentPipelineNow!: number;

  @ApiProperty({
    type: Number,
    description:
      '`RECRUITMENT_EXPECTED_TO_CLOSE`: open recruitment candidates on a stage the office flagged '
      + '`isLateStage` (ADR-0043). A lead on the terminal stage is excluded by construction.',
  })
  recruitmentExpectedToClose!: number;

  @ApiProperty({
    type: LeadAttentionDto,
    description:
      'How many open leads carry each attention flag. **They overlap** — a lead with no date and '
      + 'no remark is in two of them — so they do not sum to `open`. The keys are the values '
      + '`GET /leads?attention=` takes, so a count links straight to the rows behind it.',
  })
  attention!: Record<'overdue' | 'no-next-action' | 'no-remarks', number>;
}
