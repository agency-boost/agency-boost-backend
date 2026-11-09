import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { UnitPotensiPersonQueryDto, UnitPotensiQueryDto } from './unit-potensi.dto';
import { UnitPotensiDto, UnitPotensiPersonDto } from './unit-potensi.response.dto';
import { UnitPotensiService } from './unit-potensi.service';

const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

const MONTH_REFUSED =
  '`VALIDATION_FAILED` — `month` is not a month, or is after the agency’s current month; or a parameter has another '
  + 'name. `details.field` names it.';

/**
 * **The Unit Dashboard's *Potensi* tab** (P19.1-T6; UI-155, UI-159 item 4; ADR-0193; `functional/unit-dashboard.md`,
 * *November 2026*): the tiles and the list grouped per unit, and a person's read-only sheet. Its own controller beside
 * `UnitDashboardController`, on the same prefix, on **`unit_dashboard:read_potensi`** — the dashboard's grant without
 * the Agent's (*"agents see no Potensi tab"*). Literal paths, so neither shadows `GET /unit/dashboard`.
 */
@ApiTags('unit-dashboard')
@ApiBearerAuth()
@Controller('unit')
export class UnitPotensiController {
  constructor(private readonly potensi: UnitPotensiService) {}

  @Get('dashboard/potensi')
  @RequirePermission('unit_dashboard:read_potensi')
  @ApiOperation({
    summary: 'A unit’s potential closings and recruits for a month',
    description:
      'The *Potensi* tab, for the unit the dashboard would answer — yours, or with `for` a leader’s below you; the '
      + 'agency’s owner and its administrators any leader’s. **Two tiles**: *AA*, the people who are AA in the month — a '
      + 'sales lead marked *Berhasil* in it, or the month’s production row showing a policy (never MAA); *Rekrut*, the '
      + 'kandidat marked *Berhasil* in it. **One card per unit below the head, then the head’s own**, each with its '
      + 'leader first: everybody’s *n potensi* (leads switched on for the month and still open at its end) on both tiles, '
      + 'and the card’s sums. The month is the agency’s, Asia/Jakarta: on the 1st every switch reads off, and an earlier '
      + 'month still reads what became of its switches. **An Agent is refused** (`403`). Somebody who leads nobody is '
      + 'answered their own card alone. Every member shown other than you is recorded as read.',
  })
  @ApiResponse({ status: 200, type: UnitPotensiDto })
  @ApiResponse(refusal(400, MONTH_REFUSED))
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — `for` names yourself, somebody who leads nobody, somebody outside your reach or who has left, **or** '
    + 'somebody in another office: indistinguishable, as on `GET /unit/dashboard`.',
  ))
  async read(@Ctx() ctx: RequestContext, @Query() query: UnitPotensiQueryDto) {
    return this.potensi.read(ctx, query);
  }

  @Get('dashboard/potensi/:membershipId')
  @RequirePermission('unit_dashboard:read_potensi')
  @ApiOperation({
    summary: 'One person’s potential closings and kandidat for a month',
    description:
      'The sheet a row opens, read-only: their sales leads switched on for the month and still open — the client’s name, '
      + 'the next action’s date and note, the stage — and their kandidat switched on, then those who became rekrut in '
      + 'the month with the day and the membership each became, where linked. Their WhatsApp number while they are a '
      + 'member. **Yourself, or somebody whose leads you read** (`lead:read`: somebody you coach); anybody else is 404. '
      + 'Somebody else’s sheet is recorded as a read of their leads.',
  })
  @ApiResponse({ status: 200, type: UnitPotensiPersonDto })
  @ApiResponse(refusal(400, MONTH_REFUSED))
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — somebody whose leads you do not read (`lead:read`: yourself, or somebody you coach), somebody who has '
    + 'left, nobody, **or** somebody in another office: indistinguishable, so a refusal confirms no id exists.',
  ))
  async person(
    @Ctx() ctx: RequestContext, @Param('membershipId') membershipId: string, @Query() query: UnitPotensiPersonQueryDto,
  ) {
    return this.potensi.person(ctx, membershipId, query);
  }
}
