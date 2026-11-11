import { BRANDING, HEX_COLOUR } from '@/domain/constants/branding';

/**
 * **The one function that derives a KPM's palette** (P19.6-T1 AC-5, AC-7; ADR-0218 §5, §6). From the two colours a KPM
 * picks, every shade the app paints: the contrast words on each, the hovers, the inks, the tints, the focus ring. The
 * contrast rule lives here and nowhere else — the settings page's preview asks the API, the session carries what this
 * returns, the proposal's PDF and the lessons read it too.
 *
 * **Every colour is accepted** (P19.12-T3; ADR-0246): one that neither white nor the dark ink reads `CONTRAST_MIN` on
 * is painted as its nearest shade where one does (`fillOf`), and the palette is derived from that shade.
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
  /** Whether it reaches `CONTRAST_MIN`. A colour where it does not is painted as its nearest shade where it does (`fillOf`). */
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

/** `hex` moved toward `toward` by `INK_STEP`, step by step, until `text` reads `CONTRAST_MIN` on it; and how many steps. */
function stepUntilRead(hex: string, toward: string, text: string): { colour: string; steps: number } {
  let colour = hex;
  let steps = 0;
  for (; steps < 400 && contrastRatio(colour, text) < BRANDING.CONTRAST_MIN; steps += 1) {
    colour = mix(colour, toward, BRANDING.INK_STEP);
  }
  return { colour, steps };
}

/** The colour as words on white: moved toward black by `INK_STEP` until it reads `CONTRAST_MIN` there. */
export function inkOf(hex: string): string {
  return stepUntilRead(hex.toLowerCase(), '#000000', BRANDING.TEXT_LIGHT).colour;
}

/**
 * **A colour as a filled surface carrying words** (P19.12-T3 AC-1, AC-2; ADR-0246 §1): the words the contrast rule
 * gives it, and the fill they sit on.
 */
export interface FilledColour {
  contrast: ContrastSide;
  /** The colour of the words. */
  colour: string;
  /** Their ratio on the fill, to two decimals: at least `CONTRAST_MIN`. */
  ratio: number;
  /** What a button, a pill or a card is filled with: the colour chosen, or its nearest shade the words read on. */
  fill: string;
  /** Whether `fill` is not the colour chosen. */
  adjusted: boolean;
}

/**
 * **The fill of a colour** (P19.12-T3; ADR-0246 §1). Where white or the dark ink already reads `CONTRAST_MIN` on it, the
 * colour itself — every colour the rule of ADR-0218 §5 accepted keeps its palette exactly. Otherwise it is moved by
 * `INK_STEP` toward black until white reads, and toward white until the dark ink reads, and **the side that needs fewer
 * steps** is taken — the nearest readable shade; on a tie the darker, with white words. No colour needs more than nine.
 */
export function fillOf(hex: string): FilledColour {
  const chosen = hex.toLowerCase();
  const on = textOn(chosen);
  if (on.readable) return { contrast: on.contrast, colour: on.colour, ratio: on.ratio, fill: chosen, adjusted: false };
  const darker = stepUntilRead(chosen, '#000000', BRANDING.TEXT_LIGHT);
  const lighter = stepUntilRead(chosen, '#ffffff', BRANDING.TEXT_DARK);
  const [fill, contrast, colour]: [string, ContrastSide, string] = darker.steps <= lighter.steps
    ? [darker.colour, 'light', BRANDING.TEXT_LIGHT]
    : [lighter.colour, 'dark', BRANDING.TEXT_DARK];
  return { contrast, colour, ratio: round2(contrastRatio(fill, colour)), fill, adjusted: true };
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

/** What the preview and a save answer: the palette, and each colour's words and fill. */
export interface PaletteResult {
  palette: BrandingPalette;
  primary: FilledColour;
  secondary: FilledColour;
}

/**
 * **The palette of two colours** — never a refusal (P19.12-T3 AC-1; ADR-0246 §1, §2). Both must be `#rrggbb`. Each is
 * taken as its fill (`fillOf`), and every token is derived from the fill: `primary` and `secondary` are what buttons,
 * pills and cards are filled with, so every word written on them reads.
 */
export function derivePalette(primaryHex: string, secondaryHex: string): PaletteResult {
  const onPrimary = fillOf(primaryHex);
  const onSecondary = fillOf(secondaryHex);
  const primary = onPrimary.fill;
  const secondary = onSecondary.fill;
  const primaryInk = inkOf(primary);
  const primary100 = tintOf(primary, BRANDING.TINT_100);
  return {
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
