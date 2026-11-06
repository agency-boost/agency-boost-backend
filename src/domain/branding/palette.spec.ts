import { BRANDING, BRANDING_ICON_FILES, BRANDING_MASCOT_FILE } from '@/domain/constants/branding';
import {
  contrastRatio, derivePalette, hoverOf, inkOf, lessonColoursOf, mix, normaliseHex, textOn, tintOf,
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

  it('P19.6-T1 AC-7 refuses a colour no text reads on, naming the field', () => {
    // A mid grey: white 3.95:1 and the dark ink 3.56:1, both short of 4.5.
    const refused = derivePalette('#808080', '#1b2b4b');
    expect(refused).toMatchObject({ ok: false, field: 'primary' });
    expect(derivePalette('#e8954a', '#808080')).toMatchObject({ ok: false, field: 'secondary' });
  });

  it('accepts only #rrggbb, lower-cased', () => {
    expect(normaliseHex('#0A6E5C')).toBe('#0a6e5c');
    expect(normaliseHex('0a6e5c')).toBeNull();
    expect(normaliseHex('#fff')).toBeNull();
    expect(normaliseHex(12)).toBeNull();
  });
});

describe('P19.6-T1 AC-5 the palette of two colours (ADR-0218 §6)', () => {
  const result = derivePalette('#0A6E5C', '#F2C14E');
  if (!result.ok) throw new Error('expected a palette');
  const { palette } = result;

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
    const pale = derivePalette('#f2c14e', '#1b2b4b');
    expect(pale.ok && pale.palette.focusRing).toBe(inkOf('#f2c14e'));
  });

  it('P19.6-T1 AC-5 writes the primary on the secondary only where it reads, else the secondary’s words', () => {
    expect(palette.primaryOnSecondary).toBe('#1b2b4b');
    const today = derivePalette('#e8954a', '#1b2b4b');
    expect(today.ok && today.palette.primaryOnSecondary).toBe('#e8954a');
  });

  it('every value is #rrggbb, lower-cased', () => {
    for (const value of Object.values(palette)) expect(value).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('P19.6-T2 AC-5, P19.6-T3 AC-5 a lesson’s colours (ADR-0217 §5; OD-269)', () => {
  it('P19.6-T1 gives the lesson the primary’s ink and lightest tint, bare hex, and the secondary only where white reads', () => {
    const navy = derivePalette('#0a6e5c', '#1b2b4b');
    if (!navy.ok) throw new Error('expected a palette');
    expect(lessonColoursOf(navy.palette)).toEqual({
      accent: navy.palette.primaryInk.slice(1), accentSoft: navy.palette.primary50.slice(1), ink: '1b2b4b',
    });
    const gold = derivePalette('#0a6e5c', '#f2c14e');
    if (!gold.ok) throw new Error('expected a palette');
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
