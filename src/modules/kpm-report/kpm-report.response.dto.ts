import { ApiProperty } from '@nestjs/swagger';

/** One owner *Kirim ke owner* can send to (P19.27-T5 AC-1; ADR-0285 §5): who, and the number WhatsApp opens to. */
export class KpmReportRecipientDto {
  @ApiProperty({ nullable: true, type: String, description: 'The owner\'s account; `null` for the owner named and waiting (`pendingOwner`).' })
  userId!: string | null;

  @ApiProperty({ example: 'Wilson Tanoto' })
  name!: string;

  @ApiProperty({ example: '+62 811 2000 300', nullable: true, type: String, description: 'Their WhatsApp number as on file; `null`: none.' })
  phone!: string | null;
}

/** ***Kirim ke owner*** (P19.24-T2 AC-1; OD-359, OD-428): the link the Super Admin's own WhatsApp sends, and what the message names. */
export class KpmReportLinkViewDto {
  @ApiProperty({ example: 'https://agencyboost.id/laporan-kpm/eyJ2Ijox….Qm9…', description: 'The link, `<app>/laporan-kpm/<token>`, in this answer and nowhere else.' })
  link!: string;

  @ApiProperty({ example: '2026-10' })
  month!: string;

  @ApiProperty({ example: '2026-11-27T03:00:00.000Z', description: 'When the link stops opening: `KPM_REPORT.LINK_TTL_DAYS` (7) after it is made.' })
  expiresAt!: string;

  @ApiProperty({ example: 'BSD City Branch' })
  kpmName!: string;

  @ApiProperty({ example: '0417' })
  kpmCode!: string;

  @ApiProperty({ example: 'Prudential' })
  companyName!: string;

  @ApiProperty({ example: 'Wilson Tanoto', nullable: true, type: String, description: 'The first owner (ADR-0285 §3), or the Owner named and waiting; `null`: none.' })
  ownerName!: string | null;

  @ApiProperty({ example: '+62 811 2000 300', nullable: true, type: String, description: 'The Owner\'s WhatsApp number as on file; `null`: none — WhatsApp then asks whom to send it to.' })
  ownerPhone!: string | null;

  @ApiProperty({
    type: () => KpmReportRecipientDto, isArray: true,
    description: '**Every owner**, in order of `since` (ADR-0285 §5): the pick-list, every one chosen by default, '
      + 'one WhatsApp link each (OD-359). The owner named and waiting when the KPM has none. Empty: nobody to send to.',
  })
  owners!: KpmReportRecipientDto[];
}
