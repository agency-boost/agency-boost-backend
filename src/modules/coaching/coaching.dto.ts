import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { UNIT_DASHBOARD, type UnitView } from '@/domain/constants';

/**
 * **The roster's one parameter** (P19.18-T5 AC-1; ADR-0271 §9): `scope`, the view — *Semua downline ⌄* — as the Unit
 * Dashboard's. A query parameter of any other name is refused by name, rather than ignored.
 */
export class CoachingRosterQueryDto {
  @ApiPropertyOptional({
    enum: UNIT_DASHBOARD.VIEWS,
    description: 'Whose people: the Unit Dashboard’s views — `unit` (*Direct Unit*), `direct` (*Grup langsung*), `informal` '
      + '(*Grup informal*), `downline` (*Semua downline*). Omitted, or a view not offered, everybody you coach — for the '
      + 'agency’s owner or an administrator, the whole agency. Any other value is `400`.',
  })
  @IsOptional()
  @IsIn(UNIT_DASHBOARD.VIEWS)
  scope?: UnitView;
}

/**
 * **Empty on purpose** too (`GET /coaching/coachees/:membershipId`): the path names the person, and
 * nothing else is asked of the caller. A query parameter of any name — a `for`, a second id — is refused
 * by name, as the roster's is, rather than ignored.
 */
export class CoacheeQueryDto {}
