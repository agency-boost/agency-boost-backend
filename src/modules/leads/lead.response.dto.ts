import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { LEAD_AGE, LEAD_GENDERS } from '@/domain/constants';
import { LEAD_OUTCOMES, LEAD_TYPES } from './lead.schema';
import type { LeadDetailView, LeadFlag, LeadMoveView, LeadPage, LeadView } from './lead.service';

export class LeadContactDto {
  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;
}

/** The latest proposal's products, as its card names them (P19.7-T2 AC-12). */
export class LeadLatestProposalDto {
  @ApiProperty({
    type: [String],
    example: ['PRUWell Medical', 'PRUCinta'],
    description: 'The item names of the live proposal updated last that has a product, as the proposal shows them, in order. '
      + 'Empty when every live proposal of the lead is still empty.',
  })
  products!: string[];
}

/** A lead's proposals, for its owner alone (P19.7-T2 AC-12; ADR-0221 §6). */
export class LeadProposalsDto {
  @ApiProperty({ type: Number, minimum: 1, description: 'The lead’s live proposals, drafts included.' })
  count!: number;

  @ApiProperty({ type: LeadLatestProposalDto })
  latest!: LeadLatestProposalDto;
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

  @ApiProperty({
    type: LeadContactDto,
    description: 'No `lawfulBasis` or `consentAt` beside it since 2026-10-07 (ADR-0108 §1).',
  })
  contact!: { phone: string | null; email: string | null };

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

  @ApiProperty({
    type: Boolean,
    description:
      '**Derived** (UI-153 item 5): marked *Berhasil* inside the office’s current month. With `thisMonth` it '
      + 'is the avatar’s badge — yellow ✓ switched on and not closed, green ✓ switched on and closed this month — and it '
      + 'clears on the 1st with the switch.',
  })
  closedThisMonth!: boolean;

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

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: LEAD_AGE.MIN,
    example: 36,
    description: '**The client\'s age at the next birthday, today** (*Umur ulang tahun berikutnya*; ADR-0224 §2): the '
      + 'age written plus the whole years since `ageRecordedOn`, on the office\'s calendar — one more on each '
      + 'anniversary, at 00:00 WIB. `null` when none was given. Read by whoever reads the lead.',
  })
  age!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-11-05',
    description: 'The office\'s day the age was last written, `YYYY-MM-DD`; `null` with it. Set by the server only.',
  })
  ageRecordedOn!: string | null;

  @ApiProperty({
    enum: LEAD_GENDERS,
    nullable: true,
    description: '*Laki-laki* or *Perempuan* (ADR-0224 §1), or `null`. Printed nowhere, and decides no figure.',
  })
  gender!: 'male' | 'female' | null;

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

  @ApiProperty({
    type: LeadProposalsDto,
    nullable: true,
    description:
      'How many live proposals the lead has, and the latest’s products — the card’s *"PRUWell '
      + 'Medical +1"*. **`null` on a lead with none, and on every lead that is not yours**: a leader reads a downline’s '
      + 'lead, never what was proposed on it.',
  })
  proposals!: LeadProposalsDto | null;
}

/**
 * One entry of a lead's *Riwayat* (UI V1, UI-105; P19.7-T2 AC-11): a move along its ladder (`kind: 'stage'`), or — on the
 * owner's own read — a proposal first saved as a PDF (`kind: 'proposal'`). One shape, the other kind's fields absent.
 */
export class LeadMoveDto implements Omit<LeadMoveView, 'kind'> {
  @ApiProperty({ enum: ['stage', 'proposal'], description: '`stage`: a move. `proposal`: *"Proposal dibuat · …"*, derived.' })
  kind!: 'stage' | 'proposal';

  @ApiProperty({ type: String, format: 'date-time', description: 'A move’s time, or the proposal’s first *Simpan PDF*.' })
  at!: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: '`stage` only. `null` on the lead’s first move.' })
  fromStatusCode!: string | null;

  @ApiPropertyOptional({ type: String, example: 'FOLLOW_UP', description: '`stage` only. A code; the office names it.' })
  toStatusCode!: string;

  @ApiPropertyOptional({
    type: String, nullable: true,
    description: '`proposal` only: the proposal to open, or `null` once it is deleted — the note stays, its link goes.',
  })
  proposalId?: string | null;

  @ApiPropertyOptional({ type: [String], description: '`proposal` only: its item names when first saved, in order.' })
  products?: string[];
}

/** `GET /leads/:id`: the list's lead, and its moves (UI V1, UI-105). The list never carries them. */
export class LeadDetailResponseDto extends LeadResponseDto implements LeadDetailView {
  @ApiProperty({
    type: [LeadMoveDto],
    description: 'Every move along its ladder, oldest first. Append-only: a reopen or a type change adds none. On your own '
      + 'lead, the proposals ever saved as a PDF are interleaved by date (`kind: \'proposal\'`).',
  })
  // The DTO is one shape for both kinds (the document's); the service's type is the union it answers.
  history!: LeadDetailView['history'];
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

/** `PATCH /leads/order`: the order as it was saved, top first (P18.5-T7). */
export class LeadOrderDto {
  @ApiProperty({ type: [String], description: 'Your open leads’ ids, in the order now saved.' })
  ids!: string[];
}
