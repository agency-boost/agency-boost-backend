import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Allow } from 'class-validator';
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

  @ApiProperty({ type: Number, example: 0, description: 'IDR sen. The agent’s own typed figure, the answer only while the office holds no year-to-date figure for the year.' })
  @Allow()
  apeAchievedMinor!: number;

  @ApiProperty({ type: Number, example: 18_000_000_00, description: 'IDR sen per policy. Zero is refused — GOAL_INVALID_ASSUMPTION.' })
  @Allow()
  caseSizeMinor!: number;

  @ApiProperty({ type: Number, example: 30, description: 'Per cent of contacted leads that become an appointment.' })
  @Allow()
  leadsToApptPct!: number;

  @ApiProperty({ type: Number, example: 30, description: 'Per cent of appointments that become a closing.' })
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
