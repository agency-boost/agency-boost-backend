import sharp, { type Metadata, type Sharp } from 'sharp';
import { isSafeSvg } from '@/domain/branding/svg-check';
import { BRANDING, type BrandingUploadKind } from '@/domain/constants/branding';

/**
 * **The sizes made from an upload, at confirm** (P19.6-T1 AC-3, AC-4, AC-6, AC-16; ADR-0218 §2, §10). One function per
 * kind; each takes the uploaded bytes and answers the files to store beside it, or why it is refused. The original is
 * never served: only what this returns is.
 */

export type RefusalReason = 'dimensions' | 'no_alpha' | 'svg_unsafe' | 'unreadable';

export class BrandingImageRefused extends Error {
  constructor(readonly reason: RefusalReason) {
    super(`The image is refused: ${reason}.`);
  }
}

/** A file to store: its name in the set's folder, its type and bytes. */
export interface RenderedFile {
  name: string;
  mimeType: 'image/png' | 'image/webp';
  body: Buffer;
}

export interface RenderedSet {
  files: RenderedFile[];
  /** The kept picture's own size: the wide logo's PNG, the square's 512, the mascot's source. */
  width: number;
  height: number;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

/** **What the stored bytes are**, read from them and never from the claim: a PNG, a JPEG, an SVG, or nothing allowed. */
export function sniffImage(bytes: Buffer, declared: string): 'image/png' | 'image/jpeg' | 'image/svg+xml' | null {
  const starts = (sig: number[]) => bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
  if (starts(PNG)) return 'image/png';
  if (starts(JPEG)) return 'image/jpeg';
  if (declared === 'image/svg+xml' && !bytes.includes(0) && /<svg[\s>]/i.test(bytes.subarray(0, 4096).toString('utf8'))) {
    return 'image/svg+xml';
  }
  return null;
}

async function metadataOf(input: Buffer): Promise<Metadata> {
  try {
    return await sharp(input).metadata();
  } catch {
    throw new BrandingImageRefused('unreadable');
  }
}

/**
 * **The icons of §10 from a square picture**: the favicons at 32 and 48 px, transparent; the Apple touch icon at 180 px
 * and the app icons at 192 and 512 px, on white (iOS paints transparency black); the maskable icons on white, the logo
 * inside the centre 80 %.
 */
async function iconsFrom(square: Buffer): Promise<RenderedFile[]> {
  const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
  const white = { r: 255, g: 255, b: 255 };
  const clear = (size: number) => sharp(square).resize(size, size, { fit: 'contain', background: transparent }).png().toBuffer();
  const plain = (size: number) =>
    sharp(square).resize(size, size, { fit: 'contain', background: white }).flatten({ background: white }).png().toBuffer();
  const maskable = async (size: number) => {
    const inner = Math.round(size * BRANDING.MASKABLE_SAFE_ZONE);
    const logo = await sharp(square).resize(inner, inner, { fit: 'contain', background: transparent }).png().toBuffer();
    return sharp({ create: { width: size, height: size, channels: 4, background: { ...white, alpha: 1 } } })
      .composite([{ input: logo, gravity: 'centre' }]).flatten({ background: white }).png().toBuffer();
  };
  const png = (name: string, body: Buffer): RenderedFile => ({ name, mimeType: 'image/png', body });
  return [
    png('favicon-32.png', await clear(32)),
    png('favicon-48.png', await clear(48)),
    png('apple-touch-icon.png', await plain(180)),
    png('icon-192.png', await plain(192)),
    png('icon-512.png', await plain(512)),
    png('icon-maskable-192.png', await maskable(192)),
    png('icon-maskable-512.png', await maskable(512)),
  ];
}

/**
 * **The wide logo**: a PNG at three times its drawn size, inside 480 × 96 px, proportions kept; and the icons made from
 * it centred on a square, for a KPM with no square logo (§10). An SVG is checked, then rendered.
 */
export async function renderLogo(bytes: Buffer, type: 'image/png' | 'image/jpeg' | 'image/svg+xml'): Promise<RenderedSet> {
  const box = { width: BRANDING.LOGO_BOX.width * BRANDING.LOGO_SCALE, height: BRANDING.LOGO_BOX.height * BRANDING.LOGO_SCALE };
  let source: Sharp;
  if (type === 'image/svg+xml') {
    if (!isSafeSvg(bytes)) throw new BrandingImageRefused('svg_unsafe');
    const meta = await metadataOf(bytes);
    // Rendered large enough to fill the box at least once, whatever size the drawing declares.
    const scale = Math.max(1, box.height / Math.max(1, meta.height ?? box.height), box.width / Math.max(1, meta.width ?? box.width));
    source = sharp(bytes, { density: Math.min(2400, Math.round(72 * scale)) });
  } else {
    const meta = await metadataOf(bytes);
    if ((meta.height ?? 0) < BRANDING.LOGO_MIN_HEIGHT_PX) throw new BrandingImageRefused('dimensions');
    source = sharp(bytes);
  }
  let png: Buffer;
  try {
    png = await source.resize(box.width, box.height, { fit: 'inside', withoutEnlargement: type !== 'image/svg+xml' }).png().toBuffer();
  } catch {
    throw new BrandingImageRefused('unreadable');
  }
  const meta = await metadataOf(png);
  const side = Math.max(meta.width ?? 0, meta.height ?? 0);
  const square = await sharp(png)
    .resize(side, side, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    files: [{ name: 'logo.png', mimeType: 'image/png', body: png }, ...(await iconsFrom(square))],
  };
}

/** **The square logo**: a square PNG of at least 512 × 512, kept at 512 × 512, and every icon made from it. */
export async function renderSquare(bytes: Buffer): Promise<RenderedSet> {
  const meta = await metadataOf(bytes);
  const { width = 0, height = 0 } = meta;
  if (width !== height || width < BRANDING.SQUARE_MIN_PX) throw new BrandingImageRefused('dimensions');
  const png = await sharp(bytes).resize(BRANDING.SQUARE_MIN_PX, BRANDING.SQUARE_MIN_PX).png().toBuffer();
  return {
    width: BRANDING.SQUARE_MIN_PX,
    height: BRANDING.SQUARE_MIN_PX,
    files: [{ name: 'logo-square.png', mimeType: 'image/png', body: png }, ...(await iconsFrom(png))],
  };
}

/** **The mascot**: a PNG with transparency, its longer side at least 512 px, kept as WebP at 120, 240 and 360 wide. */
export async function renderMascot(bytes: Buffer): Promise<RenderedSet> {
  const meta = await metadataOf(bytes);
  const { width = 0, height = 0 } = meta;
  if (!meta.hasAlpha) throw new BrandingImageRefused('no_alpha');
  if (Math.max(width, height) < BRANDING.MASCOT_MIN_PX) throw new BrandingImageRefused('dimensions');
  const files: RenderedFile[] = [];
  for (const w of BRANDING.MASCOT_WIDTHS) {
    files.push({ name: `mascot-${w}.webp`, mimeType: 'image/webp', body: await sharp(bytes).resize({ width: w }).webp({ alphaQuality: 100 }).toBuffer() });
  }
  return { width, height, files };
}

/** One upload's sizes, by its kind. */
export async function renderUpload(
  kind: BrandingUploadKind, bytes: Buffer, type: 'image/png' | 'image/jpeg' | 'image/svg+xml',
): Promise<RenderedSet> {
  if (kind === 'logo') return renderLogo(bytes, type);
  if (kind === 'logo_square') return renderSquare(bytes);
  return renderMascot(bytes);
}

/** A picture's own pixel size, read from stored bytes (the PUT reads the wide logo's again, never the client's word). */
export async function sizeOf(bytes: Buffer): Promise<{ width: number; height: number }> {
  const meta = await metadataOf(bytes);
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}
