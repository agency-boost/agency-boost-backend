import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LAWFUL_BASES, LEAD_OUTCOMES, LEAD_TYPES } from './lead.schema';
import type { LeadFlag, LeadPage, LeadView } from './lead.service';

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
      '**Derived**: is there a commitment for the office’s current month? Nothing clears '
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
