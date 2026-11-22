import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { SettingsOverviewService } from './settings-overview.service';

/**
 * **The *Pengaturan* hub** (P19.21-T2; ADR-0274 §6) — `/kpm/settings`, the one menu item the eleven settings pages sit
 * behind. One read: each setting's status, only when the owner must act, and what its one-line description counts.
 */
@ApiTags('tenant configuration')
@ApiBearerAuth()
@Controller('kpm/settings')
export class SettingsOverviewController {
  constructor(private readonly overview: SettingsOverviewService) {}

  @Get('overview')
  @RequirePermission('tenant_config:read')
  @ApiOperation({
    summary: 'The Pengaturan hub: each setting\'s status and counts',
    description:
      'The eleven settings in the hub\'s order — `activity_types`, `lead_statuses`, `activation_checklist`, `training`, '
      + '`capability_mapping`, `events`, `campaigns`, `products`, `recruitment_pitch`, `branch_info`, `branding` — each '
      + 'with a `status` only when the owner must act: `unpublished` (changes agents do not see), `waiting` (script '
      + 'overrides waiting for approval — counted only for a reader who may approve them), `missing` (pitch materials of '
      + 'the six not uploaded), `no_logo` (no logo of the KPM\'s own or its template\'s); `null` otherwise. `counts` '
      + 'holds what each row\'s line counts. `unpublished` lists the settings the orange bar names. **A steward\'s** '
      + '(ADR-0268): the Owner, an Admin, a core leader, the Super Admin inside the KPM. Anybody else in the KPM is '
      + '`404 NOT_FOUND`; a request in no KPM `403 TENANT_NO_MEMBERSHIP`.',
  })
  async read(@Ctx() ctx: RequestContext) {
    return this.overview.read(ctx);
  }
}
