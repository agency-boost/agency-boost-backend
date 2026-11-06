import { Controller, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { REVIEWED_PAGES } from './kpm-setup-mark.schema';
import { KpmSetup } from './kpm-setup.service';
import { OfficePeople } from './office-people';
import { ReviewedDto } from './reporting.response.dto';

/**
 * ***Sudah sesuai*** (P19.3-T2 AC-5, AC-10; UI-149, Overview R2): the reviewed flag of one of the four settings pages the
 * KPM setup card names. The route's name was fixed in the registry at P19.3-T0.
 */
@ApiTags('kpm-reporting')
@ApiBearerAuth()
@Controller('kpm/settings')
export class KpmSetupController {
  constructor(private readonly setup: KpmSetup) {}

  @Put(':page/reviewed')
  @RequirePermission('tenant_config:mark_reviewed')
  @ApiOperation({
    summary: 'Mark a settings page as reviewed (Sudah sesuai)',
    description:
      'Ticks the page’s step of the KPM setup card on the Overview and changes nothing else: the page’s data, its '
      + 'versions and its drafts are left as they are. The first mark is audited; a page already marked — by an earlier '
      + 'tap or by saving it — answers as it stands. The Owner’s and an Admin’s, for their own office; refused in every '
      + 'support session.',
  })
  @ApiParam({ name: 'page', enum: REVIEWED_PAGES })
  @ApiResponse({ status: 200, type: ReviewedDto })
  @ApiResponse({
    status: 403,
    type: ApiErrorEnvelope,
    description: '`PERM_DENIED` — an AB, an AAB, an Agent or a Super Admin. `IMPERSONATION_READ_ONLY` — any support '
      + 'session, which only looks (ADR-0206).',
  })
  @ApiResponse({
    status: 404,
    type: ApiErrorEnvelope,
    description: '`NOT_FOUND` — a page that is not one of the four. The office is always the caller’s own: no route names '
      + 'another office, so another office’s page is never reached.',
  })
  async markReviewed(@Ctx() ctx: RequestContext, @Param('page') page: string) {
    OfficePeople.require(ctx);
    return this.setup.markReviewed(ctx, page);
  }
}
