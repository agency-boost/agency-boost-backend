import { ApiProperty } from '@nestjs/swagger';
import type { OwnerInviteAccepted, OwnerInviteBanner, OwnerWhatsAppInvitation } from './owner-claims.service';

/** *Kirim undangan* by WhatsApp (P19.23-T2 AC-3; OD-420): the one-time link and what the message names. */
export class OwnerWhatsAppInvitationDto implements OwnerWhatsAppInvitation {
  @ApiProperty({
    enum: ['claim', 'password'],
    description: '`claim` — the Owner named with no email: the link lets them sign in or sign up and claim the KPM. '
      + '`password` — an Owner whose account never signed in: the email invitation\'s link to choose a password.',
  })
  kind!: 'claim' | 'password';

  @ApiProperty({
    example: 'https://app.agencyboost.id/owner-invite/66f0000000000000000000a1.Q2xhaW0tbGluay1zZWNyZXQ',
    description: 'The one-time link, in this answer and nowhere else. A new one replaces the last.',
  })
  link!: string;

  @ApiProperty({ example: 'BUDI HARTONO' })
  ownerName!: string;

  @ApiProperty({ type: String, nullable: true, example: '+6281234567890', description: 'What WhatsApp opens to.' })
  ownerPhone!: string | null;

  @ApiProperty({ example: 'Serpong Branch' })
  kpmName!: string;

  @ApiProperty({ example: '0418' })
  kpmCode!: string;

  @ApiProperty({ example: 'Prudential' })
  companyName!: string;

  @ApiProperty({ example: '2026-11-27T03:00:00.000Z' })
  expiresAt!: string;
}

/** The claim link's banner: which KPM, of which company, for whom (OD-420). */
export class OwnerInviteBannerDto implements OwnerInviteBanner {
  @ApiProperty({ example: 'Serpong Branch' })
  kpmName!: string;

  @ApiProperty({ example: '0418' })
  kpmCode!: string;

  @ApiProperty({ example: 'Prudential' })
  companyName!: string;

  @ApiProperty({ example: 'BUDI HARTONO', description: 'The person the Super Admin named as the Owner.' })
  ownerName!: string;

  @ApiProperty({ example: '2026-11-27T03:00:00.000Z' })
  expiresAt!: string;
}

/** The KPM the person now owns. */
export class OwnerInviteAcceptedDto implements OwnerInviteAccepted {
  @ApiProperty({ example: '66f0000000000000000000a1' })
  kpmId!: string;

  @ApiProperty({ example: 'Serpong Branch' })
  kpmName!: string;
}
