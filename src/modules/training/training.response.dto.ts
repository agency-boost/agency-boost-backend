import { ApiProperty } from '@nestjs/swagger';
import { TRAINING_PUBLISH_STATES, type TrainingPublishState } from '@/domain/constants';
import type {
  TrainingCategoryView, TrainingModuleView, TrainingSkillView,
} from './training.service';

/** The wire shape of one training module. `implements` the view, so the two cannot drift. */
export class TrainingModuleDto implements TrainingModuleView {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String, example: 'PROSPECT_LIST', description: 'The identity. Never changes, never reused.' })
  code!: string;

  @ApiProperty({
    type: String,
    example: 'PROSPECTING',
    description: 'The skill it teaches. **Its category is that skill\'s**, never stored here.',
  })
  skillCode!: string;

  @ApiProperty({ type: String, example: 'Building Your Prospect List' })
  title!: string;

  @ApiProperty({
    enum: TRAINING_PUBLISH_STATES,
    description:
      'Whether agents are offered the module **at all**. Not when: that is the office\'s own '
      + 'publish. A draft never reaches an agent.',
  })
  publishState!: TrainingPublishState;

  @ApiProperty({ type: Number, description: 'Within its skill. Presentation only.' })
  displayOrder!: number;

  @ApiProperty({ type: Number })
  version!: number;

  @ApiProperty({ type: String, enum: ['active', 'archived'] })
  status!: 'active' | 'archived';
}

export class TrainingSkillDto implements TrainingSkillView {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String, example: 'PROSPECTING' })
  code!: string;

  @ApiProperty({ type: String, example: 'SALES' })
  categoryCode!: string;

  @ApiProperty({ type: String, example: 'Prospecting' })
  label!: string;

  @ApiProperty({ type: Number, description: 'Within its category.' })
  displayOrder!: number;

  @ApiProperty({ type: Number })
  version!: number;

  @ApiProperty({ type: String, enum: ['active', 'archived'] })
  status!: 'active' | 'archived';

  @ApiProperty({ type: [TrainingModuleDto] })
  modules!: TrainingModuleDto[];
}

export class TrainingCategoryDto implements TrainingCategoryView {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String, example: 'SALES' })
  code!: string;

  @ApiProperty({ type: String, example: 'Sales' })
  label!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Find prospects, uncover their needs, answer objections and close.',
    description: 'The subtitle an agent\'s category page shows: one line saying what the category teaches.',
  })
  description!: string | null;

  @ApiProperty({ type: Number })
  displayOrder!: number;

  @ApiProperty({ type: Number })
  version!: number;

  @ApiProperty({ type: String, enum: ['active', 'archived'] })
  status!: 'active' | 'archived';

  @ApiProperty({ type: [TrainingSkillDto] })
  skills!: TrainingSkillDto[];
}

// ------------------------------------------------------------ a module's content (P5-T2)

export class ContentFileDto {
  @ApiProperty({ type: String, description: 'Stable for the life of the item.' })
  id!: string;

  @ApiProperty({ type: String })
  label!: string;

  @ApiProperty({
    type: String,
    description:
      'The key, never a URL. A URL is minted per request, signed, and expires in 300 seconds; a '
      + 'stored one would be a permanent public link to a private file.',
  })
  storageKey!: string;

  @ApiProperty({ type: String })
  mimeType!: string;

  @ApiProperty({ type: Number })
  bytes!: number;
}

export class ContentLinkDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String })
  label!: string;

  @ApiProperty({ type: String, description: '`https` only.' })
  url!: string;
}

export class ContentDto {
  @ApiProperty({ type: [ContentFileDto] })
  files!: ContentFileDto[];

  @ApiProperty({ type: [ContentFileDto] })
  videos!: ContentFileDto[];

  @ApiProperty({ type: [ContentLinkDto] })
  links!: ContentLinkDto[];
}

export class ModuleContentDto {
  @ApiProperty({ type: String })
  moduleCode!: string;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: ContentDto, description: 'What agents in this office are shown.' })
  content!: ContentDto;

  @ApiProperty({
    type: ContentDto,
    description: 'The company\'s material, always — so a screen can say what "use theirs again" restores.',
  })
  companyContent!: ContentDto;

  @ApiProperty({ type: Boolean, description: 'False while this office uses the company\'s material unchanged.' })
  overridden!: boolean;
}

/** The shared signed-upload shape, kept importable from here for the training routes that name it. */
export { SignedUploadDto } from '@/modules/assets/asset.response.dto';

export class SignedUrlDto {
  @ApiProperty({ type: String, description: 'Valid for 300 seconds.' })
  url!: string;
}
