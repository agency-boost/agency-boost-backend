import mongoose from 'mongoose';
import sharp from 'sharp';
import type { Clock } from '@/common/clock/clock.port';
import { derivePalette } from '@/domain/branding/palette';
import type { StoragePort } from '@/modules/assets/storage.port';
import { renderLogo, renderMascot } from '@/modules/branding/branding-images';
import { KpmBranding, KpmBrandingSchema } from '@/modules/branding/kpm-branding.schema';

/**
 * **One KPM in its own colours, for a reviewer** (P19.6-T1; ADR-0218): KPM 0555 *Kelapa Gading Branch* — signed in as
 * `owner@kpm0555.test` or `agent@kpm0555.test` — shows a teal primary and a deep-blue secondary, and, where storage is
 * configured, a logo and a mascot drawn here from shapes (no font, no file). Every other demo KPM keeps AgencyBoost's
 * look, so the two can be compared side by side.
 *
 * **Re-runnable**: a KPM that already holds a live row is left as it is, and the images go under fixed folders, which
 * storage answers `sent: false` on a second run.
 */
export const BRANDED_DEMO = Object.freeze({
  primary: '#0a6e5c',
  secondary: '#1f3a5f',
  /** Fixed folders (ULID-shaped), so a re-run writes the same keys. */
  logoFolder: 'branding/01JC0000000000000000000001',
  mascotFolder: 'branding/01JC0000000000000000000002',
});

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="96" viewBox="0 0 480 96">
  <rect x="0" y="8" width="80" height="80" rx="18" fill="#0a6e5c"/>
  <circle cx="40" cy="48" r="20" fill="#ffffff"/>
  <circle cx="40" cy="48" r="9" fill="#1f3a5f"/>
  <rect x="104" y="28" width="250" height="16" rx="8" fill="#1f3a5f"/>
  <rect x="104" y="56" width="170" height="12" rx="6" fill="#0a6e5c"/>
</svg>`;

const MASCOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <ellipse cx="300" cy="330" rx="210" ry="230" fill="#0a6e5c"/>
  <circle cx="230" cy="290" r="44" fill="#ffffff"/><circle cx="370" cy="290" r="44" fill="#ffffff"/>
  <circle cx="240" cy="296" r="18" fill="#1f3a5f"/><circle cx="380" cy="296" r="18" fill="#1f3a5f"/>
  <path d="M220 420 Q300 480 380 420" stroke="#ffffff" stroke-width="22" fill="none" stroke-linecap="round"/>
</svg>`;

export interface BrandingFixture {
  kpmId: string;
  written: number;
  images: 'stored' | 'skipped: storage is not configured';
}

export async function seedBrandingFixture(deps: { clock: Clock; storage: StoragePort | null; kpmId: string }): Promise<BrandingFixture> {
  const Rows = mongoose.models[KpmBranding.name] ?? mongoose.model(KpmBranding.name, KpmBrandingSchema);
  const images: BrandingFixture['images'] = deps.storage ? 'stored' : 'skipped: storage is not configured';
  if (await Rows.exists({ kpmId: deps.kpmId, deletedAt: null })) return { kpmId: deps.kpmId, written: 0, images };

  let logo: { key: string; width: number; height: number } | null = null;
  let mascot: { default: string; poses: Record<string, string> } | null = null;
  if (deps.storage) {
    const owner = { kind: 'kpm' as const, kpmId: deps.kpmId };
    const logoSet = await renderLogo(Buffer.from(LOGO_SVG), 'image/svg+xml');
    let logoKey = '';
    for (const file of logoSet.files) {
      const stored = await deps.storage.putObject({ owner, folder: BRANDED_DEMO.logoFolder, name: file.name, mimeType: file.mimeType, body: file.body });
      logoKey = stored.storageKey.slice(0, -(file.name.length + 1));
    }
    logo = { key: logoKey, width: logoSet.width, height: logoSet.height };
    const mascotPng = await sharp(Buffer.from(MASCOT_SVG)).png().toBuffer();
    const mascotSet = await renderMascot(mascotPng);
    let mascotKey = '';
    for (const file of mascotSet.files) {
      const stored = await deps.storage.putObject({ owner, folder: BRANDED_DEMO.mascotFolder, name: file.name, mimeType: file.mimeType, body: file.body });
      mascotKey = stored.storageKey.slice(0, -(file.name.length + 1));
    }
    mascot = { default: mascotKey, poses: {} };
  }

  const palette = derivePalette(BRANDED_DEMO.primary, BRANDED_DEMO.secondary);
  if (!palette.ok) throw new Error('The demo’s branding colours must be readable.');
  const at = deps.clock.now();
  await Rows.create({
    kpmId: deps.kpmId,
    logo,
    logoSquare: null,
    primary: BRANDED_DEMO.primary,
    secondary: BRANDED_DEMO.secondary,
    contrast: {
      primary: { side: palette.primary.contrast, ratio: palette.primary.ratio },
      secondary: { side: palette.secondary.contrast, ratio: palette.secondary.ratio },
    },
    mascot,
    version: 1,
    updatedBy: null,
    deletedAt: null,
    deletedBy: null,
    createdAt: at,
    updatedAt: at,
  });
  return { kpmId: deps.kpmId, written: 1, images };
}
