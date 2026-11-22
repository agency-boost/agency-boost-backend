import { AGENCYBOOST_COLOURS } from '@/modules/branding/branding-reader';

/**
 * **The PDF's pictures, as vector art** (P19.14-T3 AC-5; ADR-0256 §5; the 11 Nov spec's *Category illustrations*).
 *
 * - **The five category illustrations** are `revisions/2026-11-13/files/proposal/mockups/illus-defs.svg`, copied path for
 *   path (the revision stays frozen). Each is the inside of a `0 0 200 150` box. The mockup's CSS variables are
 *   parameters here: `a` the main colour, `b` the second, `a1` and `a2` the main colour's tints, `b2` the second's — the
 *   mockup's one raw `#f6c693` (a coin's top) is the second colour at {@link COIN_TINT}. **So a picture is drawn in the
 *   KPM's two colours, their tints and white, and nothing else.**
 * - **The tile icons** are the mockups' `i-heart`, `i-shield`, `i-cap`, `i-grow` (`0 0 24 24`, a stroke in the main
 *   colour); *Keluarga* has none in the mockups, so `umbrella` is drawn in their idiom — a Fill.
 * - **AgencyBoost's 3-dot logo** is `logo-agencyboost.svg`, its navy and orange the tokens' (ADR-0218 §6), never raw.
 *
 * Small strings, a few hundred bytes each: the 512 MB container carries no picture file (`deployment-gcp.md` §14).
 */

/** The colours a picture is drawn in: the KPM's two and their tints. */
export interface ArtColours {
  a: string;
  b: string;
  a1: string;
  a2: string;
  b2: string;
}

/** The second colour's tint that stands for the mockup's `#f6c693` (orange at 55 % over white is `#f5c69d`). */
export const COIN_TINT = 0.55;

/** The category pictures, by the name the layout gives them. */
export type ArtKind = 'health' | 'critical' | 'family' | 'education' | 'growth';

const W = '#ffffff';

/** **Kesehatan**: a medical card with a cross, a stethoscope and a heart. */
const health = (c: ArtColours) => [
  `<circle cx="100" cy="78" r="66" fill="${c.a1}"/>`,
  `<circle cx="160" cy="28" r="6" fill="${c.b}" opacity=".5"/><circle cx="34" cy="120" r="4" fill="${c.b}" opacity=".6"/>`,
  `<rect x="58" y="34" width="84" height="96" rx="12" fill="${W}" stroke="${c.a}" stroke-width="3"/>`,
  `<rect x="78" y="26" width="44" height="16" rx="6" fill="${c.a}"/>`,
  `<rect x="89" y="52" width="22" height="50" rx="5" fill="${c.b}"/>`,
  `<rect x="75" y="66" width="50" height="22" rx="5" fill="${c.b}"/>`,
  `<rect x="72" y="112" width="56" height="6" rx="3" fill="${c.a2}"/>`,
  `<path d="M142 70c18 0 22 14 22 26s-8 22-20 22" fill="none" stroke="${c.a}" stroke-width="4" stroke-linecap="round"/>`,
  `<circle cx="142" cy="120" r="9" fill="${c.a}"/><circle cx="142" cy="120" r="4" fill="${W}"/>`,
  `<path d="M40 58c0-7 9-10 13-3 4-7 13-4 13 3 0 9-13 16-13 16s-13-7-13-16z" fill="${c.b}"/>`,
].join('');

