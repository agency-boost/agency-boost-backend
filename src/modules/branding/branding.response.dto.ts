import { ApiProperty } from '@nestjs/swagger';
import type { BrandingPalette, LessonColours } from '@/domain/branding/palette';

/**
 * **A KPM's palette** (ADR-0218 §6): every token its two colours paint, `#rrggbb` lower-cased, derived by
 * `domain/branding/palette.ts` and set on `<html>` by the shell under the names `lib/branding.ts` maps.
 */
export class BrandingPaletteDto implements BrandingPalette {
  @ApiProperty() primary!: string;
  @ApiProperty() primaryHover!: string;
  @ApiProperty({ description: 'White or #1b2b4b: the words on the primary, at least 4.5:1.' }) primaryContrast!: string;
  @ApiProperty({ description: 'The primary darkened until it reads 4.5:1 on white.' }) primaryInk!: string;
  @ApiProperty() primaryDeep!: string;
  @ApiProperty() primaryOnSecondary!: string;
  @ApiProperty() primary50!: string;
  @ApiProperty() primary100!: string;
  @ApiProperty() focusRing!: string;
  @ApiProperty() secondary!: string;
  @ApiProperty() secondaryHover!: string;
  @ApiProperty() secondaryContrast!: string;
  @ApiProperty() secondaryInk!: string;
  @ApiProperty() secondaryMuted!: string;
  @ApiProperty() secondary50!: string;
  @ApiProperty() secondary100!: string;
  @ApiProperty() today!: string;
  @ApiProperty() todayInk!: string;
  @ApiProperty() sidebarText!: string;
}

export class LogoSizeDto {
  @ApiProperty() width!: number;
  @ApiProperty() height!: number;
}

/** A lesson's colours (ADR-0217 §5): six hex digits, no `#`; `ink` only where white reads 4.5:1 on the secondary. */
export class LessonColoursDto implements LessonColours {
  @ApiProperty() accent!: string;
  @ApiProperty() accentSoft!: string;
  @ApiProperty({ required: false }) ink?: string;
}

/** `GET /auth/me`'s `branding` (ADR-0218 §8). */
export class SessionBrandingDto {
  @ApiProperty() kpmId!: string;
  @ApiProperty({ description: 'Changes whenever what the KPM shows changes: the `v` of every file address.' }) version!: string;
  @ApiProperty({ type: () => BrandingPaletteDto, nullable: true, description: '`null`: AgencyBoost’s colours.' }) palette!: BrandingPaletteDto | null;
  @ApiProperty({ type: () => LogoSizeDto, nullable: true }) logo!: LogoSizeDto | null;
  @ApiProperty() logoSquare!: boolean;
  @ApiProperty() icons!: boolean;
  @ApiProperty({ type: String, isArray: true }) mascotPoses!: string[];
  @ApiProperty({ type: () => LessonColoursDto, nullable: true }) lesson!: LessonColoursDto | null;
}

/** `GET /kpm-branding/:kpmId`, and an invitation's `branding` (ADR-0218 §9). */
export class PublicBrandingDto {
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: String, nullable: true }) version!: string | null;
  @ApiProperty({ type: () => BrandingPaletteDto, nullable: true }) palette!: BrandingPaletteDto | null;
  @ApiProperty({ type: () => LogoSizeDto, nullable: true }) logo!: LogoSizeDto | null;
}

export class InviteBrandingDto extends PublicBrandingDto {
  @ApiProperty() kpmId!: string;
  declare name: string;
  declare version: string;
}

/** An image as the settings page previews it: its folder, and a 300-second link to the size it draws. */
export class BrandingImageDto {
  @ApiProperty() key!: string;
  @ApiProperty() url!: string;
}

export class BrandingLogoViewDto extends BrandingImageDto {
  @ApiProperty() width!: number;
  @ApiProperty() height!: number;
}

export class BrandingMascotViewDto {
  @ApiProperty({ type: () => BrandingImageDto }) default!: BrandingImageDto;
  @ApiProperty({ description: '`thinking`, `celebrating`, `pointing`, `phone`: each one set, as an image.', type: Object })
  poses!: Record<string, BrandingImageDto>;
}

/** The KPM's own branding, or its template's, as the page draws it. */
export class BrandingViewDto {
  @ApiProperty({ type: () => BrandingLogoViewDto, nullable: true }) logo!: BrandingLogoViewDto | null;
  @ApiProperty({ type: () => BrandingImageDto, nullable: true }) logoSquare!: BrandingImageDto | null;
  @ApiProperty({ type: String, nullable: true }) primary!: string | null;
  @ApiProperty({ type: String, nullable: true }) secondary!: string | null;
  @ApiProperty({ type: () => BrandingMascotViewDto, nullable: true }) mascot!: BrandingMascotViewDto | null;
}

export class BrandingSourceDto {
  @ApiProperty({ type: String, nullable: true, enum: ['own', 'template'] }) logos!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: ['own', 'template'] }) colours!: string | null;
  @ApiProperty({ type: String, nullable: true, enum: ['own', 'template'] }) mascot!: string | null;
}

export class ShownBrandingDto extends SessionBrandingDto {
  @ApiProperty({ type: () => BrandingSourceDto, description: 'Where each group comes from; `null`: AgencyBoost’s.' })
  source!: BrandingSourceDto;
}

/** `GET /kpm/settings/branding` and every write's answer. */
export class BrandingSettingsDto {
  @ApiProperty({ type: () => BrandingViewDto, nullable: true }) own!: BrandingViewDto | null;
  @ApiProperty({ type: () => BrandingViewDto, nullable: true, description: 'The template’s *Tampilan*, when it sets anything.' })
  template!: BrandingViewDto | null;
  @ApiProperty({ type: () => ShownBrandingDto }) shown!: ShownBrandingDto;
  @ApiProperty({ description: 'The own row’s version, 0 with none: `expectedVersion` for *Simpan* and the reset.' }) version!: number;
  @ApiProperty({ description: 'The Owner and the Admins, never in a view-as session.' }) canWrite!: boolean;
}

export class ContrastResultDto {
  @ApiProperty({ enum: ['light', 'dark'] }) contrast!: 'light' | 'dark';
  @ApiProperty() ratio!: number;
}

/** `POST /kpm/settings/branding/preview`. */
export class BrandingPreviewAnswerDto {
  @ApiProperty({ type: () => BrandingPaletteDto }) palette!: BrandingPaletteDto;
  @ApiProperty({ type: () => ContrastResultDto }) primary!: ContrastResultDto;
  @ApiProperty({ type: () => ContrastResultDto }) secondary!: ContrastResultDto;
}

/** A confirmed picture: the folder of its sizes, which *Simpan* names. */
export class ConfirmedBrandingImageDto {
  @ApiProperty() storageKey!: string;
  @ApiProperty() width!: number;
  @ApiProperty() height!: number;
  @ApiProperty({ type: Object, description: 'The size the page draws, by file name, as a 300-second link.' })
  previews!: Record<string, string>;
}
