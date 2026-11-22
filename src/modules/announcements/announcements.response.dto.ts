import { ApiProperty } from '@nestjs/swagger';
import { ANNOUNCEMENT, type AnnouncementAudience } from '@/domain/constants';

/** **What *Pratinjau* and *Kirim ke …* read** (P19.23-T6 AC-4): how many people the audience reaches now. */
export class AnnouncementPreviewDto {
  @ApiProperty({ enum: ANNOUNCEMENT.AUDIENCES })
  audience!: AnnouncementAudience;

  @ApiProperty({ type: Number, example: 8, description: 'Each person once; test accounts never counted.' })
  recipients!: number;
}

export class AnnouncementSenderDto {
  @ApiProperty({ type: String })
  userId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Their name, or null if the account is gone.' })
  fullName!: string | null;
}

/** **One sent announcement** (P19.23-T6 AC-4). */
export class AnnouncementDto {
  @ApiProperty({ type: String })
  announcementId!: string;

  @ApiProperty({ type: String })
  message!: string;

  @ApiProperty({ enum: ANNOUNCEMENT.AUDIENCES })
  audience!: AnnouncementAudience;

  @ApiProperty({
    type: [String],
    description: 'With `selected`: the names chosen — companies, then *KPM 0417 · Bandung* — for the list’s line.',
  })
  chosen!: string[];

  @ApiProperty({ type: Number, example: 8 })
  recipientCount!: number;

  @ApiProperty({ type: () => AnnouncementSenderDto })
  sentBy!: AnnouncementSenderDto;

  @ApiProperty({ type: String, format: 'date-time' })
  sentAt!: string;
}