/** **Penyakit kritis**: a shield with a heart and a pulse line. */
const critical = (c: ArtColours) => [
  `<circle cx="100" cy="78" r="66" fill="${c.a1}"/>`,
  `<circle cx="36" cy="40" r="5" fill="${c.b}" opacity=".6"/><circle cx="168" cy="118" r="7" fill="${c.b}" opacity=".45"/>`,
  `<path d="M100 18l52 18v38c0 32-22 56-52 68-30-12-52-36-52-68V36z" fill="${c.a}"/>`,
  `<path d="M100 30l40 14v30c0 25-17 44-40 54-23-10-40-29-40-54V44z" fill="${c.a2}" opacity=".35"/>`,
  `<path d="M76 70c0-12 15-17 24-7 9-10 24-5 24 7 0 16-24 30-24 30S76 86 76 70z" fill="${c.b}"/>`,
  `<path d="M62 82h22l7-14 10 26 8-16h29" fill="none" stroke="${W}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,
].join('');

/** **Jiwa / Warisan**: an umbrella over a family — and the picture of any category without one of its own. */
const family = (c: ArtColours) => [
  `<circle cx="100" cy="80" r="66" fill="${c.a1}"/>`,
  `<circle cx="30" cy="70" r="5" fill="${c.b}" opacity=".5"/><circle cx="172" cy="40" r="6" fill="${c.b}" opacity=".5"/>`,
  `<path d="M38 64c6-30 34-48 62-48s56 18 62 48c-8-6-18-6-26 0-8-6-20-6-28 0h-16c-8-6-20-6-28 0-8-6-18-6-26 0z" fill="${c.b}"/>`,
  `<path d="M100 16v4" fill="none" stroke="${c.a}" stroke-width="4" stroke-linecap="round"/>`,
  `<path d="M100 64v54c0 8-10 8-10 0" fill="none" stroke="${c.a}" stroke-width="4" stroke-linecap="round"/>`,
  `<circle cx="68" cy="86" r="10" fill="${c.a}"/><rect x="56" y="98" width="24" height="34" rx="10" fill="${c.a}"/>`,
  `<circle cx="132" cy="86" r="10" fill="${c.a}"/><rect x="120" y="98" width="24" height="34" rx="10" fill="${c.a}"/>`,
  `<circle cx="100" cy="100" r="8" fill="${c.b}"/><rect x="91" y="110" width="18" height="22" rx="8" fill="${c.b}"/>`,
  `<rect x="40" y="132" width="120" height="5" rx="2.5" fill="${c.a2}"/>`,
].join('');

/** **Pendidikan**: a graduation cap on books. */
const education = (c: ArtColours) => [
  `<circle cx="100" cy="80" r="66" fill="${c.a1}"/>`,
  `<circle cx="164" cy="34" r="5" fill="${c.b}" opacity=".6"/><circle cx="34" cy="116" r="6" fill="${c.b}" opacity=".45"/>`,
  `<rect x="52" y="106" width="96" height="16" rx="4" fill="${c.a}"/>`,
  `<rect x="58" y="90" width="88" height="16" rx="4" fill="${c.b}"/>`,
  `<rect x="50" y="74" width="92" height="16" rx="4" fill="${c.a2}" stroke="${c.a}" stroke-width="2"/>`,
  `<rect x="62" y="110" width="40" height="3" rx="1.5" fill="${W}" opacity=".6"/>`,
  `<path d="M100 22l58 22-58 22-58-22z" fill="${c.a}"/>`,
  `<path d="M72 54v14c8 8 48 8 56 0V54l-28 11z" fill="${c.a}"/>`,
  `<path d="M152 46v24" fill="none" stroke="${c.b}" stroke-width="3" stroke-linecap="round"/><circle cx="152" cy="73" r="5" fill="${c.b}"/>`,
  `<path d="M38 40l3 6 6 1-4 4 1 6-6-3-6 3 1-6-4-4 6-1z" fill="${c.b}"/>`,
].join('');

/** **Dana masa depan / pensiun**: a plant growing from coins, with a rising chart. */
const growth = (c: ArtColours) => [
  `<circle cx="100" cy="80" r="66" fill="${c.a1}"/>`,
  `<circle cx="34" cy="44" r="5" fill="${c.b}" opacity=".6"/>`,
  `<ellipse cx="70" cy="122" rx="22" ry="7" fill="${c.b}"/><rect x="48" y="108" width="44" height="14" fill="${c.b}"/><ellipse cx="70" cy="108" rx="22" ry="7" fill="${c.b2}"/>`,
  `<ellipse cx="70" cy="100" rx="22" ry="7" fill="${c.b}"/><rect x="48" y="90" width="44" height="10" fill="${c.b}"/><ellipse cx="70" cy="90" rx="22" ry="7" fill="${c.b2}"/>`,
  `<path d="M70 84V56" fill="none" stroke="${c.a}" stroke-width="4" stroke-linecap="round"/>`,
  `<path d="M70 66c-16 0-22-10-22-20 14 0 22 8 22 20z" fill="${c.a}"/>`,
  `<path d="M70 58c0-14 10-22 24-22 0 12-8 22-24 22z" fill="${c.a}"/>`,
  `<rect x="110" y="96" width="14" height="26" rx="3" fill="${c.a2}" stroke="${c.a}" stroke-width="2"/>`,
  `<rect x="130" y="80" width="14" height="42" rx="3" fill="${c.a2}" stroke="${c.a}" stroke-width="2"/>`,
  `<rect x="150" y="62" width="14" height="60" rx="3" fill="${c.a}"/>`,
  `<path d="M112 78l26-22 12 10 18-20" fill="none" stroke="${c.b}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,
  `<path d="M160 44h10v10" fill="none" stroke="${c.b}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`,
].join('');

