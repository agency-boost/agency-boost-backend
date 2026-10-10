import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { ComplianceQueryDto } from './compliance.dto';
import { ComplianceViewDto } from './compliance.response.dto';
import { ComplianceService } from './compliance.service';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/**
 * **The compliance tree** (P18.6-T1; `functional/kpm-analytics.md`, *Compliance, Events, and Campaigns*, the Data
 * contract): the analytics' third tab. A literal path of its own, beside `GET /kpm/analytics`, which it does not shadow.
 */
@ApiTags('kpm-reporting')
@ApiBearerAuth()
@Controller('kpm/analytics/compliance')
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get()
  @RequirePermission('kpm_analytics:read')
  @ApiOperation({
    summary: 'Who has done what, across the office',
    description:
      'Every AB agency’s members — one section per AB, A to Z, its own card and one per AAB who leads somebody — '
      + 'with each member’s status on the item selected: a training module, this year’s goal, logging in the last 7 '
      + 'days, the 90-day activation, an event of this year, or a campaign of this year. Six counts, one per '
      + 'category, each done over those it applies to, computed on every read; what the office offers and lists, for '
      + 'the tabs and pickers. Not paginated. A training, activity or activation read records each member listed as '
      + 'read, in one entry each.',
  })
  @ApiResponse({ status: 200, type: ComplianceViewDto })
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — a category it does not know; an empty or over-long item; an item on `goals`, `activity` '
    + 'or `activation`, which hold one; or a parameter of any other name. `details` names it.',
  ))
  @ApiResponse(refusal(
    403,
    '`TENANT_NO_MEMBERSHIP` — a Super Admin outside a support session belongs to no office. `PERM_DENIED` — '
    + 'a role without the permission: every field role.',
  ))
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — an item the office does not list: another office’s module, event or campaign, an archived one, or '
    + 'one outside this year. Indistinguishable from another office’s.',
  ))
  async read(@Ctx() ctx: RequestContext, @Query() query: ComplianceQueryDto) {
    return this.compliance.read(ctx, query);
  }
}
