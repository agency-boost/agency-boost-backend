import mongoose from 'mongoose';
import sharp from 'sharp';
import { AVATAR } from '@/domain/constants';
import { isOwnAvatarKey } from '@/modules/users/avatar.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { StubStorage } from '../../../test/stub-storage';
import { DEMO_AVATARS, seedAvatarFixture } from '../avatar-fixture';

/**
 * **Profile photos, for a reviewer** (UI-111, UX-14; `avatar-fixture.ts`): Agus, Arief and Tari get one each, stored as an
 * upload is — a 256 × 256 JPEG under their own `user/<userId>/avatar/<ulid>` — so the product's own check takes the key
 * as theirs; a second run sends and writes nothing; a photo somebody uploaded is kept; without storage, nothing.
 */
describe('the avatar seed (UI-111, UX-14)', () => {
  let storage: StubStorage;
  const users = () => mongoose.models[User.name] ?? mongoose.model(User.name, UserSchema);
  const add = (email: string, fullName: string, avatarUrl: string | null = null) =>
    users().create({ email, fullName, passwordHash: 'x', avatarUrl });

  beforeAll(async () => {
    await startMongo();
  }, 120_000);

  beforeEach(async () => {
    await clearCollections();
    storage = new StubStorage();
  });

  afterAll(async () => {
    await stopMongo();
  });

  it('UX-14 gives Agus, Arief and Tari a photo stored as an upload is; a second run writes nothing', async () => {
    await add('agus@kpm0417.test', 'Agus Prasetyo');
    await add('arief@kpm0417.test', 'Arief Hidayat');
    await add('tari@kpm0417.test', 'Tari Wulandari');
    await add('indah@kpm0417.test', 'Indah Permatasari');

    expect(await seedAvatarFixture({ storage })).toEqual({ written: 3, images: 'stored' });
    for (const demo of DEMO_AVATARS) {
      const user = await users().findOne({ email: demo.email }).lean<{ _id: unknown; avatarUrl: string }>().exec();
      // The key the product mints for a photo, so `attach`'s own check would take it as this person's.
      expect([demo.email, isOwnAvatarKey(user!.avatarUrl, String(user!._id), 'dev')]).toEqual([demo.email, true]);
      expect(user!.avatarUrl).toBe(`dev/user/${String(user!._id)}/avatar/${demo.id}`);
      const stored = await storage.describe(user!.avatarUrl);
      expect(stored).toMatchObject({ mimeType: AVATAR.MIME_TYPES[0] });
    }
    // Everybody else keeps initials, so a photo and initials are on one screen.
    expect((await users().findOne({ email: 'indah@kpm0417.test' }).lean<{ avatarUrl: string | null }>().exec())!.avatarUrl).toBeNull();

    const sent = storage.puts.length;
    expect(await seedAvatarFixture({ storage })).toEqual({ written: 0, images: 'stored' });
    expect(storage.puts.length).toBe(sent);
  });

  it('UX-14 each photo is the crop Simpan foto sends: a 256 × 256 JPEG under the ceiling', async () => {
    for (const demo of DEMO_AVATARS) {
      const body = await sharp(Buffer.from(demo.svg)).jpeg({ quality: 82 }).toBuffer();
      const meta = await sharp(body).metadata();
      expect([demo.email, meta.format, meta.width, meta.height]).toEqual([demo.email, 'jpeg', AVATAR.SIDE_PX, AVATAR.SIDE_PX]);
      expect(body.length).toBeLessThan(AVATAR.MAX_BYTES);
    }
  });

  it('UI-111 a photo somebody uploaded is never replaced', async () => {
    await add('agus@kpm0417.test', 'Agus Prasetyo', 'dev/user/66f0000000000000000000a1/avatar/01JDDDDDDDDDDDDDDDDDDDDDDD');
    await add('arief@kpm0417.test', 'Arief Hidayat');
    await add('tari@kpm0417.test', 'Tari Wulandari');

    expect(await seedAvatarFixture({ storage })).toEqual({ written: 2, images: 'stored' });
    expect((await users().findOne({ email: 'agus@kpm0417.test' }).lean<{ avatarUrl: string }>().exec())!.avatarUrl)
      .toBe('dev/user/66f0000000000000000000a1/avatar/01JDDDDDDDDDDDDDDDDDDDDDDD');
  });

  it('UX-14 without storage, gives nobody a photo', async () => {
    await add('agus@kpm0417.test', 'Agus Prasetyo');
    expect(await seedAvatarFixture({ storage: null })).toEqual({ written: 0, images: 'skipped: storage is not configured' });
    expect((await users().findOne({ email: 'agus@kpm0417.test' }).lean<{ avatarUrl: string | null }>().exec())!.avatarUrl).toBeNull();
  });
});
