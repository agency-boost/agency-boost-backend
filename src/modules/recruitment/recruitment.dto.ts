import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
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
