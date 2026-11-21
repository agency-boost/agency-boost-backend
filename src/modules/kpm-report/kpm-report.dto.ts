import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import { field } from '@/common/validation/violations';
import { KPM_REPORT_REFUSALS } from './kpm-report.messages';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** **The report's month** (P19.24-T2 AC-1: *the dialog's month*): `YYYY-MM`, the KPM's month or one of the twelve before it. */
export class KpmReportQueryDto {
  @ApiProperty({
    example: '2026-10',
    description: '`YYYY-MM`: the KPM\'s month or one of the `KPM_REPORT.MONTHS_BACK` (12) before it. Another month is '
      + '`400 VALIDATION_FAILED`.',
  })
  @Matches(MONTH, { message: field(KPM_REPORT_REFUSALS.VALIDATION_FAILED.monthShape) })
  month!: string;
}

/** *Kirim ke owner*'s body: the month the link opens. */
export class KpmReportLinkDto extends KpmReportQueryDto {}
