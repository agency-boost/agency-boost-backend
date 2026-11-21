import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApplyOfficeResultDto } from './config.response.dto';
import { TEMPLATE_KINDS, type TemplateKind } from './company-template.schema';
import {
  PUBLICATION_SETTINGS, type PublicationChange, type PublicationKpm, type PublicationOutcome, type PublicationSetting,
  type PublicationSummary, type PublicationView, type PublishToKpmsView,
} from './company-publication.service';
import type { ApplyOfficeResult } from './template-push.service';

/**
 * ***Terbitkan ke KPM*'s wire shapes** (ADR-0278 §5–§7): `GET /admin/companies/:companyId/publication`, its
 * `?summary=true` card, and what publishing answers. Each `implements` the service's view, so the two cannot drift.
 */

/** **One change step 1 lists** (ADR-0278 §5). */
export class PublicationChangeDto implements PublicationChange {
  @ApiProperty({
    type: String, example: 'setting:lead_statuses',
    description: '`setting:<row>` or `product:<id>`: what `POST …/publication` sends back in `changes`.',
  })
  id!: string;

  @ApiProperty({ enum: ['setting', 'product_new', 'product_change'] })
  type!: PublicationChange['type'];

  @ApiProperty({
    enum: PUBLICATION_SETTINGS.map((s) => s.setting), nullable: true,
    description: 'The row of *Pengaturan template*; `null` for a product.',
  })
  setting!: PublicationSetting | null;

  @ApiProperty({ enum: TEMPLATE_KINDS, isArray: true, description: 'The template kinds behind the row; empty for a product.' })
  kinds!: TemplateKind[];

  @ApiProperty({ type: String, nullable: true, description: 'A product’s id; `null` for a setting.' })
  productId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'PRUMAPAN' })
  productCode!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'PRUMapan' })
  productName!: string | null;

  @ApiProperty({ type: Boolean, description: 'It waits as a draft, and is published before it reaches anybody.' })
  draft!: boolean;

  @ApiProperty({
    enum: ['chosen', 'all'],
    description: '`chosen`: the KPMs ticked in step 2. `all`: every KPM that reads it, by itself.',
  })
  reach!: 'chosen' | 'all';

  @ApiProperty({
    type: Boolean,
    description: 'A KPM’s own version is replaced: *Menimpa daftar … di KPM*. False for a product, which only adds.',
  })
  overwrites!: boolean;

  @ApiProperty({ type: Number, description: 'The draft against the newest published version, by item. Zero where not counted.' })
  added!: number;

  @ApiProperty({ type: Number })
  changed!: number;

  @ApiProperty({ type: Number })
  removed!: number;

  @ApiProperty({
    type: Number,
    description: 'KPMs that do not have it yet: behind its newest published version, or without the product.',
  })
  missing!: number;
}

/** **One KPM step 2 lists** (ADR-0278 §6). */
export class PublicationKpmDto implements PublicationKpm {
  @ApiProperty({ type: String, description: 'The KPM (`kpms._id`).' })
  id!: string;

  @ApiProperty({ type: String, example: '0417' })
  code!: string;

  @ApiProperty({ type: String, example: 'BSD City Branch' })
  name!: string;

  @ApiProperty({
    type: [String],
    description: 'Changes (by `id`) this KPM made its own version of, which publishing to it would overwrite: '
      + '*akan tertimpa*.',
  })
  ownEdits!: string[];

  @ApiProperty({ type: [String], description: 'Changes (by `id`) it already has: nothing would reach it.' })
  upToDate!: string[];
}

/** `GET /admin/companies/:companyId/publication`: step 1's changes and step 2's KPMs. */
export class CompanyPublicationDto implements PublicationView {
  @ApiProperty({ type: String })
  companyId!: string;

  @ApiProperty({
    type: String, nullable: true,
    description: 'The company’s default template, which *Pengaturan template* edits; `null` where it has none yet.',
  })
  templateId!: string | null;

  @ApiProperty({
    type: Boolean,
    description: 'The Default template (the Template library): it has no KPM, and *Terbitkan ke KPM* is not its.',
  })
  library!: boolean;

  @ApiProperty({ type: () => PublicationChangeDto, isArray: true })
  changes!: PublicationChangeDto[];

  @ApiProperty({ type: () => PublicationKpmDto, isArray: true })
  kpms!: PublicationKpmDto[];
}

/** `GET …/publication?summary=true`: a company card’s line, reading no KPM’s settings. */
export class PublicationSummaryDto implements PublicationSummary {
  @ApiProperty({ type: String })
  companyId!: string;

  @ApiProperty({ type: Number, description: 'How many changes wait; for the Default template, its own drafts.' })
  changes!: number;

  @ApiProperty({ type: Boolean, description: 'The company’s default template has nothing published yet.' })
  templateEmpty!: boolean;

  @ApiProperty({ type: Number, description: 'The KPMs the company’s default template answers for.' })
  kpms!: number;
}

/** What publishing did with one change chosen. */
export class PublicationOutcomeDto {
  @ApiProperty({ type: String, description: 'The change’s `id`, as sent.' })
  id!: string;

  @ApiProperty({
    enum: ['published', 'refused'],
    description: '`refused`: that change alone stays a draft, with the reason in `error`.',
  })
  outcome!: PublicationOutcome['outcome'];

  @ApiPropertyOptional({
    type: Object,
    description: '`refused` only: the refusal’s `code` and `message`, in the reader’s language.',
    example: { code: 'VALIDATION_FAILED', message: 'Add at least one activity type before publishing.' },
  })
  error?: { code: string; message: string };
}

/** `POST /admin/companies/:companyId/publication`'s answer. */
export class PublishToKpmsResultDto implements PublishToKpmsView {
  @ApiProperty({ type: () => PublicationOutcomeDto, isArray: true, description: 'Every change chosen, once, with its outcome.' })
  results!: PublicationOutcome[];

  @ApiProperty({
    type: () => ApplyOfficeResultDto, isArray: true,
    description: 'What the push did, per KPM and kind (ADR-0208 §4): empty where no copied setting was chosen.',
  })
  offices!: ApplyOfficeResult[];
}
