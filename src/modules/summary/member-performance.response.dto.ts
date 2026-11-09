import { ApiProperty } from '@nestjs/swagger';
import type { MemberPerformanceView } from './member-performance.service';

/** Declared for OpenAPI. The wire shape lives on `MemberPerformanceService` (ADR-0205 §1). */

class PerformanceActivityDto {
  @ApiProperty({ example: '2026-10-30', description: 'The first of the 7 days, the office’s calendar.' }) from!: string;
  @ApiProperty({ example: '2026-11-05', description: 'The office’s today, the last of the 7.' }) to!: string;
  @ApiProperty({
    example: 14,
    description: '*Aktivitas 7 hari*: every count the person logged over the 7 days — the coaching session’s Activity card.',
  })
  count!: number;
}

class PerformanceProductionDto {
  @ApiProperty({ example: '2026' }) year!: string;
  @ApiProperty({
    type: Number, nullable: true, example: 310_000_000_000,
    description: '*Produksi tahun ini*, IDR sen: the office’s year to date for the member — **never their own estimate**. '
      + '`null` while the office holds none (*Belum diunggah*).',
  })
  actualMinor!: number | null;
  @ApiProperty({
    type: Number, nullable: true, example: 500_000_000_000,
    description: 'The year’s goal, IDR sen; `null` while no goal is saved (*no goal*).',
  })
  targetMinor!: number | null;
  @ApiProperty({
    type: Number, nullable: true, example: 62,
    description: '*n% dari goal* (`APE_ATTAINMENT_PCT`, capped for display); `null` without a goal or an official figure.',
  })
  attainmentPct!: number | null;
  @ApiProperty({ description: 'A goal is saved for the year. An unsaved default measures nobody.' }) goalSet!: boolean;
}

class PerformanceOneOnOneDto {
  @ApiProperty({ example: '2026-10-21', description: 'The day of their latest 1:1 as coachee, finalized at least once.' })
  date!: string;
}

class PerformanceLeadsDto {
  @ApiProperty({ example: '2026-11', description: 'The office’s calendar month the closings are counted in.' }) month!: string;
  @ApiProperty({ example: 9, description: '*Leads*: their open sales leads, the Unit Dashboard row’s *Leads penjualan*.' })
  open!: number;
  @ApiProperty({
    example: 2,
    description: '*n closing*: their sales leads that first reached *Paid and issued* this month, the row’s *Closing*.',
  })
  closing!: number;
}

export class MemberPerformanceDto implements MemberPerformanceView {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: '2026-11-05', description: 'The office’s day the figures are as of.' }) today!: string;
  @ApiProperty({ type: PerformanceActivityDto }) activity!: PerformanceActivityDto;
  @ApiProperty({ type: PerformanceProductionDto }) production!: PerformanceProductionDto;
  @ApiProperty({
    type: PerformanceOneOnOneDto, nullable: true, description: '*1:1 terakhir*; `null` is *Belum pernah*.',
  })
  lastOneOnOne!: PerformanceOneOnOneDto | null;
  @ApiProperty({ type: PerformanceLeadsDto }) leads!: PerformanceLeadsDto;
}
