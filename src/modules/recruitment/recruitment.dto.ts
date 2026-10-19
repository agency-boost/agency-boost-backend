import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';
import {
  RECRUITMENT_CANDIDATE_TYPES, RECRUITMENT_HESITATIONS, RECRUITMENT_MOTIVATIONS,
} from '@/domain/constants';

const codes = (vocabulary: readonly { code: string }[]) => vocabulary.map((c) => `\`${c.code}\``).join(', ');

/**
 * **The candidate brief, as the plan's address carries it** (D-urls): codes only, never a name. All three
 * or none; anything else by any other name is refused by name, as every query here refuses one.
 */
export class RecruitmentBriefQueryDto {
  @ApiPropertyOptional({
    maxLength: 64,
    example: 'retiree',
    description: `*Candidate type*: one of ${codes(RECRUITMENT_CANDIDATE_TYPES)}.`,
  })
  @IsOptional() @IsString() @MaxLength(64)
  type?: string;

  @ApiPropertyOptional({
    maxLength: 256,
    example: 'flexibility,leadership',
    description:
      `*What's driving them*: one or more of ${codes(RECRUITMENT_MOTIVATIONS)}, comma-separated, none twice. `
      + 'Answered in the chips’ order, whatever order they are sent in.',
  })
  @IsOptional() @IsString() @MaxLength(256)
  motivation?: string;

  @ApiPropertyOptional({
    maxLength: 256,
    example: 'no-network,time',
    description:
      `*Their biggest hesitation*: one or more of ${codes(RECRUITMENT_HESITATIONS)}, comma-separated, none `
      + 'twice. Answered in the chips’ order.',
  })
  @IsOptional() @IsString() @MaxLength(256)
  hesitation?: string;
}

export class AttachPitchDocumentDto {
  @ApiProperty({
    maxLength: 300,
    description: 'A key this office was signed by `POST /kpm/settings/recruitment-pitch/uploads`, its bytes sent.',
  })
  @IsString() @MaxLength(300)
  storageKey!: string;
}

export class SetPitchConfirmationDto {
  @ApiProperty({ type: Boolean, description: 'True to tick the item, false to untick it.' })
  @IsBoolean()
  ticked!: boolean;

  @ApiProperty({
    type: Number,
    minimum: 1,
    description: 'The slot’s `version` as read: the file the tick is about. A file replaced since is `409`.',
  })
  @IsInt() @Min(1)
  version!: number;
}

export class SaveRecruitmentPlaybookDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 1,
    description:
      'The version read. `null` only to create the company’s first playbook — `409` if it has one.',
  })
  // `null` is a value here — create — so only a present number is checked as one; absent fails `@IsInt`.
  @ValidateIf((dto: SaveRecruitmentPlaybookDto) => dto.version !== null)
  @IsInt() @Min(1)
  version!: number | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The whole playbook: `profiles` (every candidate type: `label`, `tagline`, `goodFitFor`, 1 to 6 '
      + '`benefits`, and `openings` with one per motivation), `objections` (one `{ theySay, youSay }` per '
      + 'hesitation), `profileObjections` (a profile’s own, by type then hesitation, optional) and '
      + '`nextAction`. Each text 1 to 600 characters once trimmed. Checked whole: every violation is named.',
  })
  @IsObject()
  body!: Record<string, unknown>;
}
