import { ApiProperty } from '@nestjs/swagger';
import { PROVENANCES, type Provenance } from './monthly-agent-data.schema';
import type { MetricCell, MonthRow, MonthView } from './production.service';

export class MetricCellDto implements MetricCell {
  @ApiProperty({
    type: Number, nullable: true,
    description: 'Money in IDR minor units; persistency in percent; the rest counts. **`null` is not zero** — it is *nothing uploaded*.',
  })
  value!: number | null;

  @ApiProperty({ enum: PROVENANCES, nullable: true, description: 'Which writer put it there. `null` when nothing has.' })
  provenance!: Provenance | null;
}

export class MetricPairDto {
  @ApiProperty({ type: MetricCellDto })
  monthly!: MetricCellDto;

  @ApiProperty({ type: MetricCellDto })
  ytd!: MetricCellDto;
}

export class MonthMetricsDto {
  @ApiProperty({ type: MetricPairDto }) ape!: MetricPairDto;
  @ApiProperty({ type: MetricPairDto }) persistency!: MetricPairDto;
  @ApiProperty({ type: MetricPairDto }) recruitment!: MetricPairDto;
  @ApiProperty({ type: MetricPairDto }) newActiveAgents!: MetricPairDto;
  @ApiProperty({ type: MetricPairDto }) fyp!: MetricPairDto;
  @ApiProperty({ type: MetricPairDto }) policyCount!: MetricPairDto;
}

export class MonthRowDto implements MonthRow {
  @ApiProperty({ type: String, description: 'The membership, never a user id (invariant §2).' })
  membershipId!: string;

  @ApiProperty({ type: String, description: 'The carrier-issued code the row is matched on.' })
  agentCode!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: MonthMetricsDto })
  metrics!: MonthRow['metrics'];
}

export class MonthViewDto implements MonthView {
  @ApiProperty({ type: String, example: '2026-09' })
  month!: string;

  @ApiProperty({ type: MonthRowDto, isArray: true })
  rows!: MonthRow[];

  @ApiProperty({ type: Number, description: 'Rows holding at least one figure. Zero means nothing uploaded yet.' })
  withData!: number;
}
