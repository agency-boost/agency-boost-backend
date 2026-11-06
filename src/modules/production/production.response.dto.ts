import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
import { PROVENANCES, type Provenance } from './monthly-agent-data.schema';
import type {
  CellStatus, PreviewCell, PreviewColumn, PreviewCorrection, PreviewIssue, PreviewNote, PreviewNoteCode, PreviewRow,
  PreviewRowStatus, PreviewSummary,
} from './production-preview';
import type { UploadDelimiter, UploadEncoding } from './production-csv';
import type { UploadFormat } from './production-preview';
import type {
  MetricCell, MonthColumn, MonthConfig, MonthRow, MonthStatus, MonthView, TemplateFile, UnregisteredRow, UploadPreview,
  YtdCell,
} from './production.service';
import type { BatchView, History, ImportResult } from './production-import.service';
import type { CorrectionResult } from './production-correction.service';
import type { LockReason, MonthState } from './production-months.service';
import { BATCH_STATUSES, type BatchStatus } from './data-upload-batch.schema';

const LOCK_REASONS: readonly LockReason[] = ['open', 'schedule', 'locked_by_hand', 'reopened', 'history'];
const UNITS = ['rp_million', 'percent', 'count'] as const;
const FILL_STATUSES = ['missing', 'incomplete', 'complete'] as const;

export class MonthStateDto implements MonthState {
  @ApiProperty({ type: String, example: '2026-09' }) month!: string;

  @ApiProperty({ type: Number, description: 'Advanced by every write to the month. A preview carries it; Confirm import must send it back unchanged, or is refused `VERSION_CONFLICT`.' })
  revision!: number;

  @ApiProperty({ type: Boolean, description: 'A locked month refuses import, revert and correction with `UPLOAD_MONTH_LOCKED` (ADR-0050).' })
  locked!: boolean;

  @ApiProperty({ enum: LOCK_REASONS, description: '`open`/`schedule` follow the office’s window; `locked_by_hand`/`reopened` are somebody’s decision, which holds until the other is taken; `history` is a month of the required history never written, open until its first upload (ADR-0214 §11).' })
  reason!: LockReason;

  @ApiProperty({ type: String, example: '2026-10-07', description: 'The last day the schedule leaves it open: month end plus `kpms.settings.productionLockGraceDays`, in the office’s calendar.' })
  editableUntil!: string;

  @ApiProperty({ type: String, nullable: true, description: 'When it was last locked or reopened by hand.' })
  changedAt!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Who did it, by name.' })
  changedBy!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '2026-11-03', description: 'D8: the *as of* day of the month’s latest import while it ran; `null` for a final upload.' })
  asOf!: string | null;
}

export class BatchViewDto implements BatchView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) month!: string;
  @ApiProperty({ type: String }) filename!: string;
  @ApiProperty({ enum: BATCH_STATUSES, description: 'The history lists `committed`, `reverting` and `reverted`.' }) status!: BatchStatus;
  @ApiProperty({ type: Number, description: 'The template’s version the file was read against (R6): the history’s *v<n>*. 1 for a batch from before the template’s columns.' }) templateVersion!: number;
  @ApiProperty({ type: String, nullable: true, description: 'D8: the office day a running month’s upload stood at; `null` for a final one.' }) asOf!: string | null;
  @ApiProperty({ type: Number, description: '*Belum terdaftar* rows it held apart (ADR-0214 §8).' }) heldRowCount!: number;
  @ApiProperty({ type: Number, description: 'Data rows in the file.' }) rowCount!: number;
  @ApiProperty({ type: Number, description: 'Rows with at least one figure written.' }) writtenRowCount!: number;
  @ApiProperty({ type: Number, description: 'Figures written.' }) cellCount!: number;
  @ApiProperty({ type: Number, description: 'Rows and figures not taken.' }) issueCount!: number;
  @ApiProperty({ type: String, nullable: true }) committedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'By name.' }) committedBy!: string | null;
  @ApiProperty({ type: String, nullable: true }) revertedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'By name.' }) revertedBy!: string | null;
  @ApiProperty({ type: Number, description: 'Figures a revert put back.' }) restoredCellCount!: number;
  @ApiProperty({ type: Number, description: 'Figures a revert kept, because something else wrote them since.' }) keptCellCount!: number;
  @ApiProperty({ type: Number, description: 'Corrections by hand the file would have changed, left as they were (ADR-0053).' }) keptCorrectionCount!: number;
  @ApiProperty({ type: Number, description: 'Corrections by hand replaced with the file’s figure, because the importer ticked them.' }) replacedCorrectionCount!: number;

  @ApiProperty({ type: Boolean, description: 'Standing, and the month’s latest standing import — the only one revert takes.' })
  canRevert!: boolean;
}

