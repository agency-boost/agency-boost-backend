import { BRANDING, BRANDING_ICON_FILES, BRANDING_MASCOT_FILE } from '@/domain/constants/branding';
import {
  contrastRatio, derivePalette, fillOf, hoverOf, inkOf, lessonColoursOf, mix, normaliseHex, textOn, tintOf,
  type BrandingPalette,
} from './palette';
import { isSafeSvg } from './svg-check';

/**
 * **P19.6-T1: the palette and the contrast rule** (ADR-0218 §5; `metrics-and-definitions.md`, *KPM branding*). Every
 * constant pinned, and the one function that derives every shade a KPM's two colours paint.
 */
describe('P19.6-T1 the branding constants (ADR-0218 §5)', () => {
  it('P19.6-T1 AC-7 pins the contrast rule: 4.5:1, white or #1B2B4B, a focus ring at 3:1', () => {
    expect(BRANDING.CONTRAST_MIN).toBe(4.5);
    expect(BRANDING.FOCUS_RING_MIN).toBe(3);
    expect(BRANDING.TEXT_LIGHT).toBe('#ffffff');
    expect(BRANDING.TEXT_DARK).toBe('#1b2b4b');
  });

  it('P19.6-T1 AC-5 pins the shades: tints at 8 % and 16 %, a 12 % hover, a 2 % ink step', () => {
    expect([BRANDING.TINT_50, BRANDING.TINT_100, BRANDING.HOVER_SHIFT, BRANDING.INK_STEP]).toEqual([0.08, 0.16, 0.12, 0.02]);
  });

  it('P19.6-T1 AC-3, AC-4, AC-6, AC-16 pins the images: 1 MB, 160 × 32 at ×3, 512 px, three mascot widths, five icon sizes', () => {
    expect(BRANDING.IMAGE_MAX_BYTES).toBe(1_048_576);
    expect(BRANDING.LOGO_BOX).toEqual({ width: 160, height: 32 });
    expect(BRANDING.LOGO_SCALE).toBe(3);
    expect(BRANDING.LOGO_MIN_HEIGHT_PX).toBe(32);
    expect([BRANDING.SQUARE_MIN_PX, BRANDING.MASCOT_MIN_PX]).toEqual([512, 512]);
    expect(BRANDING.MASCOT_WIDTHS).toEqual([120, 240, 360]);
    expect(BRANDING.ICON_SIZES).toEqual([32, 48, 180, 192, 512]);
    expect(BRANDING.MASKABLE_SAFE_ZONE).toBe(0.8);
    expect(BRANDING.MASCOT_POSES).toEqual(['default', 'thinking', 'celebrating', 'pointing', 'phone']);
    expect(BRANDING.MIME_TYPES).toEqual({
      logo: ['image/png', 'image/jpeg', 'image/svg+xml'], logo_square: ['image/png'], mascot: ['image/png'],
    });
  });

  it('P19.6-T1 AC-13 pins the public read’s limit (60 a minute per address) and the files’ caching', () => {
    expect([BRANDING.PUBLIC_READS_PER_WINDOW, BRANDING.PUBLIC_READ_WINDOW_SECONDS]).toEqual([60, 60]);
    expect([BRANDING.UPLOADS_PER_WINDOW, BRANDING.UPLOAD_WINDOW_SECONDS]).toEqual([30, 3600]);
    expect([BRANDING.FILE_MAX_AGE_SECONDS, BRANDING.FILE_UNVERSIONED_MAX_AGE_SECONDS]).toEqual([31_536_000, 300]);
    expect(BRANDING.PREVIEW_TTL_SECONDS).toBe(300);
    // The version that caches a file a year: the first 12 hex digits of the SHA-1 over what the KPM shows.
    expect(BRANDING.VERSION_LENGTH).toBe(12);
  });

  it('P19.6-T1 AC-16 names every file the public route serves, and nothing else', () => {
    expect(BRANDING_ICON_FILES).toEqual([
      'favicon-32.png', 'favicon-48.png', 'apple-touch-icon.png',
      'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png',
    ]);
    expect(BRANDING_MASCOT_FILE.test('mascot-thinking-240.webp')).toBe(true);
    expect(BRANDING_MASCOT_FILE.test('mascot-thinking-100.webp')).toBe(false);
    expect(BRANDING_MASCOT_FILE.test('original.png')).toBe(false);
  });
});

