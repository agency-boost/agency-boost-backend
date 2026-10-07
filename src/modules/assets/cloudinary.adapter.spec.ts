/**
 * The vendor is mocked at the boundary — we test our adapter, not Cloudinary's SDK
 * (docs/03-engineering/testing-strategy.md, "What we deliberately do not test").
 */
jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    utils: { api_sign_request: jest.fn(() => 'signed-abc') },
    url: jest.fn((key: string, opts: Record<string, unknown>) => `https://cdn.test/${key}?e=${opts.expires_at}`),
    uploader: {
      destroy: jest.fn(async () => ({ result: 'ok' })),
      upload: jest.fn(async () => ({ bytes: 4096 })),
    },
    api: { resource: jest.fn() },
  },
}));

import { v2 as cloudinary } from 'cloudinary';
import { FixedClock } from '@/common/clock/clock.port';
import { CloudinaryAdapter } from './cloudinary.adapter';

const NOW = new Date('2026-09-04T10:00:00Z');

function makeAdapter(prefix = 'dev') {
  const values: Record<string, string> = {
    CLOUDINARY_CLOUD_NAME: 'agencyboost',
    CLOUDINARY_API_KEY: 'key',
    CLOUDINARY_API_SECRET: 'secret',
    CLOUDINARY_FOLDER_PREFIX: prefix,
  };
  const config = { getOrThrow: (k: string) => values[k] };
  return new CloudinaryAdapter(config as never, new FixedClock(NOW));
}

