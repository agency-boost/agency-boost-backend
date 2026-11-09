import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { AnalyticsEditorView } from './analytics-template.service';
import type { OpenRunCounts } from './open-survey-runs.port';

/** The bounds the *Advanced analytics* editor holds a draft to, served once (invariant §7). */
export class AnalyticsLimitsDto {
  @ApiProperty({ type: Number, example: 40 }) uploadFieldsMax!: number;
  @ApiProperty({ type: Number, example: 200 }) codePatternMaxLength!: number;
  @ApiProperty({ type: Number, example: 50 }) completePctMin!: number;
  @ApiProperty({ type: Number, example: 100 }) completePctMax!: number;
  @ApiProperty({ type: Number, example: 10 }) ytdTolerancePctMax!: number;
  @ApiProperty({ type: Number, example: 12 }) historyMonthsBeforeJoin!: number;
  @ApiProperty({ type: Number, example: 3 }) minPeers!: number;
  @ApiProperty({ type: Number, example: 17 }) ageLabelFloor!: number;
  @ApiProperty({ type: Number, example: 60 }) labelMaxLength!: number;
  @ApiProperty({ type: Number, example: 200 }) tipMaxLength!: number;
  @ApiProperty({ type: Number, example: 300 }) questionMaxLength!: number;
  @ApiProperty({ type: Number, example: 50 }) peerBandPctMax!: number;
}

/** What the *Advanced analytics* editor reads beside the payload (ADR-0214 §1, §2, §6). */
export class AnalyticsEditorDto implements AnalyticsEditorView {
  @ApiProperty({ type: Number, example: 12, description: 'The live KPMs that read the template now.' })
  kpms!: number;

  @ApiProperty({
    type: 'object', additionalProperties: { type: 'string' }, example: { APE: '2024-01' },
    description: 'Each kode a KPM on the template holds a value for, with the earliest month it does: its unit and its '
      + 'start month are locked.',
  })
  held!: Record<string, string>;

  @ApiProperty({ type: String, example: '2026-12', description: 'A new column’s *Berlaku mulai* by default.' })
  nextMonth!: string;

  @ApiProperty({
    type: 'object', additionalProperties: { type: 'array', items: { type: 'object' } },
    description: '*Dipakai di*: every reader of each kode, `{ id, en }`. A kode absent reads *Belum dipakai*.',
  })
  readers!: AnalyticsEditorView['readers'];

  @ApiProperty({ type: AnalyticsLimitsDto })
  limits!: AnalyticsLimitsDto;
}

/** `GET …/template/advanced_analytics/code-check` (ADR-0214 §7). */
export class AnalyticsCodeCheckDto {
  @ApiProperty({ type: Number, example: 312, description: 'Registered codes the pattern does not match.' })
  mismatched!: number;

  @ApiProperty({ type: Number, example: 1840, description: 'Registered codes in the KPMs that read the template.' })
  total!: number;

  @ApiProperty({ type: String, isArray: true, example: ['80777'], description: 'Up to five of the codes it does not match.' })
  examples!: string[];

  @ApiPropertyOptional({ type: Boolean, description: 'With `example`: whether the pattern matches it.' })
  exampleMatches?: boolean;
}

/** How many runs of one kind are open, and in how many KPMs. */
export class OpenRunCountsDto implements OpenRunCounts {
  @ApiProperty({ type: Number, example: 1 }) runs!: number;
  @ApiProperty({ type: Number, example: 1 }) kpms!: number;
}

/** `GET …/template/advanced_analytics/open-runs` (ADR-0216 §2). */
export class AnalyticsOpenRunsDto {
  @ApiProperty({ type: OpenRunCountsDto }) nps!: OpenRunCountsDto;
  @ApiProperty({ type: OpenRunCountsDto }) qual!: OpenRunCountsDto;
}
