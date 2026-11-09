import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsIn, IsInt, IsMongoId, IsOptional, IsString, Min,
} from 'class-validator';
import { OFFICE_TEMPLATE_KINDS, type OfficeTemplateKind } from './template-defaults';

/** How many KPMs one push may name: a company's offices, with room, and a bound on one request's work. */
const MAX_KPMS = 500;

/** `POST /admin/companies/:companyId/templates/:templateId/apply` (ADR-0208 §4). */
export class ApplyTemplateDto {
  @ApiProperty({
    enum: OFFICE_TEMPLATE_KINDS, isArray: true,
    description: 'The sections to apply, each its newest published version. Applied in *Terbitkan semua*’s order, '
      + 'whatever order they are sent in.',
  })
  @IsArray() @ArrayMaxSize(OFFICE_TEMPLATE_KINDS.length)
  @IsIn(OFFICE_TEMPLATE_KINDS as unknown as string[], { each: true })
  kinds!: OfficeTemplateKind[];

  @ApiProperty({
    type: [String],
    description: 'The KPMs to apply them to, each one made from this template. Any other is `404`, and nothing is written.',
  })
  @IsArray() @ArrayMaxSize(MAX_KPMS) @IsMongoId({ each: true })
  kpmIds!: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'The second confirmation: KPMs whose own changes may be replaced. A KPM the server finds *changed by the '
      + 'KPM* and not listed here is refused `TEMPLATE_APPLY_UNCONFIRMED`, and nothing is written for it.',
  })
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_KPMS) @IsMongoId({ each: true })
  replaceChanged?: string[];
}

/** `?kind=`: one kind, or several separated by commas. Checked by the service, which names any it does not know. */
export class TemplateOfficesQuery {
  @ApiPropertyOptional({
    type: String,
    example: 'activity_taxonomy,ratio_set',
    description: 'The sections to say each KPM’s standing on. Absent: the list as before, with `behind` and '
      + '`unrecorded` alone.',
  })
  @IsOptional() @IsString()
  kind?: string;
}

/**
 * `PUT …/templates/:templateId/training/modules/:code/content`: the module's whole material, as an office's module
 * content is sent (`checkTrainingContent` reads the three lists), pinned to the revision of the draft the editor read.
 */
export class SaveTemplateModuleContentDto {
  @ApiPropertyOptional({
    type: 'array', items: { type: 'object' },
    description: '`{ id?, label, storageKey, mimeType, bytes }` per file, each a confirmed upload of this company.',
  })
  @IsOptional() @IsArray()
  files?: unknown[];

  @ApiPropertyOptional({
    type: 'array', items: { type: 'object' },
    description: 'Short videos (`.mp4`), the same shape. Anything longer than the ceiling is a link.',
  })
  @IsOptional() @IsArray()
  videos?: unknown[];

  @ApiPropertyOptional({
    type: 'array', items: { type: 'object' },
    description: '`{ id?, label, url }` per link, `https` only.',
  })
  @IsOptional() @IsArray()
  links?: unknown[];

  @ApiPropertyOptional({
    example: 3, minimum: 0,
    description: 'The `revision` of the section’s draft the editor read. Somebody else saved or published since: '
      + '`409 VERSION_CONFLICT`, nothing written.',
  })
  @IsOptional() @IsInt() @Min(0)
  expectedRevision?: number;
}
