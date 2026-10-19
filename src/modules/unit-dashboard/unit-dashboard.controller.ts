import { Body, Controller, Get, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { UnitDashboardQueryDto, UpdateProductionDto } from './unit-dashboard.dto';
import { ProductionUpdatedDto, UnitDashboardDto } from './unit-dashboard.response.dto';
import { UnitDashboardService } from './unit-dashboard.service';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/**
 * The Unit Dashboard (`functional/unit-dashboard.md`, the Data contract): a leader's roster and its
 * figures, and *Update production*.
 *
 * **The literal path before nothing**: `dashboard/production` is a different method from `dashboard`, so
 * the two never shadow one another.
 */
@ApiTags('unit-dashboard')
@ApiBearerAuth()
@Controller('unit')
export class UnitDashboardController {
  constructor(private readonly dashboard: UnitDashboardService) {}

  @Get('dashboard')
  @RequirePermission('unit_dashboard:read')
  @ApiOperation({
    summary: 'A leader’s unit, with every figure on it',
    description:
      'The leader — you, or with `for` a leader below you — and everybody below them on the current leader '
      + 'edges, grouped as the coaching roster groups them: *Your Unit* (the leader and the agents who answer '
      + 'to them directly and lead nobody), then each unit below, nested. Every row carries the figures that '
      + 'person’s own screens show: the Summary’s goal figures for the period with where the achieved figure '
      + 'came from, the agency’s production for the month, four lead counts, the goal’s three activities '
      + 'against their targets, the last 1:1, the status and the pacing mark for the calendar month, and the '
      + 'next open action item. A total row per unit and four tiles, each the sum of the rows it covers, a '
      + 'percentage from the sums. **Somebody who leads nobody is answered an empty unit**, not an error. '
      + 'Computed on each read, not paginated. Every member shown other than you is recorded as read.',
  })
  @ApiResponse({ status: 200, type: UnitDashboardDto })
  /*
   * A path parameter is what makes `openapi.ts` derive a 404, and this route has none: the leader is a
   * query field. So the refusal is written here, worded as every 404 in the document is.
   */
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — `for` names yourself, somebody who leads nobody, somebody outside your reach or who has '
    + 'left, **or** somebody in another office. They are deliberately indistinguishable: a `403` here would '
    + 'confirm the id exists.',
  ))
  async read(@Ctx() ctx: RequestContext, @Query() query: UnitDashboardQueryDto) {
    return this.dashboard.read(ctx, query);
  }

  @Patch('dashboard/production')
  @RequirePermission('unit_dashboard:update_production')
  @ApiOperation({
    summary: 'Update production from the company report',
    description:
      '*Update production*: this month’s APE and the year to date for each person sent, either or both, '
      + 'in IDR minor units. Each figure that changes is a **correction of the agency’s figure**, under your '
      + 'name, with the reason *Updated on the Unit Dashboard from the company report.*, audited figure by '
      + 'figure — the month table, the Summary and the next import’s preview show it, and it stands through '
      + 'the next upload unless whoever imports chooses to replace it. A figure cannot be cleared here. Only '
      + 'the agency’s current month. Everything is checked before anything is written: one figure out of '
      + 'range, one person out of reach, and nothing is saved. A figure already holding the value changes '
      + 'nothing and is not counted.',
  })
  @ApiResponse({ status: 200, type: ProductionUpdatedDto })
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — a row names somebody you may not update — outside your unit, somebody who has left, or '
    + 'yourself while you lead nobody — **or** somebody in another office. Indistinguishable on purpose: a '
    + '`403` would confirm the id exists. Nothing is written.',
  ))
  @ApiResponse(refusal(
    409,
    '`UPLOAD_MONTH_LOCKED` — the agency has locked the month; its owner or an administrator reopens it. '
    + '`VERSION_CONFLICT` — the month changed since you read it. Nothing is written.',
  ))
  @ApiResponse(refusal(
    422,
    '`UPLOAD_VALUE_OUT_OF_RANGE` — a figure, or the pair it would leave (the year to date below the month), '
    + 'is out of range. `details.membershipId` and `details.cadence` name it. Nothing is written.',
  ))
  async updateProduction(@Ctx() ctx: RequestContext, @Body() body: UpdateProductionDto) {
    return this.dashboard.updateProduction(ctx, body);
  }
}
