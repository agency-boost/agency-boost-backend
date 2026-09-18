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
  @ApiProperty({ enum: ['milestone', 'item'] })
  @IsIn(['milestone', 'item'])
  part!: string;

  @ApiProperty({ description: 'Chosen once. Never reused, archived rows included.' })
  @IsString() @MaxLength(60)
  code!: string;

  @ApiProperty()
  @IsString() @MaxLength(200)
  label!: string;

  @ApiPropertyOptional()
  @IsOptional() @IsString() @MaxLength(60)
  gridCode?: string;
}

export class ReorderCapabilityDto {
  @ApiProperty({ enum: ['stage', 'milestone', 'grid'] })
  @IsIn(['stage', 'milestone', 'grid'])
  part!: string;

  @ApiProperty({
    type: [String],
    description: 'Every code of that list, once each, in the order wanted. Never touches `stageOrder`.',
  })
  @IsArray() @ArrayNotEmpty() @IsString({ each: true })
  codes!: string[];
}
