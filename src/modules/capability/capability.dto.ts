import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

const PARTS = ['stage', 'milestone', 'grid', 'item'] as const;

export class RenameCapabilityDto {
  @ApiProperty({ enum: PARTS })
  @IsIn(PARTS as unknown as string[])
  part!: string;

  @ApiProperty({ description: 'The code. It is never changed by this — only the label moves.' })
  @IsString() @MaxLength(60)
  code!: string;

  @ApiProperty()
  @IsString() @MaxLength(200)
  label!: string;

  @ApiPropertyOptional({ description: 'Required when `part` is `item`: which grid it is in.' })
  @IsOptional() @IsString() @MaxLength(60)
  gridCode?: string;
}

export class SetCapabilityStatusDto {
  @ApiProperty({ enum: PARTS })
  @IsIn(PARTS as unknown as string[])
  part!: string;

  @ApiProperty()
  @IsString() @MaxLength(60)
  code!: string;

  @ApiProperty({
    enum: ['active', 'archived'],
    description: 'There is no delete. An archived item stays readable on assessments that hold it.',
  })
  @IsIn(['active', 'archived'])
  status!: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(60)
  gridCode?: string;
}

export class AddCapabilityDto {
  @ApiProperty({
    enum: PARTS,
    description: '`stage` and `grid` (ADR-0274): *+ Tambah tahap* and *+ Tambah kelompok*.',
  })
  @IsIn(PARTS as unknown as string[])
  part!: string;

  @ApiPropertyOptional({
    description: 'Chosen once. Never reused, archived rows included. **Absent, the server makes one from the label** '
      + '— `Sells policies independently` → `SELLS_POLICIES_INDEPENDENTLY`, `_2` after it if taken.',
  })
  @IsOptional() @IsString() @MaxLength(60)
  code?: string;

  @ApiProperty()
  @IsString() @MaxLength(200)
  label!: string;

  @ApiPropertyOptional({ description: 'Required when `part` is `item`: which grid it goes in.' })
  @IsOptional() @IsString() @MaxLength(60)
  gridCode?: string;

  @ApiPropertyOptional({
    description: 'A milestone added **under a tahap** — required by that stage and every stage above it, '
      + 'as the ladder is cumulative. Absent, a milestone joins the list and no stage.',
  })
  @IsOptional() @IsString() @MaxLength(60)
  stageCode?: string;

  @ApiPropertyOptional({
    description: 'Required when `part` is `stage`: its first milestone’s name. The new stage requires '
      + 'everything the stage below it does, and this — so it is never a stage everybody is already on.',
  })
  @IsOptional() @IsString() @MaxLength(200)
  firstMilestone?: string;
}

export class ReorderCapabilityDto {
  @ApiProperty({ enum: PARTS, description: '`item`: a kelompok’s skills, with its `gridCode`.' })
  @IsIn(PARTS as unknown as string[])
  part!: string;

  @ApiPropertyOptional({ description: 'Required when `part` is `item`: the grid whose skills these are.' })
  @IsOptional() @IsString() @MaxLength(60)
  gridCode?: string;

  @ApiProperty({
    type: [String],
    description: 'Every code of that list, once each, in the order wanted. Never touches `stageOrder`.',
  })
  @IsArray() @ArrayNotEmpty() @IsString({ each: true })
  codes!: string[];
}
