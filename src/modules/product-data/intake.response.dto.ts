import { ApiProperty } from '@nestjs/swagger';
import {
  ILLUSTRATION_STATUSES, INTAKE_ITEM_KINDS, INTAKE_ITEM_STATUSES, INTAKE_STATUSES, PDF_DETAIL_BLOCKS,
} from '@/domain/constants';
import type { BoxPreview, PreviewRow } from './illustration-preview';
import type { IllustrationView } from './illustration.service';
import type { IntakeDetailView, IntakeItemView, IntakeView } from './intake.service';

/** One file of an upload, and how its reading went. */
export class IntakeFileDto {
  @ApiProperty({ type: Number }) index!: number;
  @ApiProperty({ type: String, description: 'Its name; a ZIP’s file reads `kiriman.zip › tarif.xlsx`.' }) name!: string;
  @ApiProperty({ type: String, enum: ['xlsx', 'csv', 'pdf', 'image', 'docx'] }) kind!: string;
  @ApiProperty({ type: Number }) bytes!: number;
  @ApiProperty({ type: String, enum: ['reading', 'read', 'failed'] }) status!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Why it failed: `refused`, `too_long`, `unreadable`, `key_refused`, `busy`, `timeout`, `file_refused`, `service_error`, `not_configured`.' })
  failure!: string | null;

  @ApiProperty({ type: Number, description: 'The cards it gave.' }) items!: number;
  @ApiProperty({ type: Boolean, description: 'Whether the original is kept, so its source links open it.' }) kept!: boolean;
}

/** One upload, as a list shows it. */
export class IntakeViewDto implements IntakeView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, nullable: true, description: '`null`: uploaded from *Perusahaan*, the files to say which.' })
  companyId!: string | null;

  @ApiProperty({ type: String, nullable: true }) companyName!: string | null;
  @ApiProperty({ type: String, enum: INTAKE_STATUSES }) status!: IntakeView['status'];
  @ApiProperty({ type: String, nullable: true, description: '`stale` for a reading the process lost.' }) failure!: string | null;
  @ApiProperty({ type: () => IntakeFileDto, isArray: true }) files!: IntakeFileDto[];
  @ApiProperty({ type: String }) uploadedBy!: string;
  @ApiProperty({ type: String, nullable: true }) uploadedByName!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) readAt!: string | null;
  @ApiProperty({ type: Number }) items!: number;
  @ApiProperty({ type: Number, description: 'Questions still to answer, over every card.' }) open!: number;
}

/** A company's uploads, and whether reading is switched on (`ANTHROPIC_API_KEY`). */
export class IntakeListDto {
  @ApiProperty({ type: Boolean, description: '`false`: *Unggah file* is disabled and says reading is not switched on.' })
  aiReading!: boolean;

  @ApiProperty({ type: () => IntakeViewDto, isArray: true }) intakes!: IntakeViewDto[];
}

/** One card of *Yang kami pahami*, with its old → new rows, its source and its questions. */
export class IntakeItemViewDto implements IntakeItemView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, nullable: true }) companyId!: string | null;
  @ApiProperty({ type: String, nullable: true }) productId!: string | null;
  @ApiProperty({ type: String, nullable: true }) productName!: string | null;
  @ApiProperty({ type: String, nullable: true }) productAsWritten!: string | null;
  @ApiProperty({ type: String, enum: INTAKE_ITEM_KINDS }) kind!: IntakeItemView['kind'];
  @ApiProperty({ type: String }) summary!: string;
  @ApiProperty({ type: String, nullable: true }) effectiveFrom!: string | null;
  @ApiProperty({ type: String, nullable: true }) effectiveTo!: string | null;
  @ApiProperty({ type: 'object', description: '`{ file, fileName, page, sheet, cell, quote }`.', additionalProperties: true })
  source!: IntakeItemView['source'];

  @ApiProperty({ type: 'array', items: { type: 'object' }, description: 'Old → new: `{ key, label, old, new, certain, source }`.' })
  diff!: IntakeItemView['diff'];

  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true, description: 'A premium table: its row count, columns, gaps, basis and currency.' })
  table!: IntakeItemView['table'];

  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true, description: 'A percentage, with the rule an approval states.' })
  percent!: IntakeItemView['percent'];

  @ApiProperty({ type: String, nullable: true }) newProductName!: string | null;
  @ApiProperty({ type: 'array', items: { type: 'object' }, description: 'Question cards: `{ id, kind, text, choices, answer, open, asked }`.' })
  questions!: IntakeItemView['questions'];

  @ApiProperty({ type: String, enum: ['high', 'low'] }) confidence!: 'high' | 'low';
  @ApiProperty({ type: String, enum: INTAKE_ITEM_STATUSES }) status!: IntakeItemView['status'];
  @ApiProperty({ type: 'object', nullable: true, additionalProperties: true, description: '`{ kind: rate_table | product | illustration, id }`.' })
  appliedRef!: IntakeItemView['appliedRef'];

  @ApiProperty({ type: String, nullable: true }) decidedBy!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) decidedAt!: string | null;
}

