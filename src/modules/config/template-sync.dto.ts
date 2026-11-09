import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined, IsInt, IsObject, IsOptional, IsString, Length, Min, ValidateIf, ValidateNested,
} from 'class-validator';
import { TEMPLATE_SYNC_LEVELS, type TemplateSyncLevel } from './template-sync';

/** The template versions a preview read: each kind's newest published version, or `null` where it has none. */
export class TemplateSyncVersionsDto {
  @ApiProperty({ type: Number, nullable: true, example: 7 })
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(1)
  training_taxonomy!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 4 })
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(1)
  capability_ladder!: number | null;
}

/** `POST /kpm/settings/training/template-sync` (ADR-0220 §4): what the dialog's preview read. */
export class ApplyTemplateSyncDto {
  @ApiProperty({
    type: TemplateSyncVersionsDto,
    description: 'The template versions the preview read. Either moved since: `409 VERSION_CONFLICT`, nothing written.',
  })
  @IsDefined() @IsObject() @ValidateNested() @Type(() => TemplateSyncVersionsDto)
  templateVersions!: TemplateSyncVersionsDto;

  @ApiProperty({
    type: String,
    example: '3f9a0c1d2b4e5f60',
    description: 'The KPM’s `revision` the preview read. Its training or capability changed since: `409 VERSION_CONFLICT`.',
  })
  @IsString() @Length(1, 64)
  expectedRevision!: string;
}

/** One name or description that would change, old beside new. */
export class TemplateSyncDifferenceDto {
  @ApiProperty({ enum: TEMPLATE_SYNC_LEVELS })
  level!: TemplateSyncLevel;

  @ApiProperty({ type: String, example: 'LEADS_GEN', description: 'By code; a capability item’s is `<GRID>:<ITEM>`.' })
  code!: string;

  @ApiProperty({ enum: ['name', 'description'] })
  field!: 'name' | 'description';

  @ApiProperty({ type: String, nullable: true, description: 'The KPM’s now.' })
  from!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The template’s.' })
  to!: string | null;
}

export class TemplateSyncTemplateDto {
  @ApiProperty({ type: String })
  id!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Its name when the KPM was made from it.' })
  name!: string | null;
}

export class TemplateSyncViewDto {
  @ApiProperty({ type: TemplateSyncTemplateDto, nullable: true, description: '`null`: the KPM was made from no template.' })
  template!: TemplateSyncTemplateDto | null;

  @ApiProperty({ type: TemplateSyncVersionsDto })
  templateVersions!: TemplateSyncVersionsDto;

  @ApiProperty({ type: String, description: 'What an apply sends back as `expectedRevision`.' })
  revision!: string;

  @ApiProperty({
    type: [TemplateSyncDifferenceDto],
    description: 'Categories, skills, modules, then capability items. Empty: nothing differs, and the control is not shown.',
  })
  differences!: TemplateSyncDifferenceDto[];
}

export class TemplateSyncResultDto {
  @ApiProperty({
    enum: ['published', 'awaiting_publish', 'unchanged'],
    description: '`published`: a new version, origin `template_sync`. `awaiting_publish`: the KPM had changes of its own '
      + 'waiting, and these wait with them for *Terbitkan ke agent*. `unchanged`: nothing differed.',
  })
  outcome!: 'published' | 'awaiting_publish' | 'unchanged';

  @ApiProperty({ type: [TemplateSyncDifferenceDto], description: 'What was written.' })
  differences!: TemplateSyncDifferenceDto[];

  @ApiProperty({ type: String })
  revision!: string;
}
