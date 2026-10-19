import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsInt, IsString, MaxLength, Min,
} from 'class-validator';

/**
 * **The limits a profile save and a note save are held to** (`functional/coaching.md`, the Data
 * contract): a note's text at most 4,000 characters, blank allowed; a code at most 64 characters, as
 * every catalog code and subject parameter is; and a tick list no longer than a catalog could be.
 */
export const PROFILE_LIMITS = { CODE_MAX: 64, CODES_MAX: 200 } as const;
export const NOTE_LIMITS = { TEXT_MAX: 4000 } as const;

/**
 * **A profile save: the whole tick set** (`PUT /coaching/coachees/:membershipId/profile`). A code not
 * sent is unticked. Pinned to the version it was read at, 0 before the first save.
 */
export class SaveCoachingProfileDto {
  @ApiProperty({
    example: 2,
    description:
      'The `version` this tick set was read at: 0 for a profile never saved. Refused with `409 '
      + 'VERSION_CONFLICT` when another coach saved it since.',
  })
  @IsInt() @Min(0)
  version!: number;

  @ApiProperty({
    type: String, isArray: true, maxItems: PROFILE_LIMITS.CODES_MAX, example: ['SELLS_INDEPENDENTLY'],
    description: 'Every capability milestone ticked, by the catalog’s code. A code sent twice is one tick.',
  })
  @IsArray() @ArrayMaxSize(PROFILE_LIMITS.CODES_MAX)
  @IsString({ each: true }) @MaxLength(PROFILE_LIMITS.CODE_MAX, { each: true })
  milestoneCodes!: string[];

  @ApiProperty({
    type: String, isArray: true, maxItems: PROFILE_LIMITS.CODES_MAX, example: ['LEADS_GEN', 'APPROACH'],
    description: 'Every skill-tracker item ticked, across the four grids, by the catalog’s code.',
  })
  @IsArray() @ArrayMaxSize(PROFILE_LIMITS.CODES_MAX)
  @IsString({ each: true }) @MaxLength(PROFILE_LIMITS.CODE_MAX, { each: true })
  skillCodes!: string[];
}

/**
 * **A note save** (`PUT /coaching/coachees/:membershipId/leader-notes`): the reader's own note about
 * somebody they coach, whole. Blank is a save, not a delete.
 */
export class SaveLeaderNoteDto {
  @ApiProperty({
    example: 1,
    description:
      'The `version` of your note this text replaces: 0 for your first note about the person. Refused '
      + 'with `409 VERSION_CONFLICT` when you saved it from somewhere else since.',
  })
  @IsInt() @Min(0)
  version!: number;

  @ApiProperty({
    maxLength: NOTE_LIMITS.TEXT_MAX,
    example: 'Strong on first meetings; loses momentum after the illustration.',
    description: 'The whole note. Blank is allowed. The text it replaces is kept.',
  })
  @IsString() @MaxLength(NOTE_LIMITS.TEXT_MAX)
  text!: string;
}
