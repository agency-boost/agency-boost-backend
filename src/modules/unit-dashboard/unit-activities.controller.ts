import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { UnitActivitiesQueryDto } from './unit-dashboard.dto';
import { UnitActivitiesDto } from './unit-activities.response.dto';
import { UnitActivitiesService } from './unit-activities.service';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/**
 * **The Unit Dashboard's *Activities* tab** (UI V1, Phase 18.11 T4; UI-001; `functional/unit-dashboard.md`, *UI V1
 * (2026-10-30)*): the count per activity type × person for a week or a month, and the ratios of the *Unit* and the
 * *Group* over the last 30 days. Its own controller beside `UnitDashboardController`, on the same prefix and the same
 * grant: a literal path, so it never shadows `GET /unit/dashboard`.
 */
@ApiTags('unit-dashboard')
@ApiBearerAuth()
@Controller('unit')
export class UnitActivitiesController {
  constructor(private readonly activities: UnitActivitiesService) {}

  @Get('dashboard/activities')
  @RequirePermission('unit_dashboard:read')
  @ApiOperation({
    summary: 'A unit’s activity per person, and its ratios',
    description:
      'The *Activities* tab: for the unit the dashboard would answer — yours, or with `for` a leader’s below you; the '
      + 'agency’s owner and its administrators any leader’s — **every person’s count per activity type** over a week, '
      + 'Monday to Sunday, or a calendar month on the agency’s calendar (`span`, the period holding `date`), with the '
      + '*Unit*’s and the *Group*’s *Total* column summed; the agency’s sections and types in its order, an archived one '
      + 'only while the period counts it; and **the Ratio page’s ratios over the *Unit*’s and the *Group*’s counts '
      + 'summed**, always the last 30 days. Counts only, never points. Somebody who leads nobody is answered an empty '
      + 'unit. Every member shown other than you is recorded as read. With `ratioFor`, **one member’s own ratios** too '
      + '(`ratios.person`): somebody of the *Group* read, on their own rung.',
  })
  @ApiResponse({ status: 200, type: UnitActivitiesDto })
  @ApiResponse(refusal(
    400,
    '`VALIDATION_FAILED` — `date` is not a day, or is after the agency’s today; `span` is neither `week` nor `month`; or '
    + 'a parameter has another name. `details.field` names it.',
  ))
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — `for` names yourself, somebody who leads nobody, somebody outside your reach or who has left, **or** '
    + 'somebody in another office: indistinguishable, as on `GET /unit/dashboard`. Likewise `ratioFor` naming anybody '
    + 'who is not in the *Group* read.',
  ))
  async read(@Ctx() ctx: RequestContext, @Query() query: UnitActivitiesQueryDto) {
    return this.activities.read(ctx, query);
  }
}