export class ImportResultDto implements ImportResult {
  @ApiProperty({ type: BatchViewDto }) batch!: BatchViewDto;
  @ApiProperty({ type: MonthStateDto, description: 'The month after the write, with its new revision.' }) state!: MonthStateDto;
}

export class CorrectedCellDto {
  @ApiProperty({ type: Number, nullable: true, description: 'Money in IDR minor units.' }) value!: number | null;
  @ApiProperty({ enum: PROVENANCES, nullable: true }) provenance!: Provenance | null;
}

export class CorrectionResultDto implements CorrectionResult {
  @ApiProperty({ type: String }) membershipId!: string;
  @ApiProperty({ type: String, example: 'APE', description: 'The column’s kode.' }) kode!: string;
  @ApiProperty({ type: Boolean, description: 'An uploaded year to date.' }) ytd!: boolean;
  @ApiProperty({ type: Boolean, description: '`false` when the figure already held that value — nothing was written, audited or advanced.' }) changed!: boolean;
  @ApiProperty({ type: CorrectedCellDto }) before!: CorrectedCellDto;
  @ApiProperty({ type: CorrectedCellDto }) after!: CorrectedCellDto;
  @ApiProperty({ type: MonthStateDto, description: 'The month after the write, with its new revision.' }) state!: MonthStateDto;
}

export class HistoryDto implements History {
  @ApiProperty({ type: String, example: '2026-09' }) month!: string;
  @ApiProperty({ type: [BatchViewDto], description: 'Newest first.' }) batches!: BatchViewDto[];
}

export class CellCorrectionDto {
  @ApiProperty({ type: String, nullable: true, description: 'Who corrected it, by name.' }) by!: string | null;
  @ApiProperty({ type: String, nullable: true }) at!: string | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
}

export class MetricCellDto implements Omit<MetricCell, 'outOfBounds'> {
  @ApiProperty({
    type: Number, nullable: true,
    description: 'Money in IDR minor units; persistency in percent; the rest counts. **`null` is not zero** — it is *nothing uploaded*.',
  })
  value!: number | null;

  @ApiProperty({ enum: PROVENANCES, nullable: true, description: 'Which writer put it there. `null` when nothing has.' })
  provenance!: Provenance | null;

  @ApiProperty({
    type: CellCorrectionDto, nullable: true,
    description: 'A correction by hand — who, when, why — so a figure can say where it came from without a second request. A figure emptied by hand is `corrected` with a `null` value.',
  })
  correction!: CellCorrectionDto | null;
}

export class OutOfBoundsDto {
  @ApiProperty({ type: Number, example: 2, description: 'The version since which every published version’s limits exclude the value.' })
  sinceVersion!: number;
}

export class MonthCellDto extends MetricCellDto implements MetricCell {
  @ApiProperty({
    type: OutOfBoundsDto, nullable: true,
    description: 'A stored value outside its column’s current limits (AA UI-025): *Di luar batas sejak v<n>*. Flagged, never changed.',
  })
  outOfBounds!: OutOfBoundsDto | null;
}

export class YtdCellDto extends MetricCellDto implements YtdCell {
  @ApiProperty({ type: Boolean, description: '`true`: the sum of the months held from January (R4), never stored or typed; `false`: the year to date the file uploaded.' })
  calculated!: boolean;
}

export class LabelPairDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) en!: string;
}

