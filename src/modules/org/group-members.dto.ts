import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, MaxLength } from 'class-validator';
import { UNIT_DASHBOARD } from '@/domain/constants';
import type { GroupMembersAdded } from './group.service';

/**
 * ***+ Tambah ke grup*** (the client's message of 11 November 2026, item 7; ADR-0249 §4, amended by ADR-0270 §1): the ABs
 * to move into one group at once, each with their team — the Unit Dashboard's *Grup informal* sheet sends the ABs ticked
 * there.
 */
export class AddGroupMembersDto {
  @ApiProperty({
    type: [String], minItems: 1, maxItems: UNIT_DASHBOARD.MAX_TAGGED_PER_ADD,
    description: 'The **memberships** to move, each an active AB of this KPM. One that is not active here (`404`) or not an '
      + 'AB (`422 ORG_GROUP_AB_ONLY`), and nothing is written.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(UNIT_DASHBOARD.MAX_TAGGED_PER_ADD)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  membershipIds!: string[];
}

/** What the add answers: the group, how many ABs it moved now, and its people today. */
export class GroupMembersAddedDto implements GroupMembersAdded {
  @ApiProperty() groupId!: string;
  @ApiProperty({ example: 'Top Producers 2026' }) name!: string;
  @ApiProperty({ description: 'ABs moved by this request: one already in the group is not counted again.' })
  added!: number;
  @ApiProperty({ description: 'The group’s people now: every AB group in it, test accounts not counted.' }) memberCount!: number;
}
