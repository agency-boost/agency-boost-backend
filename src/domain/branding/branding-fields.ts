import { derivePalette, normaliseHex, type PaletteResult } from './palette';
import { BRANDING, type MascotPose } from '@/domain/constants/branding';

/**
 * **The fields of a branding, checked** (P19.6-T1; ADR-0218 §2, §3, §5): the KPM's `PUT` and a template's *Tampilan*
 * section take the same shape, and this is the one check of it. Pure — no storage, no database — so the template's
 * publish (`config/template.service.ts`) and the KPM's save refuse the same things the same way.
 *
 * - **A group is saved whole**: both colours or neither; a square logo only with a wide one; a pose only with the
 *   default mascot.
 * - **Every image is a folder of sizes made at confirm under the owner's own folder** (`<env>/<owner>/branding/<ulid>`):
 *   a key naming another KPM's or company's folder is refused, so nobody shows another office's picture.
 * - **Each colour must carry readable words** (acceptance 2), else the field is named.
 */
export interface CheckedFields {
  logo: { key: string; width: number; height: number } | null;
  logoSquare: { key: string } | null;
  primary: string | null;
  secondary: string | null;
  mascot: { default: string; poses: Partial<Record<Exclude<MascotPose, 'default'>, string>> } | null;
}

export type FieldsProblem =
  | { problem: 'colourPair' }
  | { problem: 'squareNeedsLogo' }
  | { problem: 'poseNeedsDefault' }
  | { problem: 'notYours'; field: string }
  | { problem: 'unreadable'; result: Extract<PaletteResult, { ok: false }> };

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `key` is a folder of sizes under this owner's branding folder: `<env>/<ownerSegment>/branding/<ulid>`. */
export function isOwnImageKey(key: unknown, ownerSegment: string): key is string {
  return typeof key === 'string' && new RegExp(`^(?:[A-Za-z0-9._-]+/)+?${escape(ownerSegment)}/branding/${ULID}$`).test(key);
}

/** The wide logo's key, width and height as given; the KPM's save replaces the size with the stored PNG's. */
export function checkFields(input: unknown, ownerSegment: string): { ok: true; fields: CheckedFields } | { ok: false; problem: FieldsProblem } {
  const p = (input ?? {}) as Record<string, unknown>;
  const primary = p.primary == null ? null : normaliseHex(p.primary);
  const secondary = p.secondary == null ? null : normaliseHex(p.secondary);
  if ((p.primary != null && !primary) || (p.secondary != null && !secondary) || Boolean(primary) !== Boolean(secondary)) {
    return { ok: false, problem: { problem: 'colourPair' } };
  }
  const logoIn = p.logo as { key?: unknown; width?: unknown; height?: unknown } | null | undefined;
  const squareIn = p.logoSquare as { key?: unknown } | null | undefined;
  const mascotIn = p.mascot as { default?: unknown; poses?: Record<string, unknown> } | null | undefined;
  if (squareIn && !logoIn) return { ok: false, problem: { problem: 'squareNeedsLogo' } };
  if (logoIn && !isOwnImageKey(logoIn.key, ownerSegment)) return { ok: false, problem: { problem: 'notYours', field: 'logo' } };
  if (squareIn && !isOwnImageKey(squareIn.key, ownerSegment)) return { ok: false, problem: { problem: 'notYours', field: 'logoSquare' } };
  let mascot: CheckedFields['mascot'] = null;
  if (mascotIn) {
    if (mascotIn.default == null) return { ok: false, problem: { problem: 'poseNeedsDefault' } };
    if (!isOwnImageKey(mascotIn.default, ownerSegment)) return { ok: false, problem: { problem: 'notYours', field: 'mascot.default' } };
    const poses: Partial<Record<Exclude<MascotPose, 'default'>, string>> = {};
    for (const pose of BRANDING.MASCOT_POSES) {
      if (pose === 'default') continue;
      const key = mascotIn.poses?.[pose];
      if (key == null) continue;
      if (!isOwnImageKey(key, ownerSegment)) return { ok: false, problem: { problem: 'notYours', field: `mascot.poses.${pose}` } };
      poses[pose] = key;
    }
    mascot = { default: mascotIn.default, poses };
  }
  if (primary && secondary) {
    const result = derivePalette(primary, secondary);
    if (!result.ok) return { ok: false, problem: { problem: 'unreadable', result } };
  }
  return {
    ok: true,
    fields: {
      logo: logoIn ? { key: logoIn.key as string, width: Number(logoIn.width) || 0, height: Number(logoIn.height) || 0 } : null,
      logoSquare: squareIn ? { key: squareIn.key as string } : null,
      primary,
      secondary,
      mascot,
    },
  };
}
