import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { AbGroupTargetsQueryDto, SetAbGroupTargetDto } from './ab-group-targets.dto';
import { AbGroupTargetsService } from './ab-group-targets.service';

/**
 * **Monthly targets per AB group** (P19.17-T4; ADR-0270 §4–§6): KPM Overview › *Performa vs target*'s targets, and the
 * target dialog every page that shows them opens. The KPM's stewards — the Super Admin in the KPM, the Owner, an Admin,
 * a core leader.
 */
@ApiTags('reporting')
@ApiBearerAuth()
@Controller('kpm/ab-group-targets')
export class AbGroupTargetsController {
  constructor(private readonly targets: AbGroupTargetsService) {}

  @Get()
  @RequirePermission('ab_group_target:read')
  @ApiOperation({
    summary: 'The month’s targets: Total KPM, each informal group’s total, every AB group',
    description:
      'For `month` (`YYYY-MM`, default the office’s): every AB group’s *Target Active Agent per bulan* and *Target '
      + 'Rekrut per bulan* — saved for the month, else carried from the latest earlier month, else `null` — its Rekrut '
      + 'YTD target and its APE target (the members’ Goal Setting ÷ 12), grouped by informal group A to Z then *Tanpa '
      + 'group*, each group’s and the KPM’s totals the sums. Test accounts are not counted. A month outside January '
      + '2024 to a year ahead `422 AB_GROUP_TARGET_MONTH_CLOSED`.',
  })
  async read(@Ctx() ctx: RequestContext, @Query() query: AbGroupTargetsQueryDto) {
    return this.targets.read(ctx, query.month);
  }

  @Put(':abMembershipId')
  @RequirePermission('ab_group_target:write')
  @ApiOperation({
    summary: 'Save one AB group’s targets for one month',
    description:
      'The target dialog’s *Simpan*: an active AB of this KPM (`404` otherwise, an AAB or an agent `422 '
      + 'ORG_GROUP_AB_ONLY`); 0 to 999 each; a month outside the open range `422 AB_GROUP_TARGET_MONTH_CLOSED`. Audited '
      + '`ab_group_target.set` with the targets before and after. Answers the month, so the row and the totals update.',
  })
  async set(@Ctx() ctx: RequestContext, @Param('abMembershipId') abMembershipId: string, @Body() dto: SetAbGroupTargetDto) {
    return this.targets.set(ctx, abMembershipId, dto);
  }
}
