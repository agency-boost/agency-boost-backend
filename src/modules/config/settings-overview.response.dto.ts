import { ApiProperty } from '@nestjs/swagger';
import { PUBLISHED_SETTINGS, type PublishedSetting } from './publish-settings';
import {
  HUB_SETTINGS, type HubCounts, type HubSetting, type HubSettingView, type SettingsOverview,
} from './settings-overview.service';

/** A row's status (P19.21-T2 AC-2): only when the owner must act. */
export class HubStatusDto {
  @ApiProperty({ enum: ['unpublished', 'waiting', 'missing', 'no_logo'] })
  kind!: 'unpublished' | 'waiting' | 'missing' | 'no_logo';

  @ApiProperty({ type: Number, required: false, description: '`waiting` and `missing` only: how many.' })
  count?: number;
}

/** What a row's line counts; `null` on every setting that does not show it. */
export class HubCountsDto implements HubCounts {
  @ApiProperty({ type: Number, nullable: true }) activities!: number | null;
  @ApiProperty({ type: Number, nullable: true }) categories!: number | null;
  @ApiProperty({ type: Number, nullable: true }) skills!: number | null;
  @ApiProperty({ type: Number, nullable: true }) modules!: number | null;
  @ApiProperty({ type: Number, nullable: true }) windowDays!: number | null;
  @ApiProperty({ type: Number, nullable: true, description: 'The checklist version new hires are given.' }) version!: number | null;
  @ApiProperty({ type: Number, nullable: true }) stages!: number | null;
  @ApiProperty({ type: Number, nullable: true }) skillGroups!: number | null;
  @ApiProperty({ type: Number, nullable: true }) products!: number | null;
  @ApiProperty({ type: Number, nullable: true }) sold!: number | null;
  @ApiProperty({ type: Number, nullable: true }) materials!: number | null;
  @ApiProperty({ type: String, nullable: true }) kpmCode!: string | null;
  @ApiProperty({ type: Number, nullable: true, description: '1–12.' }) fiscalYearStartMonth!: number | null;
}

export class HubSettingDto implements HubSettingView {
  @ApiProperty({ enum: HUB_SETTINGS }) setting!: HubSetting;
  @ApiProperty({ type: () => HubStatusDto, nullable: true }) status!: HubSettingView['status'];
  @ApiProperty({ type: () => HubCountsDto }) counts!: HubCountsDto;
}

/** `GET /kpm/settings/overview` (P19.21-T2). */
export class SettingsOverviewDto implements SettingsOverview {
  @ApiProperty({ type: () => HubSettingDto, isArray: true }) settings!: HubSettingDto[];
  @ApiProperty({ enum: PUBLISHED_SETTINGS, isArray: true }) unpublished!: PublishedSetting[];
}