const ART: Record<ArtKind, (c: ArtColours) => string> = { health, critical, family, education, growth };

/** A category picture's inside, for a `0 0 200 150` box, in these colours. */
export function artOf(kind: ArtKind, colours: ArtColours): string {
  return ART[kind](colours);
}

/** The tile icons: a need's glyph, a `0 0 24 24` box, stroked in one colour. */
export type IconKind = 'heart' | 'shield' | 'umbrella' | 'cap' | 'grow';

const ICONS: Record<IconKind, (s: string) => string> = {
  heart: (s) => `<path fill="none" stroke="${s}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>`
    + `<path fill="none" stroke="${s}" stroke-width="1.8" d="M8.5 11h2l1-2 1.5 4 1-2h1.5"/>`,
  shield: (s) => `<path fill="none" stroke="${s}" stroke-width="1.8" stroke-linejoin="round" d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>`
    + `<path fill="none" stroke="${s}" stroke-width="1.8" stroke-linecap="round" d="M9 12l2 2 4-4"/>`,
  // Ours, in the mockups' idiom: *Keluarga* has no icon there.
  umbrella: (s) => `<path fill="none" stroke="${s}" stroke-width="1.8" stroke-linejoin="round" d="M3 12a9 9 0 0 1 18 0z"/>`
    + `<path fill="none" stroke="${s}" stroke-width="1.8" stroke-linecap="round" d="M12 12v6a2 2 0 0 1-4 0"/>`,
  cap: (s) => `<path fill="none" stroke="${s}" stroke-width="1.8" stroke-linejoin="round" d="M2 9l10-5 10 5-10 5z"/>`
    + `<path fill="none" stroke="${s}" stroke-width="1.8" stroke-linecap="round" d="M6 11v5c2 2 10 2 12 0v-5M22 9v6"/>`,
  grow: (s) => `<path fill="none" stroke="${s}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M4 19h16M6 16v-3M10 16v-6M14 16V8M18 16V5"/>`,
};

/** A tile icon's inside, for a `0 0 24 24` box. */
export function iconOf(kind: IconKind, stroke: string): string {
  return ICONS[kind](stroke);
}

/** **AgencyBoost's 3-dot logo** (`logo-agencyboost.svg`), for a `0 0 64 64` box, in the tokens' navy and orange. */
export function agencyBoostLogo(): string {
  const navy = AGENCYBOOST_COLOURS.secondary;
  const orange = AGENCYBOOST_COLOURS.primary;
  return `<path d="M32 20 L18 44 M32 20 L46 44" stroke="${navy}" stroke-width="5" stroke-linecap="round" fill="none"/>`
    + `<circle cx="32" cy="18" r="8" fill="${navy}"/><circle cx="17" cy="45" r="8" fill="${navy}"/>`
    + `<circle cx="47" cy="45" r="8" fill="${orange}"/>`;
}
