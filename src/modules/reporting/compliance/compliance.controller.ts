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
 * **The KPM Overview's *Compliance*** (P19.19-T3; ADR-0272 §6; `functional/kpm-overview.md`, the Data contract): the
 * seven cards and the card a reader opens. A literal path beside `GET /kpm/overview`, which it does not shadow. Until
 * P19.19 it was `GET /kpm/analytics/compliance`, KPM Analytics' third tab; that route is gone.
 */
@ApiTags('kpm-reporting')
@ApiBearerAuth()
@Controller('kpm/overview/compliance')
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get()
  @RequirePermission('kpm_overview:read')
  @ApiOperation({
    summary: 'The Overview’s compliance cards, and who has done one',
    description:
      'Seven cards over the KPM, or one informal group (`group`, `none` for *Tanpa group*) — Training (per module), Goal '
      + 'Setting, Activity Mgmt, Leads Mgmt, Activation (of *agent baru*), Events (of *yang diundang*), Campaigns — each '
      + 'done over those it applies to, lowest % first; test accounts are never counted. With `category` (and `item` on '
      + 'Training, Events, Campaigns), every person’s cell on it, for the card’s list. Computed on every read; not '
      + 'paginated. A training, activity or activation card opened records each person listed as read. The KPM’s '
      + 'stewards: the Owner, an Admin, a core leader, the Super Admin inside the KPM.',
  })
  @ApiResponse({ status: 200, type: ComplianceViewDto })
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — a category it does not know; an empty or over-long item; an item without a category, or on '
    + '`goals`, `activity`, `leads` or `activation`, which hold one; or a parameter of any other name. `details` names it.',
  ))
  @ApiResponse(refusal(
    403,
    '`TENANT_NO_MEMBERSHIP` — a Super Admin who has not entered a KPM. `PERM_DENIED` — an AB or an AAB who is not a core '
    + 'leader, or an Agent.',
  ))
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — a group or an item the office does not list: another office’s, an archived one, or one outside this '
    + 'year. Indistinguishable from another office’s.',
  ))
  async read(@Ctx() ctx: RequestContext, @Query() query: ComplianceQueryDto) {
    return this.compliance.read(ctx, query);
  }
}
