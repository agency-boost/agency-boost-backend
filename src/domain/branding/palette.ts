import { BRANDING, HEX_COLOUR } from '@/domain/constants/branding';

/**
 * **The one function that derives a KPM's palette** (P19.6-T1 AC-5, AC-7; ADR-0218 §5, §6). From the two colours a KPM
 * picks, every shade the app paints: the contrast words on each, the hovers, the inks, the tints, the focus ring. The
 * contrast rule lives here and nowhere else — the settings page's preview asks the API, the session carries what this
 * returns, the proposal's PDF and the lessons read it too.
 */

type Rgb = readonly [number, number, number];

const toRgb = (hex: string): Rgb => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = ([r, g, b]: Rgb): string =>
  `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;

/** `#rrggbb`, lower-cased; `null` for anything else. */
export function normaliseHex(value: unknown): string | null {
  return typeof value === 'string' && HEX_COLOUR.test(value) ? value.toLowerCase() : null;
}

/** WCAG 2.1's relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1's contrast ratio of two colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `a` moved toward `b` by `t` (0 to 1), channel by channel. */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [toRgb(a), toRgb(b)];
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as unknown as Rgb);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export type ContrastSide = 'light' | 'dark';

/** The words on a colour: white or the dark ink, whichever reads higher, and its ratio. */
export interface ContrastChoice {
  contrast: ContrastSide;
  /** The colour of those words. */
  colour: string;
  /** Its ratio on the colour, to two decimals. */
  ratio: number;
  /** Whether it reaches `CONTRAST_MIN`. A colour where it does not is refused. */
  readable: boolean;
}

/** **The contrast rule** (acceptance 2): white and `#1B2B4B` are measured on the colour, and the higher ratio wins. */
export function textOn(hex: string): ContrastChoice {
  const light = contrastRatio(hex, BRANDING.TEXT_LIGHT);
  const dark = contrastRatio(hex, BRANDING.TEXT_DARK);
  const contrast: ContrastSide = light >= dark ? 'light' : 'dark';
  const ratio = Math.max(light, dark);
  return {
    contrast,
    colour: contrast === 'light' ? BRANDING.TEXT_LIGHT : BRANDING.TEXT_DARK,
    ratio: round2(ratio),
    readable: ratio >= BRANDING.CONTRAST_MIN,
  };
}

/** The colour as words on white: moved toward black by `INK_STEP` until it reads `CONTRAST_MIN` there. */
export function inkOf(hex: string): string {
  let ink = hex.toLowerCase();
  for (let i = 0; i < 400 && contrastRatio(ink, BRANDING.TEXT_LIGHT) < BRANDING.CONTRAST_MIN; i += 1) {
    ink = mix(ink, '#000000', BRANDING.INK_STEP);
  }
  return ink;
}

/** A hover: `HOVER_SHIFT` away from its words — darker under white words, lighter under dark ones. */
export function hoverOf(hex: string, side: ContrastSide): string {
  return mix(hex, side === 'light' ? '#000000' : '#ffffff', BRANDING.HOVER_SHIFT);
}

/** The colour at `t` over white. */
export const tintOf = (hex: string, t: number): string => mix('#ffffff', hex, t);

/**
 * **A KPM's palette**: every token of ADR-0218 §6 for its two colours, `#rrggbb` lower-cased. The frontend sets each on
 * `<html>` under the name `lib/branding.ts` maps it to, from a fixed list, and nothing else.
 */
export interface BrandingPalette {
  primary: string;
  primaryHover: string;
  primaryContrast: string;
  primaryInk: string;
  /** The primary as a number on its own tint: its ink. */
  primaryDeep: string;
  /** The primary as a word on the secondary: itself where it reads 4.5:1 there, else the secondary's words. */
  primaryOnSecondary: string;
  primary50: string;
  primary100: string;
  focusRing: string;
  secondary: string;
  secondaryHover: string;
  secondaryContrast: string;
  secondaryInk: string;
  /** A quieter word on the secondary: its words, which are known to read. */
  secondaryMuted: string;
  secondary50: string;
  secondary100: string;
  /** *Today*'s shade and its words, which take the primary's tint and ink for a KPM (ADR-0218 §6). */
  today: string;
  todayInk: string;
  /** The sidebar's words, on the secondary. */
  sidebarText: string;
}

/** What the preview and a save answer: the palette, or the field whose colour no text reads on. */
export type PaletteResult =
  | { ok: true; palette: BrandingPalette; primary: ContrastChoice; secondary: ContrastChoice }
  | { ok: false; field: 'primary' | 'secondary'; primary: ContrastChoice; secondary: ContrastChoice };

/** **The palette of two colours**, or which of them is refused. Both must be `#rrggbb`. */
export function derivePalette(primaryHex: string, secondaryHex: string): PaletteResult {
  const primary = primaryHex.toLowerCase();
  const secondary = secondaryHex.toLowerCase();
  const onPrimary = textOn(primary);
  const onSecondary = textOn(secondary);
  if (!onPrimary.readable) return { ok: false, field: 'primary', primary: onPrimary, secondary: onSecondary };
  if (!onSecondary.readable) return { ok: false, field: 'secondary', primary: onPrimary, secondary: onSecondary };
  const primaryInk = inkOf(primary);
  const primary100 = tintOf(primary, BRANDING.TINT_100);
  return {
    ok: true,
    primary: onPrimary,
    secondary: onSecondary,
    palette: {
      primary,
      primaryHover: hoverOf(primary, onPrimary.contrast),
      primaryContrast: onPrimary.colour,
      primaryInk,
      primaryDeep: primaryInk,
      primaryOnSecondary: contrastRatio(primary, secondary) >= BRANDING.CONTRAST_MIN ? primary : onSecondary.colour,
      primary50: tintOf(primary, BRANDING.TINT_50),
      primary100,
      focusRing: contrastRatio(primary, BRANDING.TEXT_LIGHT) >= BRANDING.FOCUS_RING_MIN ? primary : primaryInk,
      secondary,
      secondaryHover: hoverOf(secondary, onSecondary.contrast),
      secondaryContrast: onSecondary.colour,
      secondaryInk: inkOf(secondary),
      secondaryMuted: onSecondary.colour,
      secondary50: tintOf(secondary, BRANDING.TINT_50),
      secondary100: tintOf(secondary, BRANDING.TINT_100),
      today: primary100,
      todayInk: primaryInk,
      sidebarText: onSecondary.colour,
    },
  };
}

/**
 * **A lesson's colours** (P19.6-T2/T3, ADR-0217 §5; OD-269): what an embedded lesson takes in its link's fragment —
 * its accent the primary's ink, its soft accent the primary's lightest tint, and its headings the secondary **only
 * where white reads 4.5:1 on it** (the lesson writes white on its ink). Six lower-case hex digits, no `#`. `null`
 * without a palette: the lesson keeps its own colours.
 */
export interface LessonColours {
  accent: string;
  accentSoft: string;
  ink?: string;
}

export function lessonColoursOf(palette: BrandingPalette | null): LessonColours | null {
  if (!palette) return null;
  const bare = (hex: string) => hex.slice(1).toLowerCase();
  const ink = contrastRatio(palette.secondary, BRANDING.TEXT_LIGHT) >= BRANDING.CONTRAST_MIN ? bare(palette.secondary) : null;
  return { accent: bare(palette.primaryInk), accentSoft: bare(palette.primary50), ...(ink ? { ink } : {}) };
}
