import { ApiProperty } from '@nestjs/swagger';
import { RECRUITMENT_PITCH_SLOTS, RECRUITMENT_PITCH_STATES } from '@/domain/constants';

/** A chip: its code, and its label verbatim. */
export class RecruitmentChoiceDto {
  @ApiProperty({ type: String, example: 'retiree' })
  code!: string;

  @ApiProperty({ type: String, example: 'Retiree' })
  label!: string;
}

export class RecruitmentVocabularyDto {
  @ApiProperty({ type: [RecruitmentChoiceDto], description: '*Candidate type*, in the chips’ order.' })
  types!: RecruitmentChoiceDto[];

  @ApiProperty({ type: [RecruitmentChoiceDto], description: '*What’s driving them*, in the chips’ order.' })
  motivations!: RecruitmentChoiceDto[];

  @ApiProperty({ type: [RecruitmentChoiceDto], description: '*Their biggest hesitation*, in the chips’ order.' })
  hesitations!: RecruitmentChoiceDto[];
}

export class RecruitmentBriefDto {
  @ApiProperty({ type: RecruitmentChoiceDto })
  type!: RecruitmentChoiceDto;

  @ApiProperty({ type: [RecruitmentChoiceDto], description: 'In the chips’ order, whatever order they were sent in.' })
  motivations!: RecruitmentChoiceDto[];

  @ApiProperty({ type: [RecruitmentChoiceDto], description: 'In the chips’ order.' })
  hesitations!: RecruitmentChoiceDto[];
}

export class RecruitmentProfileDto {
  @ApiProperty({ type: String, example: 'retiree' })
  code!: string;

  @ApiProperty({ type: String, description: 'The profile’s own label — *Fresh graduate* for the chip *Fresh grad*.' })
  label!: string;

  @ApiProperty({ type: String })
  tagline!: string;

  @ApiProperty({ type: String, description: '*Good fit for*.' })
  goodFitFor!: string;

  @ApiProperty({ type: [String], description: '*Lead with these benefits*.' })
  benefits!: string[];
}

export class RecruitmentOpeningDto {
  @ApiProperty({ type: RecruitmentChoiceDto, description: 'The motivation it opens on — tagged on screen only when there are several.' })
  motivation!: RecruitmentChoiceDto;

  @ApiProperty({ type: String })
  text!: string;
}

export class RecruitmentObjectionDto {
  @ApiProperty({ type: RecruitmentChoiceDto })
  hesitation!: RecruitmentChoiceDto;

  @ApiProperty({ type: String, description: '*They say*.' })
  theySay!: string;

  @ApiProperty({ type: String, description: '*You say*.' })
  youSay!: string;

  @ApiProperty({ type: Boolean, description: 'True when the words are the profile’s own for this hesitation, not the base.' })
  profileOwn!: boolean;
}

export class RecruitmentPlanDto {
  @ApiProperty({ type: RecruitmentBriefDto })
  brief!: RecruitmentBriefDto;

  @ApiProperty({ type: RecruitmentProfileDto })
  profile!: RecruitmentProfileDto;

  @ApiProperty({ type: [RecruitmentOpeningDto], description: 'One per motivation chosen, in the chips’ order.' })
  openings!: RecruitmentOpeningDto[];

  @ApiProperty({ type: [RecruitmentObjectionDto], description: 'One per hesitation chosen, in the chips’ order.' })
  objections!: RecruitmentObjectionDto[];

  @ApiProperty({ type: String, description: '*Next action*.' })
  nextAction!: string;
}

export class RecruitmentAttackPlanDto {
  @ApiProperty({ type: Boolean, description: 'False when the office’s company has no recruitment playbook; `plan` is then null.' })
  hasPlaybook!: boolean;

  @ApiProperty({ type: RecruitmentVocabularyDto })
  vocabulary!: RecruitmentVocabularyDto;

  @ApiProperty({ type: RecruitmentPlanDto, nullable: true, description: 'Null with no brief, or with no playbook.' })
  plan!: RecruitmentPlanDto | null;
}

export class PitchFileDto {
  @ApiProperty({ type: String, description: 'The name it was uploaded under.' })
  name!: string;

  @ApiProperty({ type: Number, description: 'Its size as storage reported it.' })
  bytes!: number;

  @ApiProperty({ type: String, format: 'date', example: '2026-09-12', description: 'The day it was attached, in the office’s calendar.' })
  uploadedOn!: string;

  @ApiProperty({
    type: String,
    example: 'application/pdf',
    description: 'What storage holds, as confirmed (ADR-0040): `application/pdf`, or `text/html`, which a reader draws '
      + 'only inside a sandboxed frame and never opens on its own (ADR-0217 §4).',
  })
  mimeType!: string;
}

export class PitchChecklistItemDto {
  @ApiProperty({ type: String, example: 'career-path' })
  code!: string;

  @ApiProperty({ type: String })
  label!: string;

  @ApiProperty({ type: Boolean })
  ticked!: boolean;
}

export class PitchSlotDto {
  @ApiProperty({ enum: RECRUITMENT_PITCH_SLOTS.map((s) => s.code) })
  slot!: string;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  line!: string;

  @ApiProperty({
    type: Boolean,
    description:
      'True for the four documents the office’s readiness counts; false for the two optional ones, *Company '
      + 'Profile* and *Agency Profile*, which count in neither the ring nor the banner.',
  })
  required!: boolean;

  @ApiProperty({ enum: RECRUITMENT_PITCH_STATES })
  state!: string;

  @ApiProperty({ type: PitchFileDto, nullable: true, description: 'Null where the slot holds nothing.' })
  file!: PitchFileDto | null;

  @ApiProperty({ type: [PitchChecklistItemDto], description: 'Empty for a slot with no checklist. Never who ticked.' })
  checklist!: PitchChecklistItemDto[];

  @ApiProperty({ type: Number, description: '0 while the slot has never held a file; moves with every file attached.' })
  version!: number;
}

/** The banner's counts — over the required slots alone; an optional one counts in none of them. */
export class PitchSummaryDto {
  @ApiProperty({ type: Number, description: 'Required slots complete, or uploaded with nothing to confirm.' })
  done!: number;

  @ApiProperty({ type: Number, example: 4, description: 'How many slots are required: the four.' })
  total!: number;

  @ApiProperty({ type: Number, description: 'Required slots with no file.' })
  missing!: number;

  @ApiProperty({ type: Number, description: 'Required slots with a file and an item still open.' })
  unconfirmed!: number;
}

export class PitchMaterialsDto {
  @ApiProperty({
    type: [PitchSlotDto],
    description: 'The six, in order: the four required, then *Company Profile* and *Agency Profile*, optional.',
  })
  slots!: PitchSlotDto[];

  @ApiProperty({ type: PitchSummaryDto })
  summary!: PitchSummaryDto;
}

export class PitchDocumentUrlDto {
  @ApiProperty({ type: String, description: 'Valid for 300 seconds.' })
  url!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: string;
}

export class RecruitmentPlaybookLimitsDto {
  @ApiProperty({ type: Number, example: 600, description: 'The most characters any text may hold, once trimmed (at least 1).' })
  textMax!: number;

  @ApiProperty({ type: Number, example: 6, description: 'The most benefits a profile may list (at least 1).' })
  benefitsMax!: number;
}
