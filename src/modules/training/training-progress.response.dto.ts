import { ApiProperty } from '@nestjs/swagger';
import { TRAINING_STATUSES, type TrainingStatus } from '@/domain/constants';
import {
  TRAINING_ITEM_KINDS, type TrainingArchivedModuleView, type TrainingCategoryProgressView, type TrainingItemKind,
  type TrainingItemView, type TrainingModulePageView, type TrainingModuleRowView, type TrainingOpenView,
  type TrainingProgressView, type TrainingSkillProgressView,
} from './training-progress.view';

/** The wire shapes of a member's training (P18.5-T1, T2, T4). Each `implements` its view, so the two cannot drift. */

const DONE = 'Offered modules in this scope marked *Done*.';
const TOTAL = 'Offered modules in this scope. A draft, or a module withdrawn since the office last published, is in neither number.';
const PCT = '`done / total` as a whole percent (`TRAINING_COMPLETION_PCT`); `null` when the scope offers nothing — draw (0/0), never 0%.';

export class TrainingModuleRowDto implements TrainingModuleRowView {
  @ApiProperty({ type: String, example: 'PROSPECT_LIST' })
  code!: string;

  @ApiProperty({ type: String, example: 'Building Your Prospect List' })
  title!: string;

  @ApiProperty({
    type: [String], enum: TRAINING_ITEM_KINDS,
    description: 'The kinds its content holds now, File · Video · Link order. Empty: the module holds nothing yet.',
  })
  formats!: TrainingItemKind[];

  @ApiProperty({ type: String, enum: TRAINING_STATUSES, description: '`not_started` for a module never touched.' })
  status!: TrainingStatus;

  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'The last move to *Done*, while it is done.' })
  completedAt!: string | null;
}

export class TrainingArchivedModuleDto implements TrainingArchivedModuleView {
  @ApiProperty({ type: String, example: 'CLIENT_RETENTION' })
  code!: string;

  @ApiProperty({ type: String, example: 'Client Retention Best Practices' })
  title!: string;

  @ApiProperty({
    type: [String], enum: TRAINING_ITEM_KINDS,
    description: 'The kinds its content holds, File · Video · Link order, as an offered row’s.',
  })
  formats!: TrainingItemKind[];

  @ApiProperty({ type: String, enum: ['done'] })
  status!: 'done';

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  completedAt!: string | null;
}

export class TrainingSkillProgressDto implements TrainingSkillProgressView {
  @ApiProperty({ type: String, example: 'PROSPECTING' })
  code!: string;

  @ApiProperty({ type: String, example: 'Prospecting' })
  label!: string;

  @ApiProperty({ type: Boolean, description: '`false` only for a skill no longer offered that still holds this member’s history.' })
  offered!: boolean;

  @ApiProperty({ type: Number, description: DONE })
  done!: number;

  @ApiProperty({ type: Number, description: TOTAL })
  total!: number;

  @ApiProperty({ type: Number, nullable: true, description: PCT })
  pct!: number | null;

  @ApiProperty({ type: [TrainingModuleRowDto], description: 'The offered modules, in display order.' })
  modules!: TrainingModuleRowDto[];

  @ApiProperty({
    type: [TrainingArchivedModuleDto],
    description: 'Modules this member marked done that are no longer offered: their history, outside every count.',
  })
  archived!: TrainingArchivedModuleDto[];
}

export class TrainingCategoryProgressDto implements TrainingCategoryProgressView {
  @ApiProperty({ type: String, example: 'SALES' })
  code!: string;

  @ApiProperty({ type: String, example: 'Sales' })
  label!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The office’s subtitle for the category.' })
  description!: string | null;

  @ApiProperty({ type: Boolean, description: '`false` only for a category no longer offered that still holds this member’s history.' })
  offered!: boolean;

  @ApiProperty({ type: Number, description: DONE })
  done!: number;

  @ApiProperty({ type: Number, description: TOTAL })
  total!: number;

  @ApiProperty({ type: Number, nullable: true, description: PCT })
  pct!: number | null;

  @ApiProperty({
    type: [TrainingSkillProgressDto],
    description: 'In display order. A skill with nothing offered and no history is left out.',
  })
  skills!: TrainingSkillProgressDto[];
}

export class TrainingProgressDto implements TrainingProgressView {
  @ApiProperty({ type: String, description: 'Whose training this is.' })
  membershipId!: string;

  @ApiProperty({ type: Number, description: `${DONE} The whole catalog.` })
  done!: number;

  @ApiProperty({ type: Number, description: `${TOTAL} The whole catalog.` })
  total!: number;

  @ApiProperty({ type: Number, nullable: true, description: PCT })
  pct!: number | null;

  @ApiProperty({
    type: [TrainingCategoryProgressDto],
    description: 'Every offered category in display order — an empty one included — then any no longer offered that hold history.',
  })
  categories!: TrainingCategoryProgressDto[];

  @ApiProperty({ type: Boolean, description: 'Every offered module done; `false` when nothing is offered.' })
  allOfferedDone!: boolean;
}

export class TrainingItemDto implements TrainingItemView {
  @ApiProperty({ type: String, description: 'The content item’s stable id.' })
  id!: string;

  @ApiProperty({ type: String, enum: TRAINING_ITEM_KINDS })
  kind!: TrainingItemKind;

  @ApiProperty({ type: String, example: 'Prospect list worksheet.pdf', description: 'The item’s own name.' })
  label!: string;

  @ApiProperty({ type: String, nullable: true, example: 'application/pdf' })
  mimeType!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  bytes!: number | null;

  @ApiProperty({
    type: String, nullable: true,
    description: 'A link’s own `https` address, so it opens at once; `null` for a file or a video, whose address is signed on open.',
  })
  url!: string | null;
}

class TrainingPlaceDto {
  @ApiProperty({ type: String })
  code!: string;

  @ApiProperty({ type: String })
  label!: string;
}

class TrainingModuleCanDto {
  @ApiProperty({
    type: Boolean,
    description: 'You may set the status: never in a support session, never without a field rung.',
  })
  update!: boolean;
}

export class TrainingModulePageDto implements TrainingModulePageView {
  @ApiProperty({ type: String, example: 'CLOSING_TECHNIQUES' })
  code!: string;

  @ApiProperty({ type: String, example: 'Closing Techniques That Work' })
  title!: string;

  @ApiProperty({ type: TrainingPlaceDto })
  category!: TrainingPlaceDto;

  @ApiProperty({ type: TrainingPlaceDto })
  skill!: TrainingPlaceDto;

  @ApiProperty({ type: [TrainingItemDto], description: 'Files, then videos, then links, each in its stored order.' })
  items!: TrainingItemDto[];

  @ApiProperty({ type: String, enum: TRAINING_STATUSES })
  status!: TrainingStatus;

  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'The first move away from *Not started*.' })
  startedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time', description: 'The last move to *Done*, while it is done.' })
  completedAt!: string | null;

  @ApiProperty({ type: [String], description: 'Items you have opened at least once.' })
  openedItemIds!: string[];

  @ApiProperty({ type: TrainingModuleCanDto })
  can!: TrainingModuleCanDto;
}

export class TrainingOpenDto implements TrainingOpenView {
  @ApiProperty({ type: String, description: 'Signed for 300 seconds for a file or a video; a link’s own address for a link.' })
  url!: string;

  @ApiProperty({ type: [String], description: 'Items you have opened at least once, after this call.' })
  openedItemIds!: string[];

  @ApiProperty({ type: Boolean, description: 'This call recorded the item’s first open. Nothing is recorded in a support session.' })
  recorded!: boolean;
}
