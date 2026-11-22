import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsMongoId, IsOptional, IsString, MaxLength,
} from 'class-validator';

/** A company's changes and KPMs, with room: one request's work stays bounded. */
const MAX_CHANGES = 200;
const MAX_KPMS = 500;

/** `POST /admin/companies/:companyId/publication` (P19.23-T4 AC-5; ADR-0278 §5–§7). */
export class PublishToKpmsDto {
  @ApiProperty({
    type: [String],
    example: ['setting:activity_types', 'product:66f00000000000000000p001'],
    description: 'Step 1: the changes, by the ids `GET …/publication` gave them. Nothing is chosen for you.',
  })
  @IsArray() @ArrayMaxSize(MAX_CHANGES) @IsString({ each: true }) @MaxLength(80, { each: true })
  changes!: string[];

  @ApiProperty({
    type: [String],
    description: 'Step 2: the KPMs, each one of this company’s. Another company’s is `404`, and nothing is written. '
      + 'May be empty only when every change chosen reaches every KPM by itself (a product edit, Campaigns, Recruitment).',
  })
  @IsArray() @ArrayMaxSize(MAX_KPMS) @IsMongoId({ each: true })
  kpmIds!: string[];

  @ApiPropertyOptional({
    description: '*Saya paham pengaturan KPM ini akan ditimpa*: required when a KPM chosen changed a chosen setting '
      + 'itself. Without it the server, which works the KPMs’ own changes out again, refuses '
      + '`409 TEMPLATE_APPLY_UNCONFIRMED` and writes nothing.',
  })
  @IsOptional() @IsBoolean()
  overwriteConfirmed?: boolean;
}

/** `GET …/publication?summary=true`: the card's count alone, without reading every KPM's settings. */
export class PublicationQuery {
  @ApiPropertyOptional({ type: String, enum: ['true', 'false'] })
  @IsOptional() @IsIn(['true', 'false'])
  summary?: string;
}
