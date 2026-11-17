import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsMongoId, IsOptional, IsString, MaxLength, ValidateIf,
} from 'class-validator';
import { CORE_LEADERS } from '@/domain/constants';
import type {
  CoreLeaderGroup, CoreLeaderRow, CoreLeadersView, CoreLeaderTargets,
} from './core-leaders.service';

/** One leader's *Simpan* on *Core leaders & groups* (P19.13-T3; ADR-0253 §1, §2). */
export class SaveCoreLeaderDto {
  @ApiProperty({
    type: String, nullable: true,
    description: 'Their one group, a live group of this office — or `null`, *Tanpa group*. Replaces every group they had.',
  })
  @ValidateIf((dto: SaveCoreLeaderDto) => dto.groupId !== null)
  @IsMongoId()
  groupId!: string | null;

  @ApiProperty({
    description: 'They are the group’s ★ group leader: appointing moves the star from whoever held it; `false` clears it if '
      + 'it was theirs. `true` with no group is `400 ORG_GROUP_LEADER_NEEDS_GROUP`.',
  })
  @IsBoolean()
  isGroupLeader!: boolean;

  @ApiProperty({ description: 'The Core leader tag (ADR-0159); a change to it needs `member:tag_core_leader`.' })
  @IsBoolean()
  isCoreLeader!: boolean;
}

/** *Atur group*, *Masukkan ke GROUP* and *★ Jadikan core*: many leaders in one request (ADR-0253 §6). */
export class CoreLeadersBulkDto {
  @ApiProperty({
    type: [String], minItems: 1, maxItems: CORE_LEADERS.MAX_PER_BULK,
    description: 'The leaders, each an active AB or AAB of this office. One that is not, and nothing is written (`404`).',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CORE_LEADERS.MAX_PER_BULK)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  membershipIds!: string[];

  @ApiPropertyOptional({
    type: String, nullable: true,
    description: 'A live group of this office for every one of them, or `null` for *Tanpa group*; absent leaves their groups.',
  })
  @IsOptional()
  @IsMongoId()
  groupId?: string | null;

  @ApiPropertyOptional({ description: 'The Core leader tag for every one of them; absent leaves it. One of the two is required.' })
  @IsOptional()
  @IsBoolean()
  isCoreLeader?: boolean;
}

class CoreLeaderTargetsDto implements CoreLeaderTargets {
  @ApiProperty({ example: 3 }) aa!: number;
  @ApiProperty({ example: 6 }) rec!: number;
  @ApiProperty({ description: 'Nothing set for this leader this year: the template’s defaults.' }) isDefault!: boolean;
}

class CoreLeaderRowDto implements CoreLeaderRow {
  @ApiProperty() membershipId!: string;
  @ApiProperty({ example: 'Agus Prasetyo' }) name!: string;
  @ApiProperty({ type: String, nullable: true }) agentCode!: string | null;
  @ApiProperty({ enum: ['ab', 'aab'] }) role!: 'ab' | 'aab';
  @ApiProperty({ type: String, nullable: true, description: 'Their one live group, or `null`: *Tanpa group*.' }) groupId!: string | null;
  @ApiProperty() isGroupLeader!: boolean;
  @ApiProperty() isCoreLeader!: boolean;
  @ApiProperty({ type: CoreLeaderTargetsDto, nullable: true, description: '`null` while *Perbaikan sub-group* is off in the template.' })
  targets!: CoreLeaderTargetsDto | null;
}

class CoreLeaderGroupDto implements CoreLeaderGroup {
  @ApiProperty() groupId!: string;
  @ApiProperty({ example: 'TOP PRODUCERS 2026' }) name!: string;
  @ApiProperty({ type: String, nullable: true, description: 'The ★ group leader, or `null`: *Belum ada group leader*.' })
  headMembershipId!: string | null;
  @ApiProperty({ type: String, nullable: true }) headName!: string | null;
  @ApiProperty({ description: 'The leaders who read in this group.' }) leaders!: number;
}

class CoreLeaderCountsDto {
  @ApiProperty() leaders!: number;
  @ApiProperty({ description: '*Core leader*' }) core!: number;
  @ApiProperty({ description: '*Punya group*' }) withGroup!: number;
  @ApiProperty({ description: '*Tanpa group*' }) withoutGroup!: number;
}

/** **`GET /members/core-leaders`**, and what every write of the page answers. */
export class CoreLeadersViewDto implements CoreLeadersView {
  @ApiProperty({ example: '2026' }) year!: string;
  @ApiProperty({ type: [CoreLeaderRowDto] }) leaders!: CoreLeaderRowDto[];
  @ApiProperty({ type: [CoreLeaderGroupDto] }) groups!: CoreLeaderGroupDto[];
  @ApiProperty({ type: CoreLeaderCountsDto }) counts!: CoreLeaderCountsDto;
  @ApiProperty({ description: 'The tags and the groups may be written: never in a view-as session.' }) canWrite!: boolean;
  @ApiProperty({ description: 'The targets may be written: `advanced_analytics:write`, with *Perbaikan sub-group* on.' })
  canEditTargets!: boolean;
}
