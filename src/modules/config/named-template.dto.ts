import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TEMPLATE } from '@/domain/constants';
import {
  IsBoolean, IsIn, IsMongoId, IsOptional, IsString, MaxLength, MinLength, ValidateBy, ValidateIf,
  isMongoId,
} from 'class-validator';
import { field } from '@/common/validation/violations';
import { isRungMap, type RungMap } from './template-rungs';
import { TEMPLATE_REFUSALS } from './template.messages';

/**
 * A template's name: trimmed by the service, unique among the company's active templates. Its bounds are
 * the domain's (`TEMPLATE`), declared once — the frontend's are pinned to them.
 */
const NAME = { minLength: TEMPLATE.NAME_MIN_LENGTH, maxLength: TEMPLATE.NAME_MAX_LENGTH } as const;

/**
 * `from` is `'empty'`, `'defaults'`, or `{ templateId, rungMap? }` and nothing else (P13.2-T7; ADR-0213 §4): a copy
 * names one template of the company, by id, and may map rungs. Checked whole here, because the pipe's unknown-field
 * refusal does not reach inside an object it has no class for.
 */
function IsTemplateFrom() {
  return ValidateBy({
    name: 'isTemplateFrom',
    validator: {
      validate: (value: unknown) => {
        if (value === 'empty' || value === 'defaults') return true;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
        const { templateId, rungMap, ...rest } = value as { templateId?: unknown; rungMap?: unknown };
        return Object.keys(rest).length === 0
          && typeof templateId === 'string' && isMongoId(templateId)
          && (rungMap === undefined || isRungMap(rungMap));
      },
      // The DTO's own sentence, in both languages (P18.10-T5 AC-3).
      defaultMessage: () => field(TEMPLATE_REFUSALS.VALIDATION_FAILED.fromShape),
    },
  });
}

/** `POST /admin/companies/:companyId/templates` (ADR-0115 §5). */
export class CreateTemplateDto {
  @ApiProperty({ example: 'Prudential — Jakarta branches', ...NAME })
  @IsString()
  @MinLength(NAME.minLength)
  @MaxLength(NAME.maxLength)
  name!: string;

  @ApiProperty({
    oneOf: [
      { type: 'string', enum: ['empty', 'defaults'] },
      {
        type: 'object',
        properties: {
          templateId: { type: 'string', description: 'One of this company\u2019s templates.' },
          rungMap: {
            type: 'object', additionalProperties: { type: 'string' }, example: { SBP: 'BP' },
            description: 'Optional (ADR-0213 §4): a rung the copy names that the ladder lacks, to one of its active '
              + 'rungs. Within one company the ladder is shared, so it is rarely needed; a target that is not an active '
              + 'rung is `400`.',
          },
        },
        required: ['templateId'],
        additionalProperties: false,
      },
    ],
    description:
      '`empty`: nothing in any of the seven kinds — an office made from it starts empty but for the '
      + 'three cascade activity types. `defaults`: each kind a published version 1 of the AgencyBoost '
      + 'defaults. `{ templateId }`: **a copy** of one of this company\u2019s templates — each '
      + 'kind\u2019s newest published version as the copy\u2019s version 1, drafts not copied, codes kept, '
      + 'training files referenced, the recruitment playbook with them (ADR-0210 §1). A company\u2019s first '
      + 'template becomes its default (ADR-0213 §3).',
  })
  @IsTemplateFrom()
  from!: 'empty' | 'defaults' | { templateId: string; rungMap?: RungMap };
}

/** `rungMap` is `{ CODE: 'CODE', … }` — nothing else (ADR-0213 §4). */
function IsRungMap() {
  return ValidateBy({
    name: 'isRungMap',
    validator: {
      validate: (value: unknown) => value === undefined || isRungMap(value),
      defaultMessage: () => field(TEMPLATE_REFUSALS.VALIDATION_FAILED.rungMapShape),
    },
  });
}

/** `POST /admin/companies/:companyId/templates/import` (ADR-0115 §5, P13.2-T7). */
export class ImportTemplateDto {
  @ApiProperty({ description: 'The company the template is imported from: not this one.' })
  @IsMongoId()
  fromCompanyId!: string;