export class MonthColumnDto implements MonthColumn {
  @ApiProperty({ type: String, example: 'APE' }) kode!: string;
  @ApiProperty({ type: Boolean, description: 'One of the four system columns (R1).' }) system!: boolean;
  @ApiProperty({ type: LabelPairDto }) label!: LabelPairDto;
  @ApiProperty({ enum: UNITS }) unit!: MonthColumn['unit'];
  @ApiProperty({ enum: ['sum', 'upload', 'none'] }) ytd!: MonthColumn['ytd'];
  @ApiProperty({ type: Number, nullable: true, description: 'In the column’s unit (*Rp juta* for money).' }) min!: number | null;
  @ApiProperty({ type: Number, nullable: true }) max!: number | null;
  @ApiProperty({ type: Boolean, description: 'Required from `effectiveFrom` (R2).' }) required!: boolean;
  @ApiProperty({ enum: ['all', 'leaders'] }) rows!: MonthColumn['rows'];
  @ApiProperty({ type: String, example: '2026-12' }) effectiveFrom!: string;
  @ApiProperty({ type: LabelPairDto }) tip!: LabelPairDto;
  @ApiProperty({ type: Boolean, description: '`effectiveFrom` is on or before the month: before it the column reads *—*.' }) inForce!: boolean;
  @ApiProperty({ type: [String], description: 'The months its year to date lacks (R4): *Belum lengkap · <Bul> belum diunggah*. Empty is complete.' })
  ytdMissingMonths!: string[];
}

export class MonthStatusDto implements MonthStatus {
  @ApiProperty({ type: String, example: '2026-03' }) month!: string;
  @ApiProperty({ enum: FILL_STATUSES, description: '`UPLOAD_MONTH_COMPLETE`: never uploaded, below `completePct`, or complete.' }) status!: MonthStatus['status'];
  @ApiProperty({ type: Number, description: 'Members on the month’s last day.' }) members!: number;
  @ApiProperty({ type: Number, description: 'Those of them filled in every column in force.' }) filled!: number;
}

export class UnregisteredRowDto implements UnregisteredRow {
  @ApiProperty({ type: String, description: 'The code, as ADR-0052 normalises it.' }) agentCode!: string;
  @ApiProperty({ type: String, description: 'The name the file gave.' }) fileName!: string;
  @ApiProperty({ type: 'object', additionalProperties: { $ref: getSchemaPath(MonthCellDto) }, description: 'By kode.' })
  values!: Record<string, MonthCellDto>;
  @ApiProperty({ type: 'object', additionalProperties: { $ref: getSchemaPath(YtdCellDto) }, description: 'By kode.' })
  ytd!: Record<string, YtdCellDto>;
}

export class MonthRowDto implements MonthRow {
  @ApiProperty({ type: String, description: 'The membership, never a user id (invariant §2).' })
  membershipId!: string;

  @ApiProperty({ type: String, description: 'The carrier-issued code the row is matched on.' })
  agentCode!: string;

  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({
    type: 'object', additionalProperties: { $ref: getSchemaPath(MonthCellDto) },
    description: 'This month’s figure per current column, by kode. A column not in force reads empty.',
  })
  values!: Record<string, MonthCellDto>;

  @ApiProperty({
    type: 'object', additionalProperties: { $ref: getSchemaPath(YtdCellDto) },
    description: 'The year to date per column whose `ytd` is not `none`, by kode.',
  })
  ytd!: Record<string, YtdCellDto>;

  @ApiProperty({ type: Boolean, description: 'A member of a leader class, `ab` or `aab` (ADR-0156): the rows a `rows: leaders` column is filled on.' })
  leader!: boolean;

  @ApiProperty({
    type: Boolean, nullable: true,
    description: '`MONTHLY_ACTIVE_AGENT` for the month (ADR-0054): `APE` or `POLICY_COUNT` above zero this month. '
      + '**`null` is not `false`** — it is *not reported*: neither figure is positive and at least one is not held.',
  })
  monthlyActiveAgent!: boolean | null;
}

export class TemplateFileDto implements TemplateFile {
  @ApiProperty({ type: String, example: '2026-09' })
  month!: string;

  @ApiProperty({ type: Number, example: 2, description: 'The template’s published version the header follows (R6).' })
  version!: number;

  @ApiProperty({ type: String, example: '0417-agent-data-2026-09.csv' })
  filename!: string;

  @ApiProperty({ type: [String], description: '`Agent Code`, `Agent Name`, each column `<label> (<unit>) [KODE]`, then `<label> YTD [KODE_YTD]` for each column whose year to date is uploaded.' })
  header!: string[];

  @ApiProperty({ type: String, description: 'The whole file. Names are quoted; a quote inside one is doubled (RFC 4180).' })
  file!: string;

  @ApiProperty({ type: Number, description: 'How many active agents it lists.' })
  rowCount!: number;
}

/** The template the month's columns follow (ADR-0214 §14). */
export class MonthConfigDto implements MonthConfig {
  @ApiProperty({ type: String, nullable: true, description: 'The named template; `null` for the platform’s own configuration.' })
  templateId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Prudential template' })
  templateName!: string | null;

