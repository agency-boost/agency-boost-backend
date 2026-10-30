import { FixedClock } from '@/common/clock/clock.port';
import { AVATAR } from '@/domain/constants';
import { AvatarLinks, isOwnAvatarKey } from './avatar.service';

const ULID = '01JBX0Q4ZB7Y2M8K3T5W6N9P1R';
const NOW = new Date('2026-10-30T03:00:00Z');

describe('UI-111 the profile photo’s key and its links', () => {
  describe('isOwnAvatarKey: a key from the browser is a claim', () => {
    it('UI-111 accepts the caller’s own photo key under this environment’s prefix', () => {
      expect(isOwnAvatarKey(`dev/user/u-1/avatar/${ULID}`, 'u-1', 'dev')).toBe(true);
      expect(isOwnAvatarKey(`prod/user/u-1/avatar/${ULID}`, 'u-1', 'prod')).toBe(true);
    });

    it.each([
      ['another environment’s key', `staging/user/u-1/avatar/${ULID}`],
      ['a key with more in front of the prefix', `x/dev/user/u-1/avatar/${ULID}`],
      ['a prefix the key only starts with', `devx/user/u-1/avatar/${ULID}`],
      ['a folder nested under the prefix', `dev/agencyboost/user/u-1/avatar/${ULID}`],
    ])('L5 refuses %s: the prefix is checked, not only the owner, the folder and the leaf', (_, key) => {
      expect(isOwnAvatarKey(key, 'u-1', 'dev')).toBe(false);
    });

    it.each([
      ['another person’s photo', `dev/user/u-2/avatar/${ULID}`],
      ['an office’s upload', `dev/kpm-1/training/${ULID}`],
      ['the company’s material', `dev/company/co-1/avatar/${ULID}`],
      ['another folder of theirs', `dev/user/u-1/other/${ULID}`],
      ['a leaf that is no key storage minted', 'dev/user/u-1/avatar/../../kpm-1/x'],
      ['no prefix at all', `/user/u-1/avatar/${ULID}`],
      ['a key naming them twice', `dev/user/u-1/avatar/user/u-1/avatar/${ULID}`],
      ['a user folder nested in another', `dev/user/u-2/user/u-1/avatar/${ULID}`],
      ['a leaf with more after it', `dev/user/u-1/avatar/${ULID}/x`],
    ])('UI-111 refuses %s', (_, key) => {
      expect(isOwnAvatarKey(key, 'u-1', 'dev')).toBe(false);
    });
  });

  describe('AvatarLinks: one signature per photo per half day', () => {
    const make = (sign: (key: string, ttl: number, type?: string) => Promise<string>) => {
      const clock = new FixedClock(NOW);
      const storage = { createSignedUrl: jest.fn(sign) };
      return { links: new AvatarLinks(storage as never, clock), storage, clock };
    };

    it('UI-111 signs a JPEG for 12 hours, and answers null for no photo without asking storage', async () => {
      const { links, storage } = make(async (key) => `https://signed.test/${key}`);
      expect(await links.linkFor(null)).toBeNull();
      expect(await links.linkFor('')).toBeNull();
      expect(await links.linkFor('k-1')).toBe('https://signed.test/k-1');
      expect(storage.createSignedUrl).toHaveBeenCalledTimes(1);
      expect(storage.createSignedUrl).toHaveBeenCalledWith('k-1', AVATAR.URL_TTL_SECONDS, 'image/jpeg');
      expect(AVATAR.URL_TTL_SECONDS).toBe(43_200);
    });

    it('UI-111 reuses a link until an hour before it ends, then signs again', async () => {
      let n = 0;
      const { links, storage, clock } = make(async (key) => `https://signed.test/${key}?v=${(n += 1)}`);
      expect(await links.linkFor('k-1')).toBe('https://signed.test/k-1?v=1');
      clock.set(new Date(NOW.getTime() + 10 * 3600_000));
      expect(await links.linkFor('k-1')).toBe('https://signed.test/k-1?v=1');
      clock.set(new Date(NOW.getTime() + 11 * 3600_000));
      expect(await links.linkFor('k-1')).toBe('https://signed.test/k-1?v=2');
      expect(storage.createSignedUrl).toHaveBeenCalledTimes(2);
      expect(AVATAR.URL_RENEW_SECONDS).toBe(3600);
    });

    it('UI-111 a photo storage cannot sign is no photo: null, and the read that wanted it still answers', async () => {
      const { links } = make(async () => { throw new Error('STORAGE_NOT_CONFIGURED'); });
      expect(await links.linkFor('k-1')).toBeNull();
    });

    it('UI-111 signs many at once, each key once, leaving out the absent and the unsignable', async () => {
      const { links, storage } = make(async (key) => {
        if (key === 'bad') throw new Error('no');
        return `https://signed.test/${key}`;
      });
      const out = await links.linksFor(['a', null, 'a', undefined, 'b', 'bad', '']);
      expect([...out.entries()]).toEqual([['a', 'https://signed.test/a'], ['b', 'https://signed.test/b']]);
      expect(storage.createSignedUrl).toHaveBeenCalledTimes(3);
    });

    it('UI-111 the photo’s bounds: 256px square, at most 512 KB, a JPEG alone', () => {
      expect(AVATAR.SIDE_PX).toBe(256);
      expect(AVATAR.MAX_BYTES).toBe(524_288);
      expect([...AVATAR.MIME_TYPES]).toEqual(['image/jpeg']);
    });

    it('L5 the upload forms’ rate: 20 per account per hour', () => {
      expect(AVATAR.UPLOADS_PER_WINDOW).toBe(20);
      expect(AVATAR.UPLOAD_WINDOW_SECONDS).toBe(3600);
    });
  });
});
