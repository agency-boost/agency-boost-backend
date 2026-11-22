import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsMongoId, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { INFORMAL_GROUPS } from '@/domain/constants';
import type {
  InformalGroupAb, InformalGroupCounts, InformalGroupCreated, InformalGroupRow, InformalGroupsView,
} from './group.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** ***Group baru*** (P19.17-T4; ADR-0270 §2): a name only — no Group Leader — and, from an AB's picker, that AB. */
export class CreateGroupDto {
  @ApiProperty({ example: 'Rising Stars 2027', maxLength: INFORMAL_GROUPS.NAME_MAX })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(INFORMAL_GROUPS.NAME_MAX)
  name!: string;

  @ApiPropertyOptional({
    type: String, nullable: true,
    description: 'The AB whose picker made it — *"… dan timnya masuk ke group ini"*: moved into it at once, their team with '
      + 'them. An active AB of this KPM; an AAB or an agent `422 ORG_GROUP_AB_ONLY`, anybody else `404`.',
  })
  @IsOptional()
  @IsMongoId()
  abMembershipId?: string | null;
}

/** ***Ubah nama***: the group's new name. The ABs carry its id, so they follow. */
export class RenameGroupDto {
  @ApiProperty({ example: 'Top Producers 2027', maxLength: INFORMAL_GROUPS.NAME_MAX })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(INFORMAL_GROUPS.NAME_MAX)
  name!: string;
}

/** **An AB's group** — the group chip and the *Group* dialog: a live group, or `null` for *Tanpa group*. */
export class SetAbGroupDto {
  @ApiProperty({
    type: String, nullable: true,
    description: 'A live group of this KPM (`404` otherwise), or `null`: *Tanpa group*. The AB’s whole team follows.',
  })
  @ValidateIf((dto: SetAbGroupDto) => dto.groupId !== null)
  @IsMongoId()
  groupId!: string | null;
}

class InformalGroupCountsDto implements InformalGroupCounts {
  @ApiProperty({ description: 'ABs and AABs among its people: *n leader*.' }) leaders!: number;
  @ApiProperty({ description: 'Its people, test accounts not counted: *n orang*.' }) people!: number;
  @ApiProperty({ description: 'The ABs that carry it: *n AB group*.' }) abGroups!: number;
}

class InformalGroupAbDto implements InformalGroupAb {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Agus Prasetyo' }) name!: string;
  @ApiProperty({ type: String, nullable: true }) agentCode!: string | null;
  @ApiProperty({ description: 'One of the group’s Group Leaders. Always false in *Tanpa group*.' }) isGroupLeader!: boolean;
  @ApiProperty({ description: 'The ★ core leader tag.' }) isCoreLeader!: boolean;
  @ApiProperty({ description: 'Their AB group, them included: *n orang di grupnya*.' }) people!: number;
  @ApiProperty({ description: 'ABs and AABs in their AB group, them included.' }) leaders!: number;
}

class GroupLeaderDto {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Wilson Tanoto' }) name!: string;
}

class InformalGroupRowDto implements InformalGroupRow {
  @ApiProperty() groupId!: string;
  @ApiProperty({ example: 'Top Producers 2026' }) name!: string;
  @ApiProperty({ type: [GroupLeaderDto], description: 'The Group Leaders while they hold, A to Z; any number, ABs only.' })
  leaders!: GroupLeaderDto[];
  @ApiProperty({ type: [InformalGroupAbDto], description: 'Its ABs, A to Z: each heads an AB group.' }) abs!: InformalGroupAbDto[];
  @ApiProperty({ type: InformalGroupCountsDto }) counts!: InformalGroupCountsDto;
}

class UngroupedDto {
  @ApiProperty({ type: [InformalGroupAbDto] }) abs!: InformalGroupAbDto[];
  @ApiProperty({ type: InformalGroupCountsDto }) counts!: InformalGroupCountsDto;
}

/** **`GET /members/groups`, and what every group write answers** (ADR-0270). */
export class InformalGroupsViewDto implements InformalGroupsView {
  @ApiProperty({ type: [InformalGroupRowDto], description: 'The live groups, A to Z.' }) groups!: InformalGroupRowDto[];
  @ApiProperty({ type: UngroupedDto, description: '*Tanpa group*: the ABs with no group.' }) ungrouped!: UngroupedDto;
  @ApiProperty({ description: 'Active members under no active AB: in the KPM’s total, in no AB group.' }) unplaced!: number;
  @ApiProperty({ description: 'The groups may be written: never in a view-as session.' }) canWrite!: boolean;
}

/** **`POST /members/groups`** — the group made, and the groups as they now stand. */
export class InformalGroupCreatedDto implements InformalGroupCreated {
  @ApiProperty() groupId!: string;
  @ApiProperty({ type: InformalGroupsViewDto }) view!: InformalGroupsViewDto;
}
