import { ApiProperty } from '@nestjs/swagger';

/** *Tampilan bawaan*: the look every KPM has until it sets its own (*Tampilan KPM*, ADR-0218). Shown, not changed here. */
export class PlatformDefaultLookDto {
  @ApiProperty({ type: String, example: 'AgencyBoost', description: 'The app’s own name, every KPM’s until it sets one.' })
  systemName!: string;

  @ApiProperty({ type: Boolean, example: false, description: 'Whether the console may change it: not in v1 (OD-426).' })
  editable!: boolean;
}

/** **`GET` and `PUT /admin/platform/settings`** (P19.23-T6 AC-3). */
export class PlatformSettingsDto {
  @ApiProperty({ type: String, nullable: true, example: '+628112000300' })
  whatsappNumber!: string | null;

  @ApiProperty({
    enum: ['set', 'not_set'],
    description:
      '*Kunci AI untuk membaca file*: whether `ANTHROPIC_API_KEY` is set in this deployment’s environment. **The key is '
      + 'never stored, returned or logged** (ADR-0262 §4, OD-358); this is its state alone.',
  })
  aiReadingKey!: 'set' | 'not_set';

  @ApiProperty({ type: () => PlatformDefaultLookDto })
  defaultLook!: PlatformDefaultLookDto;

  @ApiProperty({ type: String, format: 'date-time', nullable: true, description: 'When it was last saved; null never.' })
  updatedAt!: string | null;
}
