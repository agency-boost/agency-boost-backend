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

  @ApiProperty({ type: Boolean })
  thisMonth!: boolean;

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
