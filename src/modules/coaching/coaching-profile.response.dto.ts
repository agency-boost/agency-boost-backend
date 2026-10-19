import { ApiProperty } from '@nestjs/swagger';
import {
  CapabilityEntryDto, CapabilityGridDto, CapabilityStageDto,
} from '@/modules/capability/capability.response.dto';
import type {
  CoachingProfileSaved, CoachingProfileView, ProfileCatalogView, ProfilePerson,
} from './coaching-profile.service';
import type {
  LeaderNoteMine, LeaderNoteOther, LeaderNoteSaved, LeaderNotesView,
} from './leader-note.service';

/** Declared for OpenAPI. The wire shapes live on the services' view types. */

export class ProfilePersonDto implements ProfilePerson {
  @ApiProperty({ description: 'The membership: the person in this agency, never their account.' })
  membershipId!: string;

  @ApiProperty({ example: 'Sari Puspita', description: 'Empty when the membership can no longer be named.' })
  name!: string;
}

export class ProfileCatalogDto implements ProfileCatalogView {
  @ApiProperty({
    type: [CapabilityStageDto],
    description: 'The ladder, with what each stage requires and how senior it is. Archived stages included, with their status.',
  })
  stages!: CapabilityStageDto[];

  @ApiProperty({ type: [CapabilityEntryDto], description: 'Every milestone, archived ones included, with their status.' })
  milestones!: CapabilityEntryDto[];

  @ApiProperty({
    type: [CapabilityGridDto],
    description: 'The skill tracker’s grids and their items, archived ones included, with their status.',
  })
  grids!: CapabilityGridDto[];
}

export class CoachingProfileDto implements CoachingProfileView {
  @ApiProperty({
    type: ProfileCatalogDto,
    description:
      'The office’s capability catalog. An item the office archived still renders on a profile that ticked '
      + 'it, and is offered to no new tick.',
  })
  catalog!: ProfileCatalogDto;

  @ApiProperty({ type: [String], example: ['SELLS_INDEPENDENTLY'], description: 'The milestones ticked, by code.' })
  milestoneCodes!: string[];

  @ApiProperty({ type: [String], example: ['LEADS_GEN', 'APPROACH'], description: 'The skill items ticked, by code.' })
  skillCodes!: string[];

  @ApiProperty({
    type: String, nullable: true, example: 'COMPETENT_PRODUCER',
    description: 'The highest stage whose required milestones are all ticked; `null` below the first. Worked out on every read.',
  })
  stageCode!: string | null;

  @ApiProperty({ example: 2, description: 'The version the next save pins: 0 before the first save.' })
  version!: number;

  @ApiProperty({ type: String, nullable: true, example: '2026-10-02T03:00:00.000Z', description: '`null` before the first save.' })
  updatedAt!: string | null;

  @ApiProperty({ type: ProfilePersonDto, nullable: true, description: 'The coach who saved it last; `null` before the first save.' })
  updatedBy!: ProfilePerson | null;
}

export class CoachingProfileSavedDto implements CoachingProfileSaved {
  @ApiProperty({ example: 3, description: 'The version the next save pins.' })
  version!: number;

  @ApiProperty({ type: String, nullable: true, example: 'INDEPENDENT_PRODUCER', description: 'The stage the saved ticks give.' })
  stageCode!: string | null;

  @ApiProperty({ example: '2026-10-02T03:00:00.000Z' })
  updatedAt!: string;
}

export class LeaderNoteMineDto implements LeaderNoteMine {
  @ApiProperty() noteId!: string;

  @ApiProperty({ example: 'Ready for a bigger book.' }) text!: string;

  @ApiProperty({ example: 1, description: 'The version your next save pins.' }) version!: number;

  @ApiProperty({ example: '2026-10-02T03:00:00.000Z' }) updatedAt!: string;
}

export class LeaderNoteOtherDto implements LeaderNoteOther {
  @ApiProperty() noteId!: string;

  @ApiProperty({ type: ProfilePersonDto, description: 'The leader below you who wrote it.' })
  author!: ProfilePerson;

  @ApiProperty({ example: 'Strong on first meetings.' }) text!: string;

  @ApiProperty({ example: '2026-10-02T03:00:00.000Z' }) updatedAt!: string;
}

export class LeaderNotesDto implements LeaderNotesView {
  @ApiProperty({ type: LeaderNoteMineDto, nullable: true, description: 'Your own note about the person; `null` until you save one.' })
  mine!: LeaderNoteMine | null;

  @ApiProperty({
    type: LeaderNoteOtherDto, isArray: true,
    description: 'The notes leaders below you wrote about the person, newest first, read-only. Each one read is recorded.',
  })
  others!: LeaderNoteOther[];
}

export class LeaderNoteSavedDto implements LeaderNoteSaved {
  @ApiProperty() noteId!: string;

  @ApiProperty({ example: 2, description: 'The version your next save pins.' }) version!: number;

  @ApiProperty({ example: '2026-10-02T03:00:00.000Z' }) updatedAt!: string;
}
