import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TEMPLATE } from '@/domain/constants';
import {
  IsBoolean, IsIn, IsMongoId, IsOptional, IsString, MaxLength, MinLength, ValidateBy, ValidateIf,
  isMongoId,
} from 'class-validator';

/**
 * A template's name: trimmed by the service, unique among the company's active templates. Its bounds are
 * the domain's (`TEMPLATE`), declared once — the frontend's are pinned to them.
 */
const NAME = { minLength: TEMPLATE.NAME_MIN_LENGTH, maxLength: TEMPLATE.NAME_MAX_LENGTH } as const;

/**
 * `from` is `'empty'`, `'defaults'`, or `{ templateId }` and nothing else (P13.2-T7): a copy names one
 * template of the company, by id. Checked whole here, because the pipe's unknown-field refusal does not
 * reach inside an object it has no class for.
 */
function IsTemplateFrom() {
  return ValidateBy({
    name: 'isTemplateFrom',
    validator: {
      validate: (value: unknown) => {
        if (value === 'empty' || value === 'defaults') return true;
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
        const keys = Object.keys(value);
        return keys.length === 1 && keys[0] === 'templateId'
          && typeof (value as { templateId: unknown }).templateId === 'string'
          && isMongoId((value as { templateId: string }).templateId);
      },
      defaultMessage: () => 'from must be "empty", "defaults", or { templateId } naming one of the company\u2019s templates',
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
        properties: { templateId: { type: 'string', description: 'One of this company\u2019s templates.' } },
        required: ['templateId'],
        additionalProperties: false,
      },
    ],
    description:
      '`empty`: nothing in any of the seven kinds — an office made from it starts empty but for the '
      + 'three cascade activity types. `defaults`: each kind a published version 1 of the AgencyBoost '
      + 'defaults. `{ templateId }`: **a copy** of one of this company\u2019s templates — each '
      + 'kind\u2019s newest published version as the copy\u2019s version 1, drafts not copied, codes kept, '
      + 'training files referenced.',
  })
  @IsTemplateFrom()
  from!: 'empty' | 'defaults' | { templateId: string };
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
 */
export class StartFromDto {
  @ApiProperty({
    enum: ['template', 'defaults', 'empty'],
    description:
      '`template`: one of the company’s active templates, named by `templateId`. `defaults`: the '
      + 'AgencyBoost defaults. `empty`: nothing but the three cascade activity types.',
  })
  @IsIn(['template', 'defaults', 'empty'])
  kind!: 'template' | 'defaults' | 'empty';

  @ApiPropertyOptional({ description: 'Required when `kind` is `template`.' })
  @ValidateIf((o: StartFromDto) => o.kind === 'template')
  @IsMongoId()
  templateId?: string;
}
