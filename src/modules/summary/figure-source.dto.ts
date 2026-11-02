import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { FigureSource } from './summary-figures';

/**
 * Declared for OpenAPI: where a production figure came from, and who corrected it — the Summary's and the
 * Unit Dashboard's alike. Its own file, so a module drawing the source imports nothing of the Summary's.
 */

/** Who corrected a figure: the membership, and the name the agency knows them by. */
export class FigureCorrectorDto {
  @ApiProperty({ description: 'The membership: the person in this agency, never their account.' }) membershipId!: string;
  @ApiProperty({ example: 'Sari Puspita' }) name!: string;
}

/** Who typed a member's figure for them (S2): the membership, and the name, `null` when they can no longer be named. */
export class FigureTypistDto {
  @ApiProperty({ description: 'The membership: the person in this agency, never their account.' }) membershipId!: string;
  @ApiProperty({ type: String, nullable: true, example: 'Sari Puspita' }) name!: string | null;
}

export class FigureSourceDto implements FigureSource {
  @ApiProperty({
    enum: ['imported', 'corrected', 'self_reported'],
    description: 'The carrier’s file, a correction by hand, or a figure **typed in the app, not uploaded** — by the member, '
      + 'or by whoever coaches them (`typedBy`).',
  })
  provenance!: 'imported' | 'corrected' | 'self_reported';
  @ApiProperty({ type: String, nullable: true, example: '2026-09' }) month!: string | null;

  @ApiProperty({
    type: FigureCorrectorDto, nullable: true,
    description:
      'Who corrected the figure by hand — an owner or administrator at the month table, or a leader on the '
      + 'Unit Dashboard. `null` for the file’s figure and the agent’s own, and when they can no longer be named.',
  })
  correctedBy!: { membershipId: string; name: string } | null;

  @ApiProperty({ type: String, nullable: true, description: 'When, for a correction by hand. ISO.' })
  correctedAt!: string | null;

  @ApiPropertyOptional({
    type: FigureTypistDto,
    description: 'Who typed a `self_reported` figure, **when it was not the member** — a coach (S2). Absent when the '
      + 'member typed it, and on every other source.',
  })
  typedBy?: { membershipId: string; name: string | null };
}
