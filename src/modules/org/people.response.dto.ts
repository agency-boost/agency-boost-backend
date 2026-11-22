import { ApiProperty } from '@nestjs/swagger';
import { KpmOwnerViewDto } from '@/modules/tenants/kpm-owners.response.dto';
import type { HierarchyRole } from './membership.schema';
import type { KpmStewards, PeopleHistoryEntry, PeopleHistoryKind, RosterImportView } from './people.service';

/** One line of *Riwayat*. */
export class PeopleHistoryEntryDto implements PeopleHistoryEntry {
  @ApiProperty() id!: string;

  @ApiProperty({ enum: ['role', 'removed', 'moved', 'rejoined'], description: 'A role change, a removal, a move to another leader, a return.' })
  kind!: PeopleHistoryKind;

  @ApiProperty() membershipId!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() agentCode!: string;

  @ApiProperty({ enum: ['ab', 'aab', 'agent'], description: 'Their class now: the AB / AAB label before the name.' })
  role!: HierarchyRole;

  @ApiProperty({ type: String, nullable: true }) photoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true, enum: ['ab', 'aab', 'agent'], description: 'A role change only.' })
  fromRole!: HierarchyRole | null;

  @ApiProperty({ type: String, nullable: true, enum: ['ab', 'aab', 'agent'], description: 'A role change only.' })
  toRole!: HierarchyRole | null;

  @ApiProperty({ type: String, nullable: true, description: 'A move only: the leader they left, by name.' })
  fromLeaderName!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'A move only: the leader they moved under, by name.' })
  toLeaderName!: string | null;

  @ApiProperty({ type: String, nullable: true }) reason!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Who acted, by name; the Super Admin by their account.' })
  actorName!: string | null;

  @ApiProperty({ type: String, format: 'date-time' }) at!: string;

  @ApiProperty({ type: Boolean, description: 'The reader may open their sheet: a live membership in their reach.' })
  openable!: boolean;
}

class StewardOwnerDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() agentCode!: string;
  @ApiProperty({ enum: ['ab', 'aab', 'agent'] }) role!: HierarchyRole;
  @ApiProperty({ type: String, nullable: true }) photoUrl!: string | null;
}

/** *KPM admins*' three tiles. */
export class KpmStewardsDto implements KpmStewards {
  @ApiProperty({ type: () => StewardOwnerDto, nullable: true, description: 'The first owner (ADR-0285 §3); `null` while it has none.' })
  owner!: KpmStewards['owner'];

  @ApiProperty({ type: () => KpmOwnerViewDto, isArray: true, description: '*KPM Owner · n*: every owner, in order of `since`.' })
  owners!: KpmOwnerViewDto[];

  @ApiProperty({ type: Boolean, description: 'The reader may add and remove owners: an owner, or the Super Admin inside the KPM.' })
  canManageOwners!: boolean;

  @ApiProperty({ type: Number, description: 'Active Admins, test accounts not counted.' })
  admins!: number;

  @ApiProperty({ type: Number, description: 'Active core leaders, test accounts not counted.' })
  coreLeaders!: number;
}

/** One saved file of *Riwayat unggah*. */
export class RosterImportViewDto implements RosterImportView {
  @ApiProperty() importId!: string;
  @ApiProperty({ type: String, nullable: true, example: 'anggota_nov_2026.xlsx' }) fileName!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) importedAt!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Who saved it.' }) byName!: string | null;
  @ApiProperty({ type: Number, description: '*n baru*: new people, those invited on WhatsApp among them.' }) created!: number;
  @ApiProperty({ type: Number, description: '*n diperbarui*.' }) updated!: number;
  @ApiProperty({ type: Number, description: 'Of the new, invited on WhatsApp.' }) invited!: number;
  @ApiProperty({ type: Number, description: 'Rows not saved.' }) skipped!: number;
}
