import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsMongoId, IsOptional, IsString, MaxLength } from 'class-validator';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ANALYTICS } from '@/domain/constants';
import { AnalyticsTemplateService } from './analytics-template.service';

/** `?templateId=` — the named template, the company's default when absent — as every kind route takes it. */
export class AnalyticsTemplateQueryDto {
  @ApiPropertyOptional({ description: 'The named template. Absent: the company’s default.' })
  @IsOptional()
  @IsMongoId()
  templateId?: string;
}

/** `GET …/code-check?pattern=` (ADR-0214 §7). */
export class AnalyticsCodeCheckQueryDto extends AnalyticsTemplateQueryDto {
  @ApiProperty({ example: '^[0-9]{8}$', maxLength: ANALYTICS.CODE_PATTERN_MAX_LENGTH })
  @IsString()
  @MaxLength(ANALYTICS.CODE_PATTERN_MAX_LENGTH)
  pattern!: string;

  @ApiPropertyOptional({ example: '70012345', description: 'The field’s *Contoh yang cocok*: answered `exampleMatches`.' })
  @IsOptional()
  @IsString()
  @MaxLength(ANALYTICS.CODE_PATTERN_MAX_LENGTH)
  example?: string;
}

/**
 * **The two reads the *Advanced analytics* editor makes as it is used** (P19.5-T1; ADR-0214 §1). The section itself is
 * read, drafted and published at `…/template/advanced_analytics` like every kind (`AdminController`); these sit beside
 * those, under `company_template:read` — the Super Admin's alone.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin/companies/:companyId/template/advanced_analytics')
export class AnalyticsTemplateController {
  constructor(private readonly analytics: AnalyticsTemplateService) {}

  @Get('code-check')
  @RequirePermission('company_template:read')
  @ApiOperation({
    summary: 'Test an agent-code format over the template’s registered codes',
    description:
      'How many agent codes registered in the KPMs that read the template (active members) the pattern does not match: '
      + '`{ mismatched, total, examples }`, up to five examples — the *Format kode agen* field’s live count, and what a '
      + 'publish refuses; with `example`, `exampleMatches` too, which a draft requires. What a '
      + 'publish refuses with `409 ANALYTICS_CODE_PATTERN_MISMATCH`. The pattern is anchored `^…$` and read by a '
      + 'linear-time engine; a back-reference, a look-around, a pattern it cannot read or one longer than '
      + '200 characters is `400 VALIDATION_FAILED`. Another company’s template is `404`.',
  })
  async codeCheck(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Query() query: AnalyticsCodeCheckQueryDto,
  ) {
    return this.analytics.codeCheck(ctx, companyId, query.templateId, query.pattern, query.example);
  }

  @Get('open-runs')
  @RequirePermission('company_template:read')
  @ApiOperation({
    summary: 'The survey runs open in the template’s KPMs',
    description:
      '`{ nps: { runs, kpms }, qual: { runs, kpms } }`: how many NPS and qualitative runs are open now in the KPMs that '
      + 'read the template, and in how many KPMs — counts only, for the *Bagian* switch’s question before NPS or '
      + '*Analitik kualitatif* is turned off (ADR-0216 §2). Zero until surveys can be started. Another company’s '
      + 'template is `404`.',
  })
  async openRuns(
    @Ctx() ctx: RequestContext,
    @Param('companyId') companyId: string,
    @Query() query: AnalyticsTemplateQueryDto,
  ) {
    return this.analytics.openRuns(ctx, companyId, query.templateId);
  }
}
