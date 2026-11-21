import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsOptional } from 'class-validator';
import { PUBLISHED_SETTINGS, type PublishedSetting } from './publish-settings';

/**
 * **`POST /kpm/settings/publish`'s body** (P19.21-T2 AC-3; ADR-0274 §5): the settings to publish. Absent or empty is
 * every setting — *Terbitkan semua*, and what every caller sent before per-setting publishing, which sent no body.
 */
export class PublishSettingsDto {
  @ApiPropertyOptional({
    enum: PUBLISHED_SETTINGS, isArray: true, example: ['activity_types'],
    description: 'Absent or `[]`: every setting with a draft. A setting named twice is published once.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PUBLISHED_SETTINGS.length * 2)
  @IsIn(PUBLISHED_SETTINGS as unknown as string[], { each: true })
  settings?: PublishedSetting[];
}
