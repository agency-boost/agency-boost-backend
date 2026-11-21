import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { UNIT_DASHBOARD, type UnitView } from '@/domain/constants';

/**
 * **`GET /home`'s one parameter** (P19.18-T4 AC-2; ADR-0271 §7): `scope`, the view the KPM Owner or an Admin narrows the
 * whole office's team parts to — *Semua downline ⌄*. Any other parameter is refused by name, as the dashboard's own read
 * refuses one; for every other leader it is accepted and changes nothing — their team is their *Grup langsung*.
 */
export class HomeQueryDto {
  @ApiPropertyOptional({
    enum: UNIT_DASHBOARD.VIEWS,
    description: 'For the owner or an administrator: the view of the whole agency the team parts are over — as the Unit '
      + 'Dashboard’s `scope`; omitted, or not offered, `downline`. Ignored for every other leader. Any other value is `400`.',
  })
  @IsOptional()
  @IsIn(UNIT_DASHBOARD.VIEWS)
  scope?: UnitView;
}