describe('P19.6-T1 AC-7 the contrast rule (acceptance 2)', () => {
  it('measures as WCAG does: black on white 21:1, a colour on itself 1:1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#e8954a', '#e8954a')).toBeCloseTo(1, 5);
  });

  it('P19.6-T1 AC-7 gives today’s navy on amber (5.91:1) and white on navy (14.06:1)', () => {
    expect(textOn('#e8954a')).toEqual({ contrast: 'dark', colour: '#1b2b4b', ratio: 5.91, readable: true });
    expect(textOn('#1b2b4b')).toEqual({ contrast: 'light', colour: '#ffffff', ratio: 14.06, readable: true });
  });

  it('P19.6-T1 AC-7 finds no words that read on a mid grey: white 3.95:1, the dark ink 3.56:1', () => {
    // Refused until P19.12-T3; now painted as its nearest readable shade (below, ADR-0246).
    expect(textOn('#808080')).toEqual({ contrast: 'light', colour: '#ffffff', ratio: 3.95, readable: false });
  });

  it('accepts only #rrggbb, lower-cased', () => {
    expect(normaliseHex('#0A6E5C')).toBe('#0a6e5c');
    expect(normaliseHex('0a6e5c')).toBeNull();
    expect(normaliseHex('#fff')).toBeNull();
    expect(normaliseHex(12)).toBeNull();
  });
});