  @ApiProperty({ type: Number, example: 2, description: 'The published version the KPM reads now.' })
  version!: number;

  @ApiProperty({ type: [MonthColumnDto], description: 'The template’s current columns, in the file’s order.' })
  columns!: MonthColumnDto[];

  @ApiProperty({ type: String, example: '2025-11', description: 'The required history’s first month (R5): twelve before the KPM’s first.' })
  historyFrom!: string;

  @ApiProperty({ type: String, example: '2026-11', description: 'The KPM’s first month on AgencyBoost (UI-150).' })
  firstMonth!: string;

  @ApiProperty({ type: Number, example: 90, description: '% of members filled for a month to be complete.' })
  completePct!: number;
}

export class MonthViewDto implements MonthView {
  @ApiProperty({ type: String, example: '2026-09' })
  month!: string;

  @ApiProperty({ type: MonthRowDto, isArray: true })
  rows!: MonthRow[];

  @ApiProperty({ type: UnregisteredRowDto, isArray: true, description: '*Belum terdaftar* rows (ADR-0214 §8), read-only, counted in nothing.' })
  unregistered!: UnregisteredRow[];

  @ApiProperty({ type: Number, description: 'Rows holding at least one figure. Zero means nothing uploaded yet.' })
  withData!: number;

  @ApiProperty({ type: MonthStateDto, description: 'Open or locked, and why.' })
  state!: MonthStateDto;

  @ApiProperty({
    type: MonthConfigDto,
    description: 'The template the columns follow (ADR-0214 §14), read live — the banner’s *Kolom mengikuti <template> v<n>.*',
  })
  config!: MonthConfigDto;

  @ApiProperty({ type: MonthStatusDto, description: 'This month, as complete or not (`UPLOAD_MONTH_COMPLETE`).' })
  completeness!: MonthStatusDto;

  @ApiProperty({ type: [String], description: 'The months any year to date lacks: *YTD belum lengkap: <Bul> <tahun> belum diunggah.*' })
  ytdMissingMonths!: string[];

  @ApiProperty({ type: [MonthStatusDto], description: 'From `config.historyFrom` to the current month, each as complete or not.' })
  months!: MonthStatusDto[];
}

const CELL_STATUSES: readonly CellStatus[] = ['new', 'changed', 'unchanged', 'not_provided', 'refused'];

export class PreviewIssueDto implements PreviewIssue {
  @ApiProperty({
    type: String,
    example: 'UPLOAD_VALUE_OUT_OF_RANGE',
    description: '`UPLOAD_UNKNOWN_AGENT_CODE`, `UPLOAD_DUPLICATE_AGENT_CODE` or `UPLOAD_MALFORMED_CSV` for a row; `UPLOAD_VALUE_OUT_OF_RANGE` for a cell, '
      + 'and `UPLOAD_LEADER_ONLY_VALUE` for *Unit Persistency (%)* on a row that is not an AB’s or an AAB’s (ADR-0201 §2).',
  })
  code!: string;

  @ApiProperty({ type: String, description: 'Names the column in the header’s own words, and what is wrong.' })
  message!: string;

  @ApiProperty({ type: String, nullable: true, description: 'The cell’s kode; `null` for the row.' })
  kode!: string | null;

  @ApiProperty({ type: Boolean, nullable: true, description: 'An uploaded year to date; `null` for the row.' })
  ytd!: boolean | null;
}

export class PreviewCorrectionDto implements PreviewCorrection {
  @ApiProperty({ type: String, nullable: true, description: 'Who corrected it, by name.' }) by!: string | null;
  @ApiProperty({ type: String, nullable: true }) at!: string | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: 'The figure the correction replaced. The file carrying it again is how a re-upload of the old file looks.' })
  replacedValue!: number | null;
}

export class PreviewCellDto implements PreviewCell {
  @ApiProperty({ type: String, example: 'APE' }) kode!: string;
  @ApiProperty({ type: Boolean, description: 'A `ytd: upload` column’s year to date (`[KODE_YTD]`).' }) ytd!: boolean;

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

  @ApiProperty({
    type: PreviewCorrectionDto, nullable: true,
    description: 'Set when the stored figure was corrected by hand and the file would change it. Replaced only if named in the commit’s `replace` (ADR-0053).',
  })
  correction!: PreviewCorrectionDto | null;
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