  @ApiProperty({ description: 'One of that company\u2019s templates.' })
  @IsMongoId()
  templateId!: string;

  @ApiProperty({ example: 'Allianz — Jakarta', ...NAME })
  @IsString()
  @MinLength(NAME.minLength)
  @MaxLength(NAME.maxLength)
  name!: string;

  @ApiPropertyOptional({
    type: 'object', additionalProperties: { type: 'string' }, example: { SBP: 'BP' },
    description: '*Salin dari…*\u2019s rung map (ADR-0213 §4, B1-7): each rung the source names and this company\u2019s '
      + 'ladder lacks, to one of its **active** rungs. Every configuration naming a mapped rung is rewritten to the '
      + 'mapped code, duplicates merged, and the audit row records the map. A rung left unmapped is still `409 '
      + 'TEMPLATE_RUNG_UNKNOWN` naming it; a target that is not an active rung is `400 VALIDATION_FAILED` naming it; an '
      + 'entry for a rung the ladder has is ignored.',
  })
  @IsOptional()
  @IsRungMap()
  rungMap?: RungMap;
}

/** `POST /admin/tenants/:kpmId/template` — *Save as template* (ADR-0115 §5, P13.2-T7). */
export class SaveOfficeTemplateDto {
  @ApiProperty({ example: 'BSD City settings', ...NAME })
  @IsString()
  @MinLength(NAME.minLength)
  @MaxLength(NAME.maxLength)
  name!: string;

  @ApiProperty({ description: 'The company the template is made in: the office\u2019s own, or another.' })
  @IsMongoId()
  companyId!: string;
}

/** `PATCH /admin/companies/:companyId/templates/:templateId`: rename, or *Make default*. */
export class UpdateTemplateDto {
  @ApiPropertyOptional({ ...NAME })
  @IsOptional()
  @IsString()
  @MinLength(NAME.minLength)
  @MaxLength(NAME.maxLength)
  name?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      '`true` makes this the company’s default, moving it from the template that was. `false` is '
      + 'refused on the default (409 TEMPLATE_IS_DEFAULT): a company always has one, so another is '
      + 'made the default instead.',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/** `?templateId=` on a template kind's routes: which template; the company's default when absent. */
export class TemplateQueryDto {
  @ApiPropertyOptional({ description: 'The named template. Absent: the company’s default.' })
  @IsOptional()
  @IsMongoId()
  templateId?: string;
}

/**
 * **Start from** (ADR-0115 §4): what a new office is built from. Absent on `POST /admin/tenants`, the
 * company's default template.
 *
 * **`defaults` is admitted here and refused by the route** (ADR-0168 §2): `AdminController.createTenant`
 * answers it `400 VALIDATION_FAILED` with `details.field: 'startFrom.kind'` and a sentence saying what to
 * choose instead, which an `@IsIn` without it could only have called an unknown value. The documented enum is
 * what the route accepts.
 */
export class StartFromDto {
  @ApiProperty({
    enum: ['template', 'empty'],
    description:
      '`template`: one of the company’s active templates, named by `templateId` — or, with '
      + '`templateLibrary`, one of the Template library’s, *Template · Default template*, which holds the '
      + 'AgencyBoost defaults. `empty`: nothing but the three cascade activity types. `defaults` is refused '
      + '400 VALIDATION_FAILED, `details.field: startFrom.kind` (ADR-0168 §2).',
  })
  @IsIn(['template', 'defaults', 'empty'])
  kind!: 'template' | 'defaults' | 'empty';

  @ApiPropertyOptional({
    description:
      'Required when `kind` is `template`, unless `templateLibrary` is true: then it names one of the '
      + 'Template library’s active templates, and absent its default.',
  })
  @ValidateIf((o: StartFromDto) => o.kind === 'template' && (o.templateId !== undefined || o.templateLibrary !== true))
  @IsMongoId()
  templateId?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'With `kind: template`, the template is the Template library’s rather than the company’s — '
      + '*Template · Default template*. Its settings are copied across companies, and every role they name '
      + 'must be on the company’s ladder (409 TEMPLATE_RUNG_UNKNOWN).',
  })
  @IsOptional()
  @IsBoolean()
  templateLibrary?: boolean;
}
