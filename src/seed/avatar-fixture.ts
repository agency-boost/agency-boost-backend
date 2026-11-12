import mongoose from 'mongoose';
import sharp from 'sharp';
import { AVATAR } from '@/domain/constants';
import type { StoragePort } from '@/modules/assets/storage.port';
import { AVATAR_FOLDER } from '@/modules/users/avatar.service';
import { User, UserSchema } from '@/modules/users/user.schema';

/**
 * **Profile photos, for a reviewer** (UI-111; P19.11-T2 AC-4, UX-14; 2026-11-10): nobody in the seed had one, so every
 * avatar drew initials and a photo could not be seen anywhere — the New Hires circle of a hire not activated yet least of
 * all. Three people of 0417 get one, each **drawn here from shapes** (no font, no file, nobody's likeness), as
 * `branding-fixture.ts` draws 0555's mascot, and stored as *Simpan foto* stores one: a 256 × 256 JPEG under
 * `user/<userId>/avatar/<ulid>`, its key on `users.avatarUrl`.
 *
 * | Who | Where it shows |
 * |---|---|
 * | `agus@kpm0417.test` | the title row's avatar; *Anda · Direct Unit* on his New Hires |
 * | `arief@kpm0417.test` | his AAB group's row on Agus's New Hires; Agus's roster and coaching list |
 * | `tari@kpm0417.test` | **her circle on Agus's and Arief's New Hires**: not activated yet, so the photo, not a check |
 *
 * Everybody else keeps initials, so both are on one screen: Tari's photo, and *Belum*'s other hires' initials.
 *
 * **Re-runnable**: each photo goes under a fixed ULID, which storage answers `sent: false` on a second run, and a key is
 * written only on an account with no photo — one somebody uploaded on staging is never replaced. Skipped where storage
 * is not configured, as the branding's images are.
 */
export const DEMO_AVATARS = Object.freeze([
  {
    email: 'agus@kpm0417.test',
    /** Fixed, ULID-shaped, so a re-run writes the same key. */
    id: '01JC0000000000000000000A01',
    svg: portrait({ backdrop: '#dbe7f5', skin: '#c68a5e', hair: '#2b211c', shirt: '#24365c', hairShape: 'short' }),
  },
  {
    email: 'arief@kpm0417.test',
    id: '01JC0000000000000000000A02',
    svg: portrait({ backdrop: '#dcefe9', skin: '#a8754f', hair: '#1c1714', shirt: '#2f6f62', hairShape: 'side' }),
  },
  {
    email: 'tari@kpm0417.test',
    id: '01JC0000000000000000000A03',
    svg: portrait({ backdrop: '#f6e3d3', skin: '#d39a6f', hair: '#3a2a22', shirt: '#b0533c', hairShape: 'long' }),
  },
] as const);

/** A head and shoulders on a backdrop: shapes only, so it is nobody in particular. */
function portrait(p: { backdrop: string; skin: string; hair: string; shirt: string; hairShape: 'short' | 'side' | 'long' }): string {
  const hair = {
    short: `<path d="M78 112 Q80 58 128 54 Q176 58 178 112 Q170 84 128 82 Q86 84 78 112 Z" fill="${p.hair}"/>`,
    side: `<path d="M76 116 Q74 56 132 52 Q182 56 180 108 Q160 76 104 92 Q90 96 76 116 Z" fill="${p.hair}"/>`,
    long: `<path d="M72 190 Q60 60 128 52 Q196 60 184 190 L164 190 Q172 110 150 88 Q128 100 100 96 Q86 120 92 190 Z" fill="${p.hair}"/>`,
  }[p.hairShape];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${AVATAR.SIDE_PX}" height="${AVATAR.SIDE_PX}" viewBox="0 0 256 256">
  <rect width="256" height="256" fill="${p.backdrop}"/>
  <path d="M40 256 Q44 188 128 184 Q212 188 216 256 Z" fill="${p.shirt}"/>
  <rect x="112" y="150" width="32" height="40" rx="12" fill="${p.skin}"/>
  <ellipse cx="128" cy="118" rx="48" ry="56" fill="${p.skin}"/>
  ${hair}
  <circle cx="110" cy="122" r="5" fill="#2b211c"/><circle cx="146" cy="122" r="5" fill="#2b211c"/>
  <path d="M112 148 Q128 158 144 148" stroke="#7a3f2a" stroke-width="5" fill="none" stroke-linecap="round"/>
</svg>`;
}

export interface AvatarFixture {
  /** Accounts given a photo by this run: none on a second run, or where somebody already had one. */
  written: number;
  images: 'stored' | 'skipped: storage is not configured';
}

export async function seedAvatarFixture(deps: { storage: StoragePort | null }): Promise<AvatarFixture> {
  if (!deps.storage) return { written: 0, images: 'skipped: storage is not configured' };
  const Users = mongoose.models[User.name] ?? mongoose.model(User.name, UserSchema);
  let written = 0;
  for (const demo of DEMO_AVATARS) {
    const user = await Users.findOne({ email: demo.email }).select('_id').lean<{ _id: unknown }>().exec();
    if (!user) throw new Error(`${demo.email} is missing: the avatar fixture runs after every 0417 member is placed.`);
    const userId = String(user._id);
    const body = await sharp(Buffer.from(demo.svg)).jpeg({ quality: 82 }).toBuffer();
    const stored = await deps.storage.putObject({
      owner: { kind: 'user', userId }, folder: AVATAR_FOLDER, name: demo.id, mimeType: AVATAR.MIME_TYPES[0], body,
    });
    // `null` matches a missing field too: only an account with no photo of its own gets this one.
    const { modifiedCount } = await Users.updateOne({ _id: user._id, avatarUrl: null }, { $set: { avatarUrl: stored.storageKey } }).exec();
    written += modifiedCount;
  }
  return { written, images: 'stored' };
}
