import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsMongoId, IsString, Matches, MaxLength, MinLength,
} from 'class-validator';
import { LEAD_PIPELINES, type LeadPipeline } from './lead-status.schema';

import { CODE_MESSAGE, CODE_PATTERN, CONFIG_BOUNDS } from './config-input';

const { leadStatusLabel } = CONFIG_BOUNDS;
const trim = Transform(({ value }: { value: unknown }) =>
  (typeof value === 'string' ? value.trim() : value));

export class CreateLeadStatusDto {
  @ApiProperty({ enum: LEAD_PIPELINES })
  @IsIn(LEAD_PIPELINES as unknown as string[])
  pipeline!: LeadPipeline;

  @ApiProperty({
    example: 'AWAITING_UNDERWRITING',
    description: 'Permanent once saved: every lead holds it.',
  })
  @IsString()
  @Matches(CODE_PATTERN, { message: CODE_MESSAGE })
  @trim
  code!: string;

  @ApiProperty({ example: 'Awaiting underwriting', minLength: leadStatusLabel.min, maxLength: leadStatusLabel.max })
  @IsString()
  @MinLength(leadStatusLabel.min)
  @MaxLength(leadStatusLabel.max)
  @trim
  label!: string;
}

/** The label only. The code is what every lead holds. */
export class RenameLeadStatusDto {
  @ApiProperty({ example: 'Menunggu underwriting', minLength: leadStatusLabel.min, maxLength: leadStatusLabel.max })
  @IsString()
  @MinLength(leadStatusLabel.min)
  @MaxLength(leadStatusLabel.max)
  @trim
  label!: string;
}

export class ReorderLeadStatusesDto {
  @ApiProperty({ enum: LEAD_PIPELINES })
  @IsIn(LEAD_PIPELINES as unknown as string[])
  pipeline!: LeadPipeline;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsMongoId({ each: true })
  ids!: string[];
}
