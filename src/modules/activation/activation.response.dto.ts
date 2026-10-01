import { ApiProperty } from '@nestjs/swagger';
import type {
  ActivationAspectView, ActivationChecklistView, ActivationItemView, ActivationLinkView,
  ActivationVersionView,
} from './activation.service';

/** The wire shape. Each `implements` its view, so the two cannot drift. */
export class ActivationLinkDto implements ActivationLinkView {
  @ApiProperty({ type: String, example: 'feature:goals' })
  kind!: string;

  @ApiProperty({ type: String, example: 'Goal Settings', description: 'What the new hire\'s "Go to {label} →" names.' })
  label!: string;

  @ApiProperty({ type: String, example: '/goals' })
  route!: string;

  @ApiProperty({ type: String, example: 'the hire has saved any goal since joining this office' })
  completesWhen!: string;

  @ApiProperty({
    type: Boolean,
    description:
      'Whether an evaluator exists yet. While it does not, a leader ticks the item by hand and the '
      + 'tick is recorded as manual; once it is live, no role may tick it.',
  })
  live!: boolean;
}

export class ActivationItemDto implements ActivationItemView {
  @ApiProperty({ type: String, example: 'GOAL_SETTING' })
  code!: string;

  @ApiProperty({ type: String })
  label!: string;

  @ApiProperty({ type: Number, description: 'Within its aspect. Presentation only.' })
  displayOrder!: number;

  @ApiProperty({ type: String, nullable: true, example: 'feature:goals' })
  autoLink!: string | null;

  @ApiProperty({ type: ActivationLinkDto, nullable: true, description: 'The link, resolved.' })
  link!: ActivationLinkDto | null;
}

export class ActivationAspectDto implements ActivationAspectView {
  @ApiProperty({ type: String, example: 'INITIAL_SETUP' })
  code!: string;

  @ApiProperty({ type: String, example: '2. Initial Setup' })
  label!: string;

  @ApiProperty({ type: Number })
  displayOrder!: number;

  @ApiProperty({ type: [ActivationItemDto] })
  items!: ActivationItemDto[];
}

export class ActivationVersionDto implements ActivationVersionView {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: Number, description: 'What a hire\'s activation records at creation.' })
  version!: number;

  @ApiProperty({ type: String, enum: ['draft', 'published'] })
  status!: 'draft' | 'published';

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  publishedAt!: string | null;

  @ApiProperty({ type: [ActivationAspectDto] })
  aspects!: ActivationAspectDto[];
}

export class ActivationChecklistDto implements ActivationChecklistView {
  @ApiProperty({
    type: ActivationVersionDto,
    nullable: true,
    description: 'The version hires starting now are given. `null` before the first publish.',
  })
  published!: ActivationVersionDto | null;

  @ApiProperty({
    type: ActivationVersionDto,
    nullable: true,
    description: 'The office\'s working copy. `null` when nothing has changed since publishing.',
  })
  draft!: ActivationVersionDto | null;

  @ApiProperty({
    type: Number,
    example: 90,
    description: 'The office\'s activation window, as provisioning seeded it. Shown beside the checklist; no route changes it.',
  })
  windowDays!: number;
}
