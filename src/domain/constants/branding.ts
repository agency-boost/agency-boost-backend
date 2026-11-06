/**
 * **A KPM's branding: its bounds and its rules** (P19.6-T1; ADR-0218 §2, §4, §5, §9; `metrics-and-definitions.md`,
 * *KPM branding*). The single source for every number the contrast rule, the palette and the images use — the palette
 * is derived from these by `domain/branding/palette.ts` alone, and the frontend reads what it derives, never these.
 */
export const BRANDING = Object.freeze({
  /** Text on a KPM's colour must read at least 4.5:1 (WCAG 2.1 AA), or the colour is refused (§5). */
  CONTRAST_MIN: 4.5,
  /** A focus ring must read 3:1 on white (WCAG 2.1 1.4.11); below it, the ring takes the primary's ink. */
  FOCUS_RING_MIN: 3,
  /** The two candidates for the words on a colour: white, and the dark ink every heading is written in. */
  TEXT_LIGHT: '#ffffff',
  TEXT_DARK: '#1b2b4b',
  /** The two tints: the colour at 8 % and 16 % over white. */
  TINT_50: 0.08,
  TINT_100: 0.16,
  /** A hover moves 12 % away from its contrast text, so its words only gain contrast. */
  HOVER_SHIFT: 0.12,
  /** The ink: the colour moved 2 % toward black, repeated until it reads `CONTRAST_MIN` on white. */
  INK_STEP: 0.02,
  /** Every upload, at most 1 MB (§B7's *Logo*, *Maskot*). */
  IMAGE_MAX_BYTES: 1024 * 1024,
  /** The wide logo is drawn inside 160 × 32 px, and kept at three times that (§2). */
  LOGO_BOX: Object.freeze({ width: 160, height: 32 }),
  LOGO_SCALE: 3,
  /** A raster wide logo at least 32 px high: anything smaller would be enlarged in the navbar. */
  LOGO_MIN_HEIGHT_PX: 32,
  /** The square logo: a square PNG of at least 512 × 512; kept at 512 × 512. */
  SQUARE_MIN_PX: 512,
  /** The mascot: its longer side at least 512 px; kept as WebP at three widths. */
  MASCOT_MIN_PX: 512,
  MASCOT_WIDTHS: Object.freeze([120, 240, 360] as const),
  /** The favicon (32, 48), the Apple touch icon (180) and the home-screen icons (192, 512). */
  ICON_SIZES: Object.freeze([32, 48, 180, 192, 512] as const),
  /** A maskable icon keeps its logo inside the centre 80 %. */
  MASKABLE_SAFE_ZONE: 0.8,
  /** The mascot's pictures: the default, and one optional picture per pose (§2). */
  MASCOT_POSES: Object.freeze(['default', 'thinking', 'celebrating', 'pointing', 'phone'] as const),
  /** What a page may upload (`POST …/branding/uploads`). */
  UPLOAD_KINDS: Object.freeze(['logo', 'logo_square', 'mascot'] as const),
  /** The types each upload accepts, checked at signing and again on the stored bytes. */
  MIME_TYPES: Object.freeze({
    logo: Object.freeze(['image/png', 'image/jpeg', 'image/svg+xml'] as const),
    logo_square: Object.freeze(['image/png'] as const),
    mascot: Object.freeze(['image/png'] as const),
  }),
  /** Forms an Owner or an Admin may ask for, per KPM, per hour: each may leave an object nobody uses (ADR-0153). */
  UPLOADS_PER_WINDOW: 30,
  UPLOAD_WINDOW_SECONDS: 3600,
  /** The public sign-in read, per address: 60 a minute (§9), then `429 AUTH_RATE_LIMITED`. */
  PUBLIC_READS_PER_WINDOW: 60,
  PUBLIC_READ_WINDOW_SECONDS: 60,
  /** A settings page's preview link of an image, as every signed read (ADR-0153): 300 seconds. */
  PREVIEW_TTL_SECONDS: 300,
  /** A file asked for with its current version is cached for a year; without it, five minutes (§4). */
  FILE_MAX_AGE_SECONDS: 31_536_000,
  FILE_UNVERSIONED_MAX_AGE_SECONDS: 300,
  /** The version's length: the first 12 hex digits of a SHA-1 over what the KPM shows. */
  VERSION_LENGTH: 12,
});

export type BrandingUploadKind = (typeof BRANDING.UPLOAD_KINDS)[number];
export type MascotPose = (typeof BRANDING.MASCOT_POSES)[number];

/**
 * **The files the public route serves** (ADR-0218 §4): sizes made from an upload, never the original. A name outside
 * this list is `404`.
 */
export const BRANDING_ICON_FILES = Object.freeze([
  'favicon-32.png', 'favicon-48.png', 'apple-touch-icon.png',
  'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png',
] as const);
export type BrandingIconFile = (typeof BRANDING_ICON_FILES)[number];

/** `mascot-<pose>-<width>.webp`, one per pose and width. */
export const BRANDING_MASCOT_FILE = /^mascot-(default|thinking|celebrating|pointing|phone)-(120|240|360)\.webp$/;

/** A colour as the API takes and keeps it: `#rrggbb`. */
export const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
