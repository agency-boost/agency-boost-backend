/**
 * The vendor is mocked at the boundary — we test our adapter, not Cloudinary's SDK
 * (docs/03-engineering/testing-strategy.md, "What we deliberately do not test").
 */
jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    utils: { api_sign_request: jest.fn(() => 'signed-abc') },
    url: jest.fn((key: string, opts: Record<string, unknown>) => `https://cdn.test/${key}?e=${opts.expires_at}`),
    uploader: { destroy: jest.fn(async () => ({ result: 'ok' })) },
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
      kpmId: 'kpm-0417', folder: 'training', filename: 'a.pdf', mimeType: 'application/pdf',
    });
    expect(signed.storageKey).toMatch(/^dev\/kpm-0417\/training\/[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('uses the configured prefix, not a hardcoded one', async () => {
    const signed = await makeAdapter('prod').createSignedUpload({
      kpmId: 'kpm-1', folder: 'events', filename: 'p.png', mimeType: 'image/png',
    });
    expect(signed.storageKey.startsWith('prod/kpm-1/events/')).toBe(true);
  });

  it('generates a unique key per request', async () => {
    const adapter = makeAdapter();
    const params = { kpmId: 'k', folder: 'f', filename: 'a.pdf', mimeType: 'application/pdf' };
    const a = await adapter.createSignedUpload(params);
    const b = await adapter.createSignedUpload(params);
    expect(a.storageKey).not.toBe(b.storageKey);
  });

  it('signs the request with the timestamp from the injected clock', async () => {
    await makeAdapter().createSignedUpload({
      kpmId: 'k', folder: 'f', filename: 'a.pdf', mimeType: 'application/pdf',
    });
    expect(cloudinary.utils.api_sign_request).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: Math.floor(NOW.getTime() / 1000) }),
      'secret',
    );
  });

  it('expires the upload signature ten minutes out', async () => {
    const signed = await makeAdapter().createSignedUpload({
      kpmId: 'k', folder: 'f', filename: 'a.pdf', mimeType: 'application/pdf',
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
});
