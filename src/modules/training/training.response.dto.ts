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
    example: 'Structured modules — tracked here, and later in your Skill Tracker.',
    description: 'The subtitle an agent\'s category page shows.',
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
