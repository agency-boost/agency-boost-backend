import { ApiProperty } from '@nestjs/swagger';

export class CapabilityEntryDto {
  @ApiProperty({ type: String, description: 'The identity. A rename never moves it.' })
  code!: string;

  @ApiProperty({ type: String })
  label!: string;

  @ApiProperty({ type: Number })
  displayOrder!: number;

  @ApiProperty({ enum: ['active', 'archived'] })
  status!: string;
}

export class CapabilityStageDto extends CapabilityEntryDto {
  @ApiProperty({ type: [String] })
  requiredMilestoneCodes!: string[];

  @ApiProperty({
    type: Number,
    description: 'How senior the stage is — **not** its position on screen. Reordering never moves it.',
  })
  stageOrder!: number;
}

export class CapabilityGridDto extends CapabilityEntryDto {
  @ApiProperty({ type: Boolean, description: 'Renders N/A for somebody with no downline.' })
  requiresDownline!: boolean;

  @ApiProperty({ type: [CapabilityEntryDto] })
  items!: CapabilityEntryDto[];
}

export class CapabilityCatalogDto {
  @ApiProperty({ type: [CapabilityStageDto] })
  stages!: CapabilityStageDto[];

  @ApiProperty({ type: [CapabilityEntryDto] })
  milestones!: CapabilityEntryDto[];

  @ApiProperty({ type: [CapabilityGridDto] })
  grids!: CapabilityGridDto[];

  @ApiProperty({ type: Number })
  version!: number;
}
