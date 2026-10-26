import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Allow, IsOptional, IsString, MaxLength } from 'class-validator';
import { GOAL_MODES } from './goal.schema';

/**
 * **`@Allow()`, and the whole body is read by `checkGoal` instead.**
 *
 * The global pipe runs with `whitelist` and `forbidNonWhitelisted`, so a property with no
 * validation decorator is stripped **before** a service sees it — which is how three event and
 * campaign DTOs shipped unable to accept the fields they documented. A goal's rules are two
 * layers — is this a number in the right unit, and can the cascade make a plan from it — so they
 * cannot live in decorators; `@Allow()` keeps the body intact on the way past.
 */
export class SaveGoalDto {
  @ApiProperty({ enum: GOAL_MODES, description: 'Which entry mode produced the annual target.' })
  @Allow()
  mode!: 'direct' | 'from_savings';

  @ApiProperty({ type: Number, example: 500_000_000_00, description: 'IDR **sen**, not rupiah.' })
  @Allow()
  annualApeTargetMinor!: number;

  @ApiProperty({ type: Number, example: 50_000_000_00, description: 'IDR sen. Kept in either mode, so switching back is lossless.' })
  @Allow()
  savingsTargetMinor!: number;

  @ApiProperty({ type: Number, example: 10, description: 'Per cent. `12.5` is twelve and a half — decimals survive (I-108).' })
  @Allow()
  commissionRatePct!: number;

  @ApiProperty({ type: Number, example: 3.2, description: 'The cascade’s divisor. Defaulted per office, and overridable.' })
  @Allow()
  monthsLeft!: number;

  @ApiProperty({ type: Number, example: 0, description: 'IDR sen. The agent’s own typed figure, the answer only while the office holds no year-to-date figure for the year. Ignored on a save of somebody else’s plan (`for`): their stored figure is kept (ADR-0075).' })
  @Allow()
  apeAchievedMinor!: number;

  @ApiProperty({ type: Number, example: 18_000_000_00, description: 'IDR sen per policy. Zero is refused — GOAL_INVALID_ASSUMPTION.' })
  @Allow()
  caseSizeMinor!: number;

  @ApiProperty({ type: Number, example: 30, description: '*Appointment to Sales meeting*: per cent of set appointments that become a sales meeting.' })
  @Allow()
  leadsToApptPct!: number;

  @ApiProperty({ type: Number, example: 30, description: '*Closing rate*: per cent of sales meetings that become a submitted policy.' })
  @Allow()
  closingRatePct!: number;

  @ApiPropertyOptional({
    type: String,
    example: '2026',
    description: 'Ignored: the period is the path. Accepted so a client may round-trip what it read.',
  })
  @Allow()
  period?: string;
}

/**
 * **`GET /goals/:period`'s query: whose plan, and nothing else** (P11-T7; `functional/coaching.md`, the
 * Data contract). `for` was a raw `@Query('for')` since P8-T4, the one subject parameter in the API the
 * validation pipe never saw; it is validated as every query field is, so a parameter of any other name
 * is refused by name rather than ignored. `PUT`'s `for` joined it with its `session` (P11-T8):
 * `SaveGoalQueryDto`, below.
 */
export class GoalReadQueryDto {
  @ApiPropertyOptional({
    maxLength: 64,
    description:
      'A **membership** you may read the plan of, as your grant allows (§3.6). Omitted, or your own, it '
      + 'is your own. Somebody outside it is a **404, never a 403**: a refusal that confirmed the person '
      + 'exists would answer a question nobody was entitled to ask. Anybody else’s plan comes back '
      + 'with `measured: null`.',
  })
  @IsOptional() @IsString() @MaxLength(64)
  for?: string;
}

/**
 * **`PUT /goals/:period`'s query: whose plan, and through which coaching session** (P11-T8, ADR-0075;
 * `functional/coaching.md`, *The Goal card*). Both validated as every query field is, so a parameter of
 * any other name is refused by name.
 */
export class SaveGoalQueryDto {
  @ApiPropertyOptional({
    maxLength: 64,
    description:
      'Save **somebody else’s** goal, as §3.6 allows a leader, an Owner and an Admin to. It becomes '
      + 'their goal immediately — there is no acceptance step (ADR-0046) — the record names who saved '
      + 'it, and **they are notified**. Somebody outside your grant is a **404, never a 403**.',
  })
  @IsOptional() @IsString() @MaxLength(64)
  for?: string;

  @ApiPropertyOptional({
    maxLength: 64,
    description:
      'The coaching session the save is made in: **your own open session with that person**, a draft or '
      + 'one reopened — anything else is a 404, and a finalized one `COACHING_SESSION_FINALIZED` (409). '
      + 'Every save through one session reaches them as **one notice**: in the app at the first save, kept '
      + 'to the latest value by the later ones, and emailed once, when the session is finalized. Without '
      + 'it, each save is its own notice, in the app and by email.',
  })
  @IsOptional() @IsString() @MaxLength(64)
  session?: string;
}