describe('CloudinaryAdapter', () => {
  beforeEach(() => jest.clearAllMocks());

  it('folders the key by environment then tenant, so dev uploads never touch prod storage', async () => {
    const signed = await makeAdapter('dev').createSignedUpload({
      owner: { kind: 'kpm', kpmId: 'kpm-0417' },
      folder: 'training', filename: 'a.pdf', mimeType: 'application/pdf',
    });
    expect(signed.storageKey).toMatch(/^dev\/kpm-0417\/training\/[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('uses the configured prefix, not a hardcoded one', async () => {
    const signed = await makeAdapter('prod').createSignedUpload({
      owner: { kind: 'kpm', kpmId: 'kpm-1' },
      folder: 'events', filename: 'p.png', mimeType: 'image/png',
    });
    expect(signed.storageKey.startsWith('prod/kpm-1/events/')).toBe(true);
  });

  it('folders the company’s shared material apart from any office (ADR-0032)', async () => {
    // The literal `company` segment is what keeps the two apart: an office id and a company
    // id are both opaque strings, so per-office erasure could otherwise take the company's.
    const signed = await makeAdapter().createSignedUpload({
      owner: { kind: 'company', companyId: 'co-1' },
      folder: 'training', filename: 'a.pdf', mimeType: 'application/pdf',
    });
    expect(signed.storageKey.startsWith('dev/company/co-1/training/')).toBe(true);
  });

  it('generates a unique key per request', async () => {
    const adapter = makeAdapter();
    const params = {
      owner: { kind: 'kpm', kpmId: 'k' } as const,
      folder: 'f', filename: 'a.pdf', mimeType: 'application/pdf',
    };
    const a = await adapter.createSignedUpload(params);
    const b = await adapter.createSignedUpload(params);
    expect(a.storageKey).not.toBe(b.storageKey);
  });

  it('signs the request with the timestamp from the injected clock', async () => {
    await makeAdapter().createSignedUpload({
      owner: { kind: 'kpm', kpmId: 'k' },
      folder: 'f', filename: 'a.pdf', mimeType: 'application/pdf',
    });
    expect(cloudinary.utils.api_sign_request).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: Math.floor(NOW.getTime() / 1000) }),
      'secret',
    );
  });

  it('expires the upload signature ten minutes out', async () => {
    const signed = await makeAdapter().createSignedUpload({
      owner: { kind: 'kpm', kpmId: 'k' },
      folder: 'f', filename: 'a.pdf', mimeType: 'application/pdf',
    });
    expect(signed.expiresAt.getTime() - NOW.getTime()).toBe(10 * 60 * 1000);
  });

  it('produces signed, expiring, authenticated delivery URLs — assets are never public', async () => {
    await makeAdapter().createSignedUrl('dev/k/f/1', 300);
    expect(cloudinary.url).toHaveBeenCalledWith(
      'dev/k/f/1',
      expect.objectContaining({ sign_url: true, type: 'authenticated' }),
    );
  });

  it('invalidates the CDN when removing, so a deleted file stops being served', async () => {
    await makeAdapter().remove('dev/k/f/1');
    expect(cloudinary.uploader.destroy).toHaveBeenCalledWith('dev/k/f/1', { invalidate: true });
  });

  describe('confirming what storage actually holds (ADR-0040)', () => {
    /** Cloudinary answers a 404 by throwing an object carrying `http_code`. */
    const notFound = () => Object.assign(new Error('Resource not found'), { http_code: 404 });

    it('turns the vendor’s format back into the media type this product speaks', async () => {
      (cloudinary.api.resource as jest.Mock).mockResolvedValueOnce({ format: 'PDF', bytes: 2048 });

      await expect(makeAdapter().describe('dev/kpm-1/training/01ABC')).resolves.toEqual({
        storageKey: 'dev/kpm-1/training/01ABC',
        mimeType: 'application/pdf',
        bytes: 2048,
      });
    });

    it('asks each resource type in turn, because an upload goes to auto/upload', async () => {
      // Cloudinary decides for itself: a spreadsheet lands under `raw`, and `api.resource`
      // defaults to `image` and 404s for the rest. Asking once would only ever find pictures.
      (cloudinary.api.resource as jest.Mock)
        .mockRejectedValueOnce(notFound())
        .mockRejectedValueOnce(notFound())
        .mockResolvedValueOnce({ format: 'xlsx', bytes: 64 });

      const found = await makeAdapter().describe('dev/kpm-1/uploads/01ABC');

      expect(found?.mimeType)
        .toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect((cloudinary.api.resource as jest.Mock).mock.calls.map((c) => c[1].resource_type))
        .toEqual(['image', 'video', 'raw']);
    });

    it('answers null when the bytes never arrived', async () => {
      (cloudinary.api.resource as jest.Mock).mockRejectedValue(notFound());

      await expect(makeAdapter().describe('dev/kpm-1/training/nothing')).resolves.toBeNull();
    });

    it('passes an unmapped format through, so the allow-list refuses it by name', async () => {
      // Never invent a media type for a file we do not recognise: `refuseBeyondLimits` then
      // rejects `exe` rather than being handed something that looks acceptable.
      (cloudinary.api.resource as jest.Mock).mockResolvedValueOnce({ format: 'exe', bytes: 10 });

      await expect(makeAdapter().describe('dev/kpm-1/x/1'))
        .resolves.toMatchObject({ mimeType: 'exe' });
    });

    it('never reads a real failure as "the file is not there"', async () => {
      // A revoked credential is a 401. Swallowing it would report every upload as never
      // having arrived, and the screen would tell people to try again for ever.
      (cloudinary.api.resource as jest.Mock)
        .mockRejectedValue(Object.assign(new Error('Unauthorized'), { http_code: 401 }));

      await expect(makeAdapter().describe('dev/kpm-1/x/1')).rejects.toThrow('Unauthorized');
    });
  });

  describe('copying an object into another owner\u2019s folder (P13.2-T7 AC-3, ADR-0115 \u00a76)', () => {
    const notFound = () => Object.assign(new Error('Resource not found'), { http_code: 404 });

    it('uploads from the source\u2019s signed delivery URL into a key minted under the destination', async () => {
      // A spreadsheet: found under `raw`, delivered `authenticated`.
      (cloudinary.api.resource as jest.Mock)
        .mockRejectedValueOnce(notFound())
        .mockRejectedValueOnce(notFound())
        .mockResolvedValueOnce({ format: 'xlsx', bytes: 64, type: 'authenticated' });

      const copied = await makeAdapter('dev').copy({
        storageKey: 'dev/kpm-0417/training/01SOURCE',
        owner: { kind: 'company', companyId: 'co-2' },
        folder: 'training',
      });

      // The destination's folder, a fresh ULID: the copy is the destination company's by its key.
      expect(copied.storageKey).toMatch(/^dev\/company\/co-2\/training\/[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(copied).toMatchObject({
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        bytes: 4096,
      });
      expect(cloudinary.url).toHaveBeenCalledWith('dev/kpm-0417/training/01SOURCE', expect.objectContaining({
        resource_type: 'raw', type: 'authenticated', sign_url: true,
      }));
      expect(cloudinary.uploader.upload).toHaveBeenCalledWith(
        expect.stringContaining('dev/kpm-0417/training/01SOURCE'),
        expect.objectContaining({
          public_id: copied.storageKey, resource_type: 'raw', type: 'authenticated', overwrite: false,
        }),
      );
    });

    it('takes the source as `upload`-delivered when the vendor names no type', async () => {
      (cloudinary.api.resource as jest.Mock).mockResolvedValueOnce({ format: 'pdf', bytes: 10 });
      await makeAdapter().copy({
        storageKey: 'dev/company/co-1/training/01A', owner: { kind: 'company', companyId: 'co-2' }, folder: 'training',
      });
      expect(cloudinary.uploader.upload).toHaveBeenCalledWith(
        expect.any(String), expect.objectContaining({ resource_type: 'image', type: 'upload' }),
      );
    });

    it('refuses to copy a key that holds nothing, and uploads nothing', async () => {
      (cloudinary.api.resource as jest.Mock).mockRejectedValue(notFound());
      await expect(makeAdapter().copy({
        storageKey: 'dev/kpm-1/training/gone', owner: { kind: 'company', companyId: 'co-2' }, folder: 'training',
      })).rejects.toThrow('holds nothing');
      expect(cloudinary.uploader.upload).not.toHaveBeenCalled();
    });

    it('lets a vendor failure through, so a copy that did not happen is never reported as one', async () => {
      (cloudinary.api.resource as jest.Mock).mockResolvedValueOnce({ format: 'pdf', bytes: 10 });
      (cloudinary.uploader.upload as jest.Mock).mockRejectedValueOnce(new Error('Rate limited'));
      await expect(makeAdapter().copy({
        storageKey: 'dev/kpm-1/training/a', owner: { kind: 'company', companyId: 'co-2' }, folder: 'training',
      })).rejects.toThrow('Rate limited');
    });
  });
});
