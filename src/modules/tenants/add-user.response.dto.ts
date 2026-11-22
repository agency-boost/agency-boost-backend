import { ApiProperty } from '@nestjs/swagger';
import type {
  AddUserOptions, LeaderChoice, PlacedKpm, RungChoice, UserInviteAccepted, UserInviteBanner, UserInvitationView,
  UserInvited, UserPlaced,
} from './add-user.service';

/** A rung of the KPM's company ladder: *Peran*'s chip. */
export class RungChoiceDto implements RungChoice {
  @ApiProperty({ example: 'AGENT' }) code!: string;
  @ApiProperty({ example: 'Agent' }) label!: string;
  @ApiProperty({ enum: ['ab', 'aab', 'agent'], description: '`ab` and `aab` draw the orange label (ADR-0156).' })
  class!: 'ab' | 'aab' | 'agent';
}

/** An active AB or AAB of the KPM, for *Leader*. */
export class LeaderChoiceDto implements LeaderChoice {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Sinta Maharani' }) fullName!: string;
  @ApiProperty({ type: RungChoiceDto }) role!: RungChoiceDto;
  @ApiProperty() isOwner!: boolean;
  @ApiProperty({ type: String, nullable: true }) photoUrl!: string | null;
}

class CompanyRefDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Prudential' }) name!: string;
}

class OptionsKpmDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: '0602' }) code!: string;
  @ApiProperty({ example: 'Bekasi Barat Branch' }) branch!: string;
  @ApiProperty({ type: CompanyRefDto }) company!: CompanyRefDto;
}

/** *Pilih KPM*'s next step (`GET /user-invitations/options`). */
export class AddUserOptionsDto implements AddUserOptions {
  @ApiProperty({ type: OptionsKpmDto, nullable: true, description: '`null` for a company asked alone (*＋ KPM baru*).' })
  kpm!: OptionsKpmDto | null;

  @ApiProperty({ type: CompanyRefDto, nullable: true }) company!: CompanyRefDto | null;

  @ApiProperty({ type: RungChoiceDto, isArray: true, description: 'The company ladder, junior rung first.' })
  roles!: RungChoiceDto[];

  @ApiProperty({ type: String, nullable: true, example: 'AB', description: 'The senior rung: no leader, and a new KPM’s first owner’s.' })
  seniorCode!: string | null;

  @ApiProperty({ type: LeaderChoiceDto, isArray: true, description: 'Active ABs and AABs, ABs first; test accounts never.' })
  leaders!: LeaderChoiceDto[];

  @ApiProperty({ description: '*Jadikan KPM Owner* is the reader’s: the Super Admin or an owner, never a KPM Admin.' })
  mayMakeOwner!: boolean;

  @ApiProperty({ description: '*＋ KPM baru* is the reader’s: the Super Admin alone.' })
  mayMakeKpm!: boolean;
}

class InvitationRoleDto {
  @ApiProperty({ example: 'AGENT' }) code!: string;
  @ApiProperty({ enum: ['ab', 'aab', 'agent'] }) class!: 'ab' | 'aab' | 'agent';
}

/** An invitation of *Tambah user*. */
export class UserInvitationViewDto implements UserInvitationView {
  @ApiProperty() id!: string;
  @ApiProperty() kpmId!: string;
  @ApiProperty({ example: 'Rina Kartika' }) fullName!: string;
  @ApiProperty({ example: '+6281277884410', description: 'Stored `+62…`: what WhatsApp opens to.' }) phone!: string;
  @ApiProperty({ type: String, nullable: true }) email!: string | null;
  @ApiProperty({ type: InvitationRoleDto }) role!: InvitationRoleDto;
  @ApiProperty({ type: String, nullable: true }) leaderMembershipId!: string | null;
  @ApiProperty() makeOwner!: boolean;
  @ApiProperty({ enum: ['pending', 'expired', 'accepted', 'cancelled'] }) state!: UserInvitationView['state'];
  @ApiProperty({ example: '2026-11-22T03:00:00.000Z', description: '*Diundang · <date>*.' }) invitedAt!: string;
  @ApiProperty({ example: '2026-12-06T03:00:00.000Z' }) expiresAt!: string;
}

class PlacedKpmDto implements PlacedKpm {
  @ApiProperty() id!: string;
  @ApiProperty({ example: '0602' }) code!: string;
  @ApiProperty({ example: 'Bekasi Barat Branch' }) branch!: string;
  @ApiProperty({ description: 'Made in this step (*＋ KPM baru*).' }) created!: boolean;
}

/** *Tambah user*'s answer. */
export class UserInvitedDto implements UserInvited {
  @ApiProperty({ enum: ['invited'] }) outcome!: 'invited';
  @ApiProperty({ type: UserInvitationViewDto }) invitation!: UserInvitationViewDto;
  @ApiProperty({
    example: 'https://app.agencyboost.id/user-invite/66f0000000000000000000a1.c2VjcmV0',
    description: 'The one-time link, in this answer and nowhere else: the reader’s own WhatsApp sends it (OD-359).',
  })
  link!: string;
  @ApiProperty({ type: PlacedKpmDto }) kpm!: PlacedKpmDto;
}

class PlacedPersonDto {
  @ApiProperty() userId!: string;
  @ApiProperty({ example: 'Fajar Nugroho' }) fullName!: string;
  @ApiProperty({ type: String, nullable: true, example: '+6281234567890' }) phone!: string | null;
  @ApiProperty({ example: 'fajar@email.com' }) email!: string;
}

/** *Masukkan*'s answer. */
export class UserPlacedDto implements UserPlaced {
  @ApiProperty({ enum: ['placed'] }) outcome!: 'placed';
  @ApiProperty() membershipId!: string;
  @ApiProperty({ type: PlacedKpmDto }) kpm!: PlacedKpmDto;
  @ApiProperty({ type: PlacedPersonDto }) person!: PlacedPersonDto;
  @ApiProperty({ example: 'https://app.agencyboost.id', description: 'For the WhatsApp message beside the in-app notice.' })
  appLink!: string;
}

/** *Kirim ulang*'s answer: the invitation, and its new link. */
export class UserInvitationResentDto {
  @ApiProperty({ type: UserInvitationViewDto }) invitation!: UserInvitationViewDto;
  @ApiProperty({ description: 'The new one-time link; the old one opens nothing now.' }) link!: string;
}

/** *Batalkan*'s answer. */
export class UserInvitationCancelledDto {
  @ApiProperty({ type: UserInvitationViewDto }) invitation!: UserInvitationViewDto;
}

/** The link's banner. */
export class UserInviteBannerDto implements UserInviteBanner {
  @ApiProperty({ example: 'Bekasi Barat Branch' }) kpmName!: string;
  @ApiProperty({ example: '0602' }) kpmCode!: string;
  @ApiProperty({ example: 'Prudential' }) companyName!: string;
  @ApiProperty({ example: 'Rina Kartika', description: 'The name the inviter typed.' }) fullName!: string;
  @ApiProperty({ example: 'Agent' }) roleLabel!: string;
  @ApiProperty({ description: 'Accepting also makes them an owner of the KPM.' }) makeOwner!: boolean;
  @ApiProperty({ example: '2026-12-06T03:00:00.000Z' }) expiresAt!: string;
}

/** The KPM the person is now an *Aktif* member of. */
export class UserInviteAcceptedDto implements UserInviteAccepted {
  @ApiProperty() kpmId!: string;
  @ApiProperty({ example: 'Bekasi Barat Branch' }) kpmName!: string;
  @ApiProperty() membershipId!: string;
}