describe('P19.6-T1 AC-5 the palette of two colours (ADR-0218 §6)', () => {
  const { palette } = derivePalette('#0A6E5C', '#F2C14E');

  it('P19.6-T1 AC-5 sets the words on each colour to the side that reads: white on teal, the dark ink on gold', () => {
    expect(palette.primaryContrast).toBe('#ffffff');
    expect(palette.secondaryContrast).toBe('#1b2b4b');
    expect(contrastRatio(palette.primary, palette.primaryContrast)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.secondary, palette.secondaryContrast)).toBeGreaterThanOrEqual(4.5);
  });

  it('P19.6-T1 AC-5 moves a hover away from its words, so the words only gain contrast', () => {
    expect(contrastRatio(palette.primaryHover, palette.primaryContrast))
      .toBeGreaterThan(contrastRatio(palette.primary, palette.primaryContrast));
    expect(contrastRatio(palette.secondaryHover, palette.secondaryContrast))
      .toBeGreaterThan(contrastRatio(palette.secondary, palette.secondaryContrast));
    expect(hoverOf('#808080', 'dark')).toBe(mix('#808080', '#ffffff', 0.12));
  });

  it('P19.6-T1 AC-5 darkens an ink until it reads 4.5:1 on white, and keeps one that already does', () => {
    expect(contrastRatio(inkOf('#f2c14e'), '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(mix(inkOf('#f2c14e'), '#ffffff', 0.05), '#ffffff')).toBeLessThan(4.6);
    expect(inkOf('#1b2b4b')).toBe('#1b2b4b');
    expect(palette.secondaryInk).toBe(inkOf('#f2c14e'));
  });

  it('P19.6-T1 AC-5 makes the tints 8 % and 16 % over white', () => {
    expect(palette.primary50).toBe(tintOf('#0a6e5c', 0.08));
    expect(palette.primary100).toBe(tintOf('#0a6e5c', 0.16));
    expect(palette.secondary50).toBe(mix('#ffffff', '#f2c14e', 0.08));
  });

  it('P19.6-T1 AC-5 gives today the primary’s tint and ink, and the sidebar the secondary’s words', () => {
    expect(palette.today).toBe(palette.primary100);
    expect(palette.todayInk).toBe(palette.primaryInk);
    expect(palette.sidebarText).toBe(palette.secondaryContrast);
    expect(palette.secondaryMuted).toBe(palette.secondaryContrast);
  });

  it('P19.6-T1 AC-5 keeps the focus ring the primary where it reads 3:1 on white, else its ink', () => {
    expect(palette.focusRing).toBe('#0a6e5c');
    expect(derivePalette('#f2c14e', '#1b2b4b').palette.focusRing).toBe(inkOf('#f2c14e'));
  });

  it('P19.6-T1 AC-5 writes the primary on the secondary only where it reads, else the secondary’s words', () => {
    expect(palette.primaryOnSecondary).toBe('#1b2b4b');
    expect(derivePalette('#e8954a', '#1b2b4b').palette.primaryOnSecondary).toBe('#e8954a');
  });

  it('every value is #rrggbb, lower-cased', () => {
    for (const value of Object.values(palette)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });
});

/**
 * **The palette as P19.6-T1 derived it**, frozen here (ADR-0218 §5, §6): what every stored colour was painted with
 * before P19.12-T3. A colour that rule accepted must derive exactly this palette still (ADR-0246 §2).
 */
function paletteBefore(primary: string, secondary: string): BrandingPalette {
  const words = (hex: string) => textOn(hex);
  const ink = (hex: string) => {
    let c = hex;
    for (let i = 0; i < 400 && contrastRatio(c, '#ffffff') < 4.5; i += 1) c = mix(c, '#000000', 0.02);
    return c;
  };
  const [p, q] = [primary.toLowerCase(), secondary.toLowerCase()];
  const [onP, onQ] = [words(p), words(q)];
  const primaryInk = ink(p);
  const primary100 = tintOf(p, 0.16);
  return {
    primary: p,
    primaryHover: hoverOf(p, onP.contrast),
    primaryContrast: onP.colour,
    primaryInk,
    primaryDeep: primaryInk,
    primaryOnSecondary: contrastRatio(p, q) >= 4.5 ? p : onQ.colour,
    primary50: tintOf(p, 0.08),
    primary100,
    focusRing: contrastRatio(p, '#ffffff') >= 3 ? p : primaryInk,
    secondary: q,
    secondaryHover: hoverOf(q, onQ.contrast),
    secondaryContrast: onQ.colour,
    secondaryInk: ink(q),
    secondaryMuted: onQ.colour,
    secondary50: tintOf(q, 0.08),
    secondary100: tintOf(q, 0.16),
    today: primary100,
    todayInk: primaryInk,
    sidebarText: onQ.colour,
  };
}

/** The sRGB cube every 15 levels: 5,832 colours, black, white and the six primaries among them. */
const CUBE: string[] = [];
for (let r = 0; r <= 255; r += 15) {
  for (let g = 0; g <= 255; g += 15) {
    for (let b = 0; b <= 255; b += 15) CUBE.push(`#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`);
  }
}

describe('P19.12-T3 every KPM colour is accepted, and a filled surface takes its nearest readable shade (ADR-0246)', () => {
  it.each([
    // The client's colour: white reads 4.4996:1, a hair under; one step darker reads 4.64.
    ['#a96800', { fill: '#a66600', contrast: 'light', colour: '#ffffff', ratio: 4.64, adjusted: true }],
    // The client's colour that passed: unchanged.
    ['#8a5500', { fill: '#8a5500', contrast: 'light', colour: '#ffffff', ratio: 6.21, adjusted: false }],
    ['#ffffff', { fill: '#ffffff', contrast: 'dark', colour: '#1b2b4b', ratio: 14.06, adjusted: false }],
    ['#000000', { fill: '#000000', contrast: 'light', colour: '#ffffff', ratio: 21, adjusted: false }],
    ['#fff59d', { fill: '#fff59d', contrast: 'dark', colour: '#1b2b4b', ratio: 12.59, adjusted: false }],
    // The mid grey: five steps darker for white, nine lighter for the dark ink — darker is nearer.
    ['#808080', { fill: '#757575', contrast: 'light', colour: '#ffffff', ratio: 4.61, adjusted: true }],
    // A green the dark ink almost reads on (4.46): one step lighter, against eleven darker — the lighter side.
    ['#00a758', { fill: '#05a95b', contrast: 'dark', colour: '#1b2b4b', ratio: 4.57, adjusted: true }],
    // Six steps either way: a tie takes the darker shade, with white words.
    ['#009696', { fill: '#008484', contrast: 'light', colour: '#ffffff', ratio: 4.53, adjusted: true }],
  ])('P19.12-T3 AC-1, AC-2 fills %s as pinned', (hex, expected) => {
    expect(fillOf(hex)).toEqual(expected);
    expect(fillOf(hex.toUpperCase())).toEqual(expected);
  });

  it('P19.12-T3 AC-1 derives a palette from any two colours, never a refusal, painting each as its fill', () => {
    const result = derivePalette('#A96800', '#808080');
    expect(result.primary).toMatchObject({ fill: '#a66600', adjusted: true });
    expect(result.secondary).toMatchObject({ fill: '#757575', adjusted: true });
    expect(result.palette).toEqual(paletteBefore('#a66600', '#757575'));
    expect(contrastRatio(result.palette.primary, result.palette.primaryContrast)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(result.palette.secondary, result.palette.secondaryContrast)).toBeGreaterThanOrEqual(4.5);
  });

  it('P19.12-T3 AC-2 a colour the old rule accepted derives exactly the palette it did — every stored colour unchanged', () => {
    const accepted = CUBE.filter((hex) => textOn(hex).readable);
    expect(accepted.length).toBeGreaterThan(4000);
    const changed: string[] = [];
    for (const hex of accepted) {
      for (const [p, q] of [[hex, '#1b2b4b'], ['#e8954a', hex]] as const) {
        const now = derivePalette(p, q);
        if (JSON.stringify(now.palette) !== JSON.stringify(paletteBefore(p, q))) changed.push(`${p}/${q}`);
        if (now.primary.adjusted || now.secondary.adjusted) changed.push(`${p}/${q} adjusted`);
      }
    }
    expect(changed).toEqual([]);
    // The demo office's colours, and AgencyBoost's own, by name.
    expect(derivePalette('#0a6e5c', '#1f3a5f').palette).toEqual(paletteBefore('#0a6e5c', '#1f3a5f'));
    expect(derivePalette('#e8954a', '#1b2b4b').palette).toEqual(paletteBefore('#e8954a', '#1b2b4b'));
  });

  it('P19.12-T3 AC-2 over the cube: every fill reads 4.5:1 with its words, within nine steps of the colour on its side', () => {
    const unread: string[] = [];
    const far: string[] = [];
    let adjusted = 0;
    for (const hex of CUBE) {
      const f = fillOf(hex);
      if (contrastRatio(f.fill, f.colour) < BRANDING.CONTRAST_MIN) unread.push(hex);
      expect(f.adjusted).toBe(!textOn(hex).readable);
      if (!f.adjusted) {
        expect(f.fill).toBe(hex);
        continue;
      }
      adjusted += 1;
      // Walk from the colour toward black (white words) or white (dark words), INK_STEP at a time, at most nine times.
      let c = hex;
      for (let i = 0; i < 9 && c !== f.fill; i += 1) c = mix(c, f.contrast === 'light' ? '#000000' : '#ffffff', BRANDING.INK_STEP);
      if (c !== f.fill) far.push(hex);
    }
    expect(unread).toEqual([]);
    expect(far).toEqual([]);
    // About a fifth of all colours were refused before, and are adjusted now.
    expect(adjusted / CUBE.length).toBeGreaterThan(0.15);
    expect(adjusted / CUBE.length).toBeLessThan(0.22);
  });
});

describe('P19.6-T2 AC-5, P19.6-T3 AC-5 a lesson’s colours (ADR-0217 §5; OD-269)', () => {
  it('P19.6-T1 gives the lesson the primary’s ink and lightest tint, bare hex, and the secondary only where white reads', () => {
    const navy = derivePalette('#0a6e5c', '#1b2b4b');
    expect(lessonColoursOf(navy.palette)).toEqual({
      accent: navy.palette.primaryInk.slice(1), accentSoft: navy.palette.primary50.slice(1), ink: '1b2b4b',
    });
    const gold = derivePalette('#0a6e5c', '#f2c14e');
    expect(lessonColoursOf(gold.palette)).not.toHaveProperty('ink');
  });

  it('P19.6-T1 has no lesson colours without branding', () => {
    expect(lessonColoursOf(null)).toBeNull();
  });
});

describe('P19.6-T1 AC-3 an uploaded SVG is checked, never rewritten (ADR-0218 §2)', () => {
  const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${body}</svg>`);

  it('P19.6-T1 AC-3 passes a plain drawing, with references inside the file', () => {
    expect(isSafeSvg(svg('<defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="10" height="10"/><use href="#g"/>'))).toBe(true);
  });

  it.each([
    ['a script', '<script>alert(1)</script>'],
    ['an on… attribute', '<rect onload="x()" width="1"/>'],
    ['a foreignObject', '<foreignObject><div/></foreignObject>'],
    ['an outside href', '<image href="https://evil.test/a.png"/>'],
    ['an outside xlink:href', '<image xlink:href=\'data:image/png;base64,AAA\'/>'],
    ['an outside url()', '<rect style="fill:url(https://evil.test/x)"/>'],
    ['an @import', '<style>@import "https://evil.test/a.css";</style>'],
  ])('P19.6-T1 AC-3 refuses %s', (_name, body) => {
    expect(isSafeSvg(svg(body))).toBe(false);
  });

  it('P19.6-T1 AC-3 refuses a DOCTYPE or an entity, and bytes that are no SVG', () => {
    expect(isSafeSvg(Buffer.from('<!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>'))).toBe(false);
    expect(isSafeSvg(Buffer.from('<html><body/></html>'))).toBe(false);
    expect(isSafeSvg(Buffer.from([0x3c, 0x73, 0x76, 0x67, 0x20, 0x00]))).toBe(false);
  });
});
