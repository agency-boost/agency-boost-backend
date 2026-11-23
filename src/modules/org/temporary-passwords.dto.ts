import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsMongoId, IsOptional } from 'class-validator';

/** At most this many memberships named in one request: an office's worth, many times over. */
export const MAX_NAMED_MEMBERSHIPS = 2000;

/**
 * **Whom the *Akun & password* PDF lists** (P19.30-T1 AC-1, T2 AC-2; ADR-0288 §2): every account of the KPM in context not
 * yet its person's own, or — `membershipIds` — only among the memberships named: *Import people*'s own PDF, for the
 * accounts its commit made (`RosterCommitDto.membershipIds`).
 */
export class TemporaryPasswordsDto {
  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: MAX_NAMED_MEMBERSHIPS,
    example: ['6740a1f2c3d4e5f601234567'],
    description: 'Narrow the PDF to these memberships of the KPM in context. Absent: every account not yet its person’s '
      + 'own. Each an ObjectId; one that is not a membership of this KPM is `404`. One whose account is already its '
      + 'person’s own is simply not listed.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_NAMED_MEMBERSHIPS)
  @IsMongoId({ each: true })
  membershipIds?: string[];
}

/** **How many the PDF would list** (AC-6): what the confirmation says before anything is issued. */
export class TemporaryPasswordsPreviewDto {
  @ApiProperty({
    example: 110,
    description: 'The people the PDF would list now: active members whose account is not yet their own, never a test '
      + 'account or a Super Admin. `0`: nobody — the dialog says so and offers no download.',
  })
  count!: number;

  @ApiProperty({ example: 'PruDynamic', description: 'The KPM\'s name, for the confirmation\'s line under its title.' })
  kpmName!: string;

  @ApiProperty({
    example: 'Akun-password-PruDynamic-2026-11-22.pdf',
    description: 'What the download is saved as — the name its `Content-Disposition` carries, the day the KPM\'s.',
  })
  fileName!: string;
}
