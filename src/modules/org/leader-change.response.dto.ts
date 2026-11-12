import { ApiProperty } from '@nestjs/swagger';
import type { LeaderMoveChoice } from './leader-change.service';
import type { HierarchyRole } from './membership.schema';
import type { PendingMoveView } from './transfers.service';

/**
 * **Changing who somebody reports to — the answers** (ADR-0247): the picker's leaders, a move waiting on the office,
 * and a request withdrawn. Each `implements` the interface its service returns, so the contract cannot drift.
 */

/** A leader somebody may be moved under. */
export class LeaderMoveChoiceDto implements LeaderMoveChoice {
  @ApiProperty({ type: String })
  membershipId!: string;

  @ApiProperty({ type: String })
  fullName!: string;

  @ApiProperty({ type: String })
  agentCode!: string;

  @ApiProperty({ type: String, example: 'AB', description: 'Their rung, by its code on the company’s ladder.' })
  orgLevelCode!: string;

  @ApiProperty({ type: String, enum: ['ab', 'aab', 'agent'] })
  role!: HierarchyRole;

  @ApiProperty({ type: Number, description: 'How many active people are below them now.' })
  unitSize!: number;

  @ApiProperty({
    type: Boolean,
    description: 'The move is made at once (`PUT …/leader`): every choice of the Owner or an Admin, and a leader’s own '
      + 'tree. `false`: a leader outside their tree, asked of the Owner or an Admin (`POST …/transfer-request`).',
  })
  direct!: boolean;
}

/** A move waiting on the Owner or an Admin, as the leader who asked sees it. */
export class PendingMoveDto implements PendingMoveView {
  @ApiProperty({ type: String })
  transferId!: string;

  @ApiProperty({ type: String, description: 'The leader they would move under, by name.' })
  toName!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  requestedAt!: string;
}

/** A transfer request withdrawn by whoever asked. */
export class CancelledTransferDto {
  @ApiProperty({ type: String })
  transferId!: string;

  @ApiProperty({ type: String, enum: ['cancelled'] })
  status!: 'cancelled';
}
