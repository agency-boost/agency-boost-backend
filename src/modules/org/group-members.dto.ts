import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, MaxLength } from 'class-validator';
import { UNIT_DASHBOARD } from '@/domain/constants';
import type { GroupMembersAdded } from './group.service';

/**
 * ***+ Tambah ke grup*** (the client's message of 11 November 2026, item 7; ADR-0249 §4): the people to tag into one
 * group at once — the Unit Dashboard's *Grup informal* sheet sends the ABs ticked there.
 */
export class AddGroupMembersDto {
  @ApiProperty({
    type: [String], minItems: 1, maxItems: UNIT_DASHBOARD.MAX_TAGGED_PER_ADD,
    description: 'The **memberships** to tag, each an active member of this agency. One that is not, and nothing is written.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(UNIT_DASHBOARD.MAX_TAGGED_PER_ADD)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  membershipIds!: string[];
}

/** What the add answers: the group, how many it tagged now, and its members today. */
export class GroupMembersAddedDto implements GroupMembersAdded {
  @ApiProperty() groupId!: string;
  @ApiProperty({ example: 'Top Producers 2026' }) name!: string;
  @ApiProperty({ description: 'People tagged by this request: somebody already in the group is not counted again.' })
  added!: number;
  @ApiProperty({ description: 'The group’s active members now.' }) memberCount!: number;
}
