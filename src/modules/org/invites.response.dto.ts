import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { InviteBanner, InviteView } from './invites.service';
import type { RequestedTransferView, TransferPerson, TransferView } from './transfers.service';

/**
 * The shapes P18.96-T3's routes answer (ADR-0170): an invite, a transfer request, *+ Add agent*'s outcome and an
 * invite link's banner. Each `implements` the service's interface, so the document cannot drift from the code.
 */

export class InviteLeaderDto {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  name!: string;
}

export class InviteDto implements InviteView {
  @ApiProperty({ type: String })
  inviteId!: string;

  @ApiProperty({ type: String, description: 'The name the leader typed.' })
  fullName!: string;

  @ApiProperty({ type: String })
  agentCode!: string;

  @ApiProperty({ type: String, description: 'Their WhatsApp number, as typed.' })
  phone!: string;

  @ApiProperty({ type: String, description: 'An office date: the join date they are given when they accept.' })
  joinDate!: InviteView['joinDate'];

  @ApiProperty({ type: String, enum: ['pending', 'expired'], description: '*Invited, waiting to join*, or *Invite expired* past its 14 days.' })
  status!: 'pending' | 'expired';

  @ApiProperty({ type: String, description: 'The instant its link stops opening.' })
  expiresAt!: string;

  @ApiProperty({ type: String })
  invitedAt!: string;

  @ApiProperty({ type: InviteLeaderDto, description: 'The unit they join: its leader.' })
  leader!: InviteLeaderDto;

  @ApiProperty({ type: Boolean, description: 'An account holds the code: the link opens the signed-in page rather than registration.' })
  existingAccount!: boolean;
}

export class InviteListDto {
  @ApiProperty({ type: String, description: 'The office’s today: the form’s default join date and its latest.' })
  today!: string;

  @ApiProperty({ type: [InviteDto], description: 'Pending and expired invites the reader reaches, newest first. Never a link.' })
  invites!: InviteDto[];
}

export class SharedInviteDto {
  @ApiProperty({ type: InviteDto })
  invite!: InviteDto;

  @ApiProperty({
    type: String,
    description: 'The link that carries the token, in this answer and nowhere else: only the token’s hash is kept.',
  })
  link!: string;
}

export class TransferPersonDto implements TransferPerson {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  name!: string;
}

export class TransferMemberDto extends TransferPersonDto {
  @ApiProperty({ type: String })
  agentCode!: string;
}

export class TransferDto implements TransferView {
  @ApiProperty({ type: String })
  transferId!: string;

  @ApiProperty({ type: TransferMemberDto, description: 'Who would move.' })
  member!: TransferMemberDto;

  @ApiProperty({ type: TransferPersonDto, nullable: true, description: 'Their leader when it was asked.' })
  from!: TransferPersonDto | null;

  @ApiProperty({ type: TransferPersonDto, description: 'The leader they would move under.' })
  to!: TransferPersonDto;

  @ApiProperty({ type: TransferPersonDto })
  requestedBy!: TransferPersonDto;

  @ApiProperty({ type: String })
  requestedAt!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The name whoever asked typed in the form, which may not be the account’s — shown beside the account’s own name '
      + 'where they differ, so a code typed for somebody else is seen. `null` on a request made before it was kept.',
  })
  requestedName!: string | null;
}

/**
 * A transfer request as whoever asked sees it: what they typed and asked for, and nothing of the account — never its
 * own name, nor the leader it reports to.
 */
export class RequestedTransferDto implements RequestedTransferView {
  @ApiProperty({ type: String })
  transferId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The name they typed in the form. `null` on a request made before it was kept: show the code.',
  })
  requestedName!: string | null;

  @ApiProperty({ type: String, description: 'The agent code they typed.' })
  agentCode!: string;

  @ApiProperty({ type: TransferPersonDto, description: 'The unit they asked for: its leader.' })
  to!: TransferPersonDto;

  @ApiProperty({ type: String, enum: ['pending', 'approved', 'declined', 'cancelled'] })
  status!: RequestedTransferView['status'];

  @ApiProperty({ type: String })
  requestedAt!: string;
}

export class LinkedMemberDto {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String, description: 'The account’s own name, whatever the form said.' })
  fullName!: string;
}

export class AddAgentResultDto {
  @ApiProperty({
    type: String,
    enum: ['invited', 'linked', 'transfer_requested'],
    description:
      '`invited`: nobody in the office holds the code, so an invite was made (`invite`, `link`). `linked`: an account '
      + 'with no leader here was placed under the leader now (`member`). `transfer_requested`: an account reporting to '
      + 'another leader here, so the Owner and the Admins were asked to move them (`transfer`) — answered with what was '
      + 'typed, never the account’s own name or its leader.',
  })
  outcome!: 'invited' | 'linked' | 'transfer_requested';

  @ApiPropertyOptional({ type: InviteDto })
  invite?: InviteDto;

  @ApiPropertyOptional({ type: String, description: 'With `invited`: the link, shown once.' })
  link?: string;

  @ApiPropertyOptional({ type: LinkedMemberDto })
  member?: LinkedMemberDto;

  @ApiPropertyOptional({ type: RequestedTransferDto })
  transfer?: RequestedTransferDto;
}

export class InviteOfficeDto {
  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  branchName!: string;
}

export class InviteBannerDto implements InviteBanner {
  @ApiProperty({ type: String, description: 'The leader they would join, by the name they go by.' })
  leaderName!: string;

  @ApiProperty({ type: InviteOfficeDto })
  kpm!: InviteOfficeDto;

  @ApiProperty({ type: String, description: 'The insurer: registration on the link takes it, read-only.' })
  companyId!: string;

  @ApiProperty({ type: String })
  companyName!: string;

  @ApiProperty({ type: String, description: 'Read-only on the form: the server takes the invite’s.' })
  agentCode!: string;

  @ApiProperty({ type: String, description: 'Read-only on the form: the membership is given it.' })
  joinDate!: InviteBanner['joinDate'];

  @ApiProperty({ type: String, description: 'The name the leader typed: filled in, and theirs to correct.' })
  fullName!: string;

  @ApiProperty({ type: Boolean, description: 'An account holds the code: sign in and accept rather than register.' })
  existingAccount!: boolean;

  @ApiProperty({ type: String })
  expiresAt!: string;
}

export class AcceptedInviteDto {
  @ApiProperty({ type: String })
  kpmId!: string;

  @ApiProperty({ type: String })
  leaderName!: string;
}