  @ApiProperty({ enum: ['ready', 'refused', 'held'], description: '`held`: a code no member holds, kept as *Belum terdaftar* (ADR-0214 §8).' }) status!: PreviewRowStatus;
  @ApiProperty({ type: [PreviewIssueDto] }) issues!: PreviewIssueDto[];

  @ApiProperty({ type: [PreviewCellDto], description: 'One per `columns` entry, in its order; empty when the row is refused.' })
  cells!: PreviewCellDto[];
}

export class PreviewColumnDto implements PreviewColumn {
  @ApiProperty({ type: String }) kode!: string;
  @ApiProperty({ type: Boolean }) ytd!: boolean;
  @ApiProperty({ type: String, description: 'The file’s own header.' }) header!: string;
  @ApiProperty({ type: String, description: 'The column’s name in the reader’s language.' }) label!: string;
  @ApiProperty({ enum: UNITS }) unit!: PreviewColumn['unit'];
}

export class PreviewNoteDto implements PreviewNote {
  @ApiProperty({ enum: ['column_missing', 'column_retired', 'column_unknown', 'column_not_in_force'] }) code!: PreviewNoteCode;
  @ApiProperty({ type: String, nullable: true }) kode!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'The file’s header; `null` for a column the file lacks.' }) header!: string | null;
  @ApiProperty({ type: String, description: '*Kolom <nama> kosong di file ini. Baris tetap diimpor.*, *Kolom <nama> tidak dipakai lagi*, …' }) message!: string;
}

export class PreviewSummaryDto implements PreviewSummary {
  @ApiProperty({ type: Number }) rows!: number;
  @ApiProperty({ type: Number }) ready!: number;
  @ApiProperty({ type: Number }) refused!: number;
  @ApiProperty({ type: Number, description: '*Belum terdaftar* rows held apart.' }) held!: number;
  @ApiProperty({ type: Number }) newCells!: number;
  @ApiProperty({ type: Number }) changedCells!: number;
  @ApiProperty({ type: Number }) unchangedCells!: number;
  @ApiProperty({ type: Number }) notProvidedCells!: number;
  @ApiProperty({ type: Number }) refusedCells!: number;
  @ApiProperty({ type: Number, description: 'Figures corrected by hand the file would change — each replaced only if ticked.' }) correctionCells!: number;

  @ApiProperty({ type: Number, description: 'Active members the file does not list. They keep what they have.' })
  notInFile!: number;
}

export class AnalyticsConfigRefDto {
  @ApiProperty({ type: String, nullable: true }) templateId!: string | null;
  @ApiProperty({ type: Number }) version!: number;
}

export class UploadPreviewDto implements UploadPreview {
  @ApiProperty({ type: String, example: '2026-09' }) month!: string;
  @ApiProperty({ type: String }) filename!: string;
  @ApiProperty({ type: Number, example: 1, description: 'The template’s version the file was read against (R6).' }) templateVersion!: number;
  @ApiProperty({ type: AnalyticsConfigRefDto }) analyticsConfig!: AnalyticsConfigRefDto;
  @ApiProperty({ enum: ['csv', 'xlsx'], description: 'A CSV, or an Excel workbook whose Data sheet was read (ADR-0184).' }) format!: UploadFormat;
  @ApiProperty({ enum: ['utf-8', 'windows-1252'], description: 'How a CSV’s bytes were read; `utf-8` for a workbook.' }) encoding!: UploadEncoding;
  @ApiProperty({ enum: [',', ';', '\t'], description: 'A CSV’s delimiter; `,` for a workbook, whose numbers carry the point as their decimal mark.' }) delimiter!: UploadDelimiter;
  @ApiProperty({ type: Number, description: 'The month’s revision the preview was taken against. Confirm import sends it back.' }) revision!: number;
  @ApiProperty({ type: [PreviewColumnDto], description: 'The columns read, in the template’s order.' }) columns!: PreviewColumnDto[];
  @ApiProperty({ type: [PreviewNoteDto], description: 'What the header says about the file’s columns (AA UI-013).' }) notes!: PreviewNoteDto[];
  @ApiProperty({ type: PreviewSummaryDto }) summary!: PreviewSummaryDto;
  @ApiProperty({ type: [PreviewRowDto] }) rows!: PreviewRowDto[];
}

/** The cells a map by kode holds, for `ApiExtraModels` (the controller registers them). */
export const PRODUCTION_CELL_DTOS = [MonthCellDto, YtdCellDto];
