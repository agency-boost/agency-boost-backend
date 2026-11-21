import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { PlatformConsole } from './platform-console.service';
import { ConsoleDashboardDto, ConsoleKpmPeopleDto } from './platform-console.response.dto';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });
const PLATFORM_ONLY = refusal(
  403,
  '`PERM_DENIED` — every tenant role, and a support session (its context is the member’s, holding no platform grant).',
);

/**
 * **The Super Admin console's own reads** (P19.23-T1, T2; ADR-0277; `functional/super-admin-console.md` §10): the
 * Dashboard, which the KPM list reads too, and a KPM page's people.
 */
@ApiTags('admin (Super Admin)')
@ApiBearerAuth()
@Controller('admin')
export class PlatformConsoleController {
  constructor(private readonly console: PlatformConsole) {}

  @Get('dashboard')
  @RequirePermission('platform_metrics:read')
  @ApiOperation({
    summary: 'The console’s Dashboard, and the KPM list’s figures',
    description:
      '*Keseluruhan*, *Pemakaian AgencyBoost* (count, %, and the same as of a month earlier), the approvals waiting, the '
      + 'insurers, and every live KPM with its usage by class and its issues — the dashboard’s *Perlu tindakan* and '
      + '*Adopsi per KPM*, and the KPM list’s cards (ADR-0277 §1, §2). Counts only, test accounts never counted; not '
      + 'audited per read (ADR-0011’s aggregate).',
  })
  @ApiResponse(PLATFORM_ONLY)
  @ApiResponse({ status: 200, type: ConsoleDashboardDto })
  async dashboard(@Ctx() ctx: RequestContext) {
    return this.console.dashboard(ctx);
  }

  @Get('tenants/:id/people')
  @RequirePermission('kpm:read_profile')
  @ApiOperation({
    summary: 'A KPM page’s people: Owner & admin, the first members, Lihat sebagai',
    description:
      'The KPM’s Owner (or the named Owner who waits), its Admins and core leaders, its counted members by class with '
      + 'the first five, and the real people *Lihat sebagai* offers per role — names and classes, never a contact '
      + '(ADR-0277 §3). `404` for a KPM that is not there or an id that is not one.',
  })
  @ApiResponse(refusal(404, '`NOT_FOUND` — no live KPM has this id: indistinguishable from another office’s.'))
  @ApiResponse(PLATFORM_ONLY)
  @ApiResponse({ status: 200, type: ConsoleKpmPeopleDto })
  async people(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.console.kpmPeople(ctx, id);
  }
}
