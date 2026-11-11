import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { field } from '@/common/validation/violations';
import { UNIT_DASHBOARD, type UnitView } from '@/domain/constants';
import { SCOPE_DESCRIPTION } from './unit-dashboard.dto';
import { UNIT_DASHBOARD_REFUSALS } from './unit-dashboard.messages';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * **The *Potensi* tab's read** (P19.1-T6, UI-155): `month`, `for` and `scope` (ADR-0249 §1), and nothing else — a
 * parameter of any other name is refused by name, as the dashboard's own read refuses one.
 */
export class UnitPotensiQueryDto {
  @ApiPropertyOptional({
    example: '2026-11',
    description:
      'The month to read, on the agency’s calendar (Asia/Jakarta). Omitted, the current month; a month after it is '
      + 'refused (`400`). An earlier month reads what its records say about it: its switches, its outcomes and its '
      + 'production row.',
  })
  @IsOptional()
  @IsString()
  @Matches(MONTH, { message: field(UNIT_DASHBOARD_REFUSALS.VALIDATION_FAILED.potensiMonthShape) })
  month?: string;

  @ApiPropertyOptional({
    maxLength: 64,
    description: 'The **membership** whose unit to read, as the dashboard’s own `for`. Omitted, it is your own unit.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  for?: string;

  @ApiPropertyOptional({ enum: UNIT_DASHBOARD.VIEWS, description: SCOPE_DESCRIPTION })
  @IsOptional()
  @IsIn(UNIT_DASHBOARD.VIEWS)
  scope?: UnitView;
}

/** **A person's *Potensi* sheet** (P19.1-T6 AC-6, AC-7): `month`, and nothing else. */
export class UnitPotensiPersonQueryDto {
  @ApiPropertyOptional({
    example: '2026-11',
    description: 'The month to read, as the tab’s own `month`. Omitted, the current month; a later one is `400`.',
  })
  @IsOptional()
  @IsString()
  @Matches(MONTH, { message: field(UNIT_DASHBOARD_REFUSALS.VALIDATION_FAILED.potensiMonthShape) })
  month?: string;
}
