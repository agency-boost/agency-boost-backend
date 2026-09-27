import { ApiProperty } from '@nestjs/swagger';
import {
  PRODUCTION_METRICS, PROVENANCES, type ProductionMetric, type Provenance,
} from './monthly-agent-data.schema';
import {
  CADENCES, type Cadence, type CellStatus, type PreviewCell, type PreviewIssue, type PreviewRow,
  type PreviewSummary,
} from './production-preview';
import type { UploadDelimiter, UploadEncoding } from './production-csv';
import type {
  MetricCell, MonthRow, MonthView, TemplateFile, UploadPreview,
} from './production.service';

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

export class TemplateFileDto implements TemplateFile {
  @ApiProperty({ type: String, example: '2026-09' })
  month!: string;

  @ApiProperty({ type: Number, example: 1, description: 'The header *is* the version: an importer identifies a file by matching its header against every version ever issued.' })
  version!: number;

  @ApiProperty({ type: String, example: 'KPM0417-agent-data-Sep-2026.csv' })
  filename!: string;

  @ApiProperty({ type: [String], description: 'Fourteen columns: code, name, six metrics monthly, the same six YTD.' })
  header!: string[];

  @ApiProperty({ type: String, description: 'The whole file. Names are quoted; a quote inside one is doubled (RFC 4180).' })
  file!: string;

  @ApiProperty({ type: Number, description: 'How many active agents it lists.' })
  rowCount!: number;
}

export class MonthViewDto implements MonthView {
  @ApiProperty({ type: String, example: '2026-09' })
  month!: string;

  @ApiProperty({ type: MonthRowDto, isArray: true })
  rows!: MonthRow[];

  @ApiProperty({ type: Number, description: 'Rows holding at least one figure. Zero means nothing uploaded yet.' })
  withData!: number;
}

const CELL_STATUSES: readonly CellStatus[] = ['new', 'changed', 'unchanged', 'not_provided', 'refused'];

export class PreviewIssueDto implements PreviewIssue {
  @ApiProperty({
    type: String,
    example: 'UPLOAD_VALUE_OUT_OF_RANGE',
    description: '`UPLOAD_UNKNOWN_AGENT_CODE`, `UPLOAD_DUPLICATE_AGENT_CODE` or `UPLOAD_MALFORMED_CSV` for a row; `UPLOAD_VALUE_OUT_OF_RANGE` for a cell.',
  })
  code!: string;

  @ApiProperty({ type: String, description: 'Names the column in the header’s own words, and what is wrong.' })
  message!: string;

  @ApiProperty({ enum: PRODUCTION_METRICS, nullable: true, description: 'The cell’s metric; `null` for the row.' })
  metric!: ProductionMetric | null;

  @ApiProperty({ enum: CADENCES, nullable: true })
  cadence!: Cadence | null;
}

export class PreviewCellDto implements PreviewCell {
  @ApiProperty({ enum: PRODUCTION_METRICS }) metric!: ProductionMetric;
  @ApiProperty({ enum: CADENCES }) cadence!: Cadence;

  @ApiProperty({
    enum: CELL_STATUSES,
    description: '`not_provided` is a blank cell, and changes nothing — a file never clears a figure (ADR-0051).',
  })
  status!: CellStatus;

  @ApiProperty({ type: Number, nullable: true, description: 'Stored now. Money in IDR minor units.' })
  before!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'What the file would write, in the same unit. `null` when not provided or refused.' })
  after!: number | null;

  @ApiProperty({ type: String, nullable: true, description: 'The cell as the file has it — money in *Rp M*.' })
  raw!: string | null;
}

export class PreviewRowDto implements PreviewRow {
  @ApiProperty({ type: Number, description: 'The file’s line, as a spreadsheet numbers it; the header is line 1.' })
  line!: number;

  @ApiProperty({ type: String, description: 'As the file has it.' })
  agentCode!: string;

  @ApiProperty({ type: String, nullable: true }) membershipId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The member’s own code.' })
  resolvedAgentCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'The roster’s name. The file’s is never matched on.' })
  name!: string | null;

  @ApiProperty({ type: String }) fileName!: string;
  @ApiProperty({ type: Boolean }) nameDiffers!: boolean;

  @ApiProperty({ type: Boolean, description: 'An all-digit code matched without its leading zeros, to the one member it fits (ADR-0052).' })
  codeRecovered!: boolean;

  @ApiProperty({ enum: ['ready', 'refused'] }) status!: 'ready' | 'refused';
  @ApiProperty({ type: [PreviewIssueDto] }) issues!: PreviewIssueDto[];

  @ApiProperty({ type: [PreviewCellDto], description: 'Twelve, in the template’s order; empty when the row is refused.' })
  cells!: PreviewCellDto[];
}

export class PreviewSummaryDto implements PreviewSummary {
  @ApiProperty({ type: Number }) rows!: number;
  @ApiProperty({ type: Number }) ready!: number;
  @ApiProperty({ type: Number }) refused!: number;
  @ApiProperty({ type: Number }) newCells!: number;
  @ApiProperty({ type: Number }) changedCells!: number;
  @ApiProperty({ type: Number }) unchangedCells!: number;
  @ApiProperty({ type: Number }) notProvidedCells!: number;
  @ApiProperty({ type: Number }) refusedCells!: number;

  @ApiProperty({ type: Number, description: 'Active members the file does not list. They keep what they have.' })
  notInFile!: number;
}

export class UploadPreviewDto implements UploadPreview {
  @ApiProperty({ type: String, example: '2026-09' }) month!: string;
  @ApiProperty({ type: String }) filename!: string;
  @ApiProperty({ type: Number, example: 1 }) templateVersion!: number;
  @ApiProperty({ enum: ['utf-8', 'windows-1252'] }) encoding!: UploadEncoding;
  @ApiProperty({ enum: [',', ';', '\t'] }) delimiter!: UploadDelimiter;
  @ApiProperty({ type: PreviewSummaryDto }) summary!: PreviewSummaryDto;
  @ApiProperty({ type: [PreviewRowDto] }) rows!: PreviewRowDto[];
}
