import { ApiProperty } from '@nestjs/swagger';
import type { HierarchyRole } from '@/modules/org/membership.schema';
import type { KpmOwnerList, KpmOwnerView } from './kpm-owners.service';

/** One owner as *KPM Owner · n* lists them (P19.27-T2 AC-1, T4 AC-1; ADR-0285). */
export class KpmOwnerViewDto implements KpmOwnerView {
  @ApiProperty() userId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Their live membership in this KPM; `null` with none.' })
  membershipId!: string | null;

  @ApiProperty() fullName!: string;

  @ApiProperty({ type: String, nullable: true }) agentCode!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: ['ab', 'aab', 'agent'], description: 'The orange label before the name.' })
  role!: HierarchyRole | null;

  @ApiProperty({ type: String, nullable: true }) photoUrl!: string | null;

  @ApiProperty({ type: String, format: 'date-time', description: '*Owner sejak <Mon YYYY>*.' })
  since!: string;

  @ApiProperty({
    enum: ['active', 'invited', 'not_invited'],
    description: '`active` — *Aktif*: the account is theirs, signed in or its address proven (OD-475), and nothing is '
      + 'offered to send. `invited` — *Diundang*: invited, the account not theirs yet (*Kirim ulang undangan* then '
      + 'offered). `not_invited` — *Belum diundang*.',
  })
  state!: 'active' | 'invited' | 'not_invited';
}

/** *KPM Owner · n*'s answer: the owners in order of `since`, and whether the reader may add and remove them. */
export class KpmOwnerListDto implements KpmOwnerList {
  @ApiProperty({ type: () => KpmOwnerViewDto, isArray: true })
  owners!: KpmOwnerViewDto[];

  @ApiProperty({ type: Boolean, description: 'An owner of this KPM, or the Super Admin — never an Admin.' })
  canManage!: boolean;
}
