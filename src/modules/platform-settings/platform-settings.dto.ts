import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { field } from '@/common/validation/violations';
import { PLATFORM_SETTINGS_REFUSALS } from './platform-settings.messages';

/**
 * **`PUT /admin/platform/settings`** (P19.23-T6 AC-3): what *Simpan* sends — the WhatsApp number as typed, or `null` /
 * empty to clear it. The server reads it (`normalisePhone`) and refuses one that is not a number. Nothing else is
 * written here: the AI key is the environment's and the default look is shown, not saved (OD-426).
 */
export class UpdatePlatformSettingsDto {
  @ApiProperty({
    type: String, nullable: true, example: '0811 2000 300',
    description: '*Nomor WhatsApp pengirim*, as typed; stored as `+62` and its digits. Empty or null clears it.',
  })
  @IsOptional()
  @IsString({ message: field(PLATFORM_SETTINGS_REFUSALS.VALIDATION_FAILED.whatsapp) })
  @MaxLength(32, { message: field(PLATFORM_SETTINGS_REFUSALS.VALIDATION_FAILED.whatsapp) })
  whatsappNumber!: string | null;
}
