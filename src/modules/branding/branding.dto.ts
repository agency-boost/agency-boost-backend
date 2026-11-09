import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Matches, MaxLength, Min, ValidateIf } from 'class-validator';
import { BRANDING, HEX_COLOUR, type BrandingUploadKind } from '@/domain/constants/branding';

const KINDS = BRANDING.UPLOAD_KINDS as unknown as string[];
const ALL_TYPES = [...new Set(Object.values(BRANDING.MIME_TYPES).flat())] as string[];

/** *Tampilan KPM*, first step of a picture: what the browser is about to upload (ADR-0218 §2). */
export class RequestBrandingUploadDto {
  @ApiProperty({ enum: KINDS, description: '`logo` (PNG, JPEG or SVG), `logo_square` (PNG) or `mascot` (PNG with transparency).' })
  @IsIn(KINDS)
  kind!: BrandingUploadKind;

  @ApiProperty({ example: 'logo.png' })
  @IsString() @MaxLength(200)
  filename!: string;

  @ApiProperty({ enum: ALL_TYPES, description: 'Checked against the kind’s own list here, and again on the stored bytes.' })
  @IsString() @MaxLength(100)
  mimeType!: string;

  @ApiProperty({ example: 48_211, description: 'At most 1 MB (`BRANDING.IMAGE_MAX_BYTES`), checked here and at confirm.' })
  @IsInt() @Min(1)
  bytes!: number;
}

/** *Tampilan KPM*, second step: the key storage holds the original under, from the signed form. */
export class ConfirmBrandingUploadDto {
  @ApiProperty({ enum: KINDS })
  @IsIn(KINDS)
  kind!: BrandingUploadKind;

  @ApiProperty({ example: 'dev/66f0…/branding/originals/01JB…' })
  @IsString() @MaxLength(300)
  storageKey!: string;

  @ApiPropertyOptional({ description: 'The type the browser sent; an SVG is known by its claim and its `<svg` (ADR-0217 §2).' })
  @IsOptional() @IsString() @MaxLength(100)
  mimeType?: string;
}

/** `POST /kpm/settings/branding/preview`: two colours, `#rrggbb`. */
export class BrandingPreviewDto {
  @ApiProperty({ example: '#0a6e5c' })
  @Matches(HEX_COLOUR)
  primary!: string;

  @ApiProperty({ example: '#f2c14e' })
  @Matches(HEX_COLOUR)
  secondary!: string;
}

/**
 * ***Simpan*** (`PUT /kpm/settings/branding`): the three groups, each whole or `null`, and the version read. Images are
 * named by the `storageKey` their confirm answered.
 */
export class SaveBrandingDto {
  @ApiPropertyOptional({ nullable: true, description: '`{ key }`: the wide logo’s folder. Its size is read from storage.' })
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsObject()
  logo?: { key: string } | null;

  @ApiPropertyOptional({ nullable: true, description: '`{ key }`: the square logo’s folder; only with a wide logo.' })
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsObject()
  logoSquare?: { key: string } | null;

  @ApiPropertyOptional({ nullable: true, example: '#0a6e5c', description: '*Warna utama*; with `secondary`, or both `null`.' })
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Matches(HEX_COLOUR)
  primary?: string | null;

  @ApiPropertyOptional({ nullable: true, example: '#1b2b4b', description: '*Warna kedua*.' })
  @IsOptional() @ValidateIf((_o, v) => v !== null) @Matches(HEX_COLOUR)
  secondary?: string | null;

  @ApiPropertyOptional({ nullable: true, description: '`{ default, poses: { thinking?, celebrating?, pointing?, phone? } }`, each a folder.' })
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsObject()
  mascot?: { default: string; poses?: Record<string, string> } | null;

  @ApiProperty({ example: 0, description: 'The version `GET` answered (0 with no own branding). A stale one is `409 VERSION_CONFLICT`.' })
  @IsInt() @Min(0)
  expectedVersion!: number;
}

/** *Kembalikan ke default*. */
export class ResetBrandingDto {
  @ApiProperty({ example: 3 })
  @IsInt() @Min(0)
  expectedVersion!: number;
}