/** One upload with its cards. */
export class IntakeDetailDto extends IntakeViewDto implements IntakeDetailView {
  @ApiProperty({ type: Boolean, description: 'Whether the reader may answer, confirm and reject.' }) canManage!: boolean;
  @ApiProperty({ type: () => IntakeItemViewDto, isArray: true }) cards!: IntakeItemViewDto[];
}

/** A short-lived link to an original file. */
export class IntakeFileLinkDto {
  @ApiProperty({ type: String }) url!: string;
}

/** One illustration of the *Ilustrasi* tab. */
export class IllustrationViewDto implements IllustrationView {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) companyId!: string;
  @ApiProperty({ type: String }) productId!: string;
  @ApiProperty({ type: String, nullable: true }) plan!: string | null;
  @ApiProperty({ type: String }) fileName!: string;
  @ApiProperty({ type: Boolean }) hasFile!: boolean;
  @ApiProperty({ type: String }) illustrationDate!: string;
  @ApiProperty({ type: String, enum: ILLUSTRATION_STATUSES }) status!: IllustrationView['status'];
  @ApiProperty({ type: String, nullable: true }) failure!: IllustrationView['failure'];
  @ApiProperty({
    type: 'array', items: { type: 'object' },
    description: `Blocks \`{ block (${PDF_DETAIL_BLOCKS.join(', ')}), page, rows[] }\`; each row \`{ id, label, note, formula, text, page, check }\`.`,
  })
  blocks!: IllustrationView['blocks'];

  @ApiProperty({ type: [String] }) dropped!: string[];
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } }) sampleInputs!: Record<string, number>;
  @ApiProperty({ type: [String] }) formulaNames!: string[];
  @ApiProperty({ type: Number }) mismatches!: number;
  @ApiProperty({ type: Number }) unchecked!: number;
  @ApiProperty({ type: String, nullable: true }) intakeItemId!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) publishedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) supersededAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class IllustrationListDto {
  @ApiProperty({ type: Boolean }) aiReading!: boolean;
  @ApiProperty({ type: () => IllustrationViewDto, isArray: true }) illustrations!: IllustrationViewDto[];
}

export class PreviewRowDto implements PreviewRow {
  @ApiProperty({ type: String }) label!: string;
  @ApiProperty({ type: String }) value!: string;
  @ApiProperty({ type: String, nullable: true }) block!: PreviewRow['block'];
  @ApiProperty({ type: String }) kind!: PreviewRow['kind'];
}

export class BoxKeptDto {
  @ApiProperty({ type: Number }) kept!: number;
  @ApiProperty({ type: () => PreviewRowDto, isArray: true }) dropped!: PreviewRowDto[];
}

/** The product's box, as two products and as three or four print it. */
export class BoxPreviewDto implements BoxPreview {
  @ApiProperty({ type: () => PreviewRowDto, isArray: true }) rows!: PreviewRowDto[];
  @ApiProperty({ type: () => BoxKeptDto }) withTwo!: BoxKeptDto;
  @ApiProperty({ type: () => BoxKeptDto }) withMore!: BoxKeptDto;
  @ApiProperty({ type: [String] }) missing!: string[];
  @ApiProperty({ type: Boolean }) fits!: boolean;
}
