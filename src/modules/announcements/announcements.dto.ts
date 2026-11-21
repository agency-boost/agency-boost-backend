import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import { field } from '@/common/validation/violations';
import { ANNOUNCEMENT, type AnnouncementAudience } from '@/domain/constants';
import { ANNOUNCEMENTS_REFUSALS } from './announcements.messages';

const SAY = ANNOUNCEMENTS_REFUSALS.VALIDATION_FAILED;

/** **Who an announcement goes to** (P19.23-T6 AC-4): *Kepada*, and with `selected` what was chosen. */
export class AnnouncementAudienceDto {
  @ApiProperty({
    enum: ANNOUNCEMENT.AUDIENCES,
    description: '*Semua owner* (`owners`), *Semua anggota* (`members`) or *Pilih perusahaan / KPM* (`selected`).',
  })
  @IsIn(ANNOUNCEMENT.AUDIENCES, { message: field(SAY.audience) })
  audience!: AnnouncementAudience;

  @ApiPropertyOptional({ type: [String], description: 'With `selected`: every active member of each company’s live KPMs.' })
  @IsOptional()
  @IsArray({ message: field(SAY.ids) })
  @ArrayMaxSize(ANNOUNCEMENT.SELECTED_MAX, { message: field(SAY.ids) })
  @IsMongoId({ each: true, message: field(SAY.ids) })
  companyIds?: string[];

  @ApiPropertyOptional({ type: [String], description: 'With `selected`: every active member of each KPM.' })
  @IsOptional()
  @IsArray({ message: field(SAY.ids) })
  @ArrayMaxSize(ANNOUNCEMENT.SELECTED_MAX, { message: field(SAY.ids) })
  @IsMongoId({ each: true, message: field(SAY.ids) })
  kpmIds?: string[];
}

/** **`POST /admin/platform/announcements`** (P19.23-T6 AC-4): the audience and the message. */
export class SendAnnouncementDto extends AnnouncementAudienceDto {
  @ApiProperty({
    example: 'Fitur proposal baru sudah tersedia di menu Leads.',
    maxLength: ANNOUNCEMENT.MESSAGE_MAX_LENGTH,
    description: '*Pesan*, trimmed: 1 to 500 characters. Sent as written, in every reader’s language alike.',
  })
  @IsString({ message: field(SAY.message) })
  @MaxLength(ANNOUNCEMENT.MESSAGE_MAX_LENGTH + 200, { message: field(SAY.message) })
  message!: string;
}
