/**
 * The vendor is mocked at the boundary — we test our adapter, not Cloudinary's SDK
 * (docs/03-engineering/testing-strategy.md, "What we deliberately do not test").
 */
jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    utils: {
      api_sign_request: jest.fn(() => 'signed-abc'),
      private_download_url: jest.fn((key: string, format: string, opts: Record<string, unknown>) =>
        `https://api.test/${String(opts.resource_type)}/download?public_id=${key}&format=${format}&expires_at=${String(opts.expires_at)}`),
    },
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
      expect.objectContaining({ timestamp: String(Math.floor(NOW.getTime() / 1000)) }),
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

  describe('the browser’s signed upload (Phase 17: what Cloudinary needs beside `file`)', () => {
    const upload = () => makeAdapter('dev').createSignedUpload({
      owner: { kind: 'kpm', kpmId: 'kpm-0417' }, folder: 'recruitment-pitch', filename: 'a.pdf', mimeType: 'application/pdf',
    });
    const TIMESTAMP = Math.floor(NOW.getTime() / 1000);

    it('signs exactly public_id, timestamp, type=authenticated and overwrite=false, with the secret — never api_key or file', async () => {
      const signed = await upload();
      expect(cloudinary.utils.api_sign_request).toHaveBeenCalledTimes(1);
      expect(cloudinary.utils.api_sign_request).toHaveBeenCalledWith(
        { public_id: signed.storageKey, timestamp: String(TIMESTAMP), type: 'authenticated', overwrite: 'false' }, 'secret',
      );
    });

    it('hands the browser every field to POST beside the file: api_key, timestamp, public_id, type, overwrite and signature', async () => {
      const signed = await upload();
      expect(signed.fields).toEqual({
        api_key: 'key',
        timestamp: String(TIMESTAMP),
        public_id: signed.storageKey,
        type: 'authenticated',
        overwrite: 'false',
        signature: 'signed-abc',
      });
      // Every field a string, as a form carries it; the secret in none of them.
      expect(Object.values(signed.fields).every((v) => typeof v === 'string')).toBe(true);
      expect(JSON.stringify(signed)).not.toContain('secret');
      expect(signed.signature).toBe(signed.fields.signature);
      expect(signed.uploadUrl).toBe('https://api.cloudinary.com/v1_1/agencyboost/auto/upload');
    });

    it('N5 a PDF-only route signs allowed_formats=pdf, and hands it to the browser to send', async () => {
      const signed = await makeAdapter('dev').createSignedUpload({
        owner: { kind: 'kpm', kpmId: 'kpm-0417' }, folder: 'products', filename: 'a.pdf', mimeType: 'application/pdf',
        allowedMimeTypes: ['application/pdf'],
      });
      const toSign = { public_id: signed.storageKey, timestamp: String(TIMESTAMP), type: 'authenticated', overwrite: 'false', allowed_formats: 'pdf' };
      expect(cloudinary.utils.api_sign_request).toHaveBeenCalledWith(toSign, 'secret');
      expect(signed.fields).toEqual({ api_key: 'key', ...toSign, signature: 'signed-abc' });
    });

    it('N5 names every format a narrower list maps to, and none it cannot', async () => {
      const signed = await makeAdapter().createSignedUpload({
        owner: { kind: 'kpm', kpmId: 'k' }, folder: 'f', filename: 'a', mimeType: 'image/png',
        allowedMimeTypes: ['image/png', 'image/jpeg', 'application/x-unknown'],
      });
      expect(signed.fields.allowed_formats).toBe('png,jpg');
      const none = await makeAdapter().createSignedUpload({
        owner: { kind: 'kpm', kpmId: 'k' }, folder: 'f', filename: 'a', mimeType: 'x', allowedMimeTypes: ['application/x-unknown'],
      });
      expect(none.fields).not.toHaveProperty('allowed_formats');
    });
  });

  describe('the link (Phase 17: authenticated, expiring, the file as what it is)', () => {
    const TIMESTAMP = Math.floor(NOW.getTime() / 1000);

    it('asks for a PDF as an image of format pdf, authenticated, expiring after the TTL — signed by the SDK', async () => {
      const url = await makeAdapter().createSignedUrl('dev/k/recruitment-pitch/1', 300, 'application/pdf');
      expect(cloudinary.utils.private_download_url).toHaveBeenCalledWith('dev/k/recruitment-pitch/1', 'pdf', {
        resource_type: 'image', type: 'authenticated', timestamp: TIMESTAMP, expires_at: TIMESTAMP + 300,
      });
      expect(url).toContain('expires_at=');
      // Never a public delivery URL.
      expect(cloudinary.url).not.toHaveBeenCalled();
    });

    it.each([
      ['image/png', 'image', 'png'], ['image/jpeg', 'image', 'jpg'], ['image/webp', 'image', 'webp'],
      ['video/mp4', 'video', 'mp4'], ['text/csv', 'raw', ''],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'raw', ''],
    ])('asks for %s as a %s resource of format "%s"', async (mimeType, resourceType, format) => {
      await makeAdapter().createSignedUrl('dev/k/f/1', 300, mimeType);
      expect(cloudinary.utils.private_download_url).toHaveBeenCalledWith(
        'dev/k/f/1', format, expect.objectContaining({ resource_type: resourceType, type: 'authenticated' }),
      );
    });

    it('takes an unrecorded type as an image, and the platform’s lifetime when none is given', async () => {
      await makeAdapter().createSignedUrl('dev/k/f/1');
      expect(cloudinary.utils.private_download_url).toHaveBeenCalledWith(
        'dev/k/f/1', '', expect.objectContaining({ resource_type: 'image', expires_at: TIMESTAMP + 300 }),
      );
      await makeAdapter().createSignedUrl('dev/k/f/2', 60, 'application/x-unknown');
      expect(cloudinary.utils.private_download_url).toHaveBeenLastCalledWith(
        'dev/k/f/2', '', expect.objectContaining({ resource_type: 'image', expires_at: TIMESTAMP + 60 }),
      );
    });
  });

  it('invalidates the CDN when removing, so a deleted file stops being served', async () => {
    await makeAdapter().remove('dev/k/f/1');
    expect(cloudinary.uploader.destroy).toHaveBeenCalledWith('dev/k/f/1', { invalidate: true, type: 'authenticated' });
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

    it('asks for the authenticated type every upload lands as — never the public `upload` type', async () => {
      (cloudinary.api.resource as jest.Mock).mockResolvedValueOnce({ format: 'pdf', bytes: 2048, type: 'authenticated' });
      await makeAdapter().describe('dev/kpm-1/recruitment-pitch/01ABC');
      expect(cloudinary.api.resource).toHaveBeenCalledWith(
        'dev/kpm-1/recruitment-pitch/01ABC', { resource_type: 'image', type: 'authenticated' },
      );
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

    it('reads the Admin API’s own shape — the status one level down — so its 404 is "nothing there"', async () => {
      // `api.resource` rejects `{ error: { message, http_code }, request_options, query_params }`.
      const adminNotFound = () => ({ error: { message: 'Resource not found - x', http_code: 404 }, request_options: { auth: 'k:s' } });
      (cloudinary.api.resource as jest.Mock).mockRejectedValue(adminNotFound());
      await expect(makeAdapter().describe('dev/kpm-1/recruitment-pitch/x')).resolves.toBeNull();
    });

    it('passes on a real Admin API failure by its message, never the vendor’s object with its request options', async () => {
      (cloudinary.api.resource as jest.Mock)
        .mockRejectedValue({ error: { message: 'Invalid Signature abc', http_code: 401 }, request_options: { auth: 'key:secret' } });
      const failure = await makeAdapter().describe('dev/kpm-1/x/1').catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('Cloudinary refused the lookup (401): Invalid Signature abc');
      expect(JSON.stringify(failure)).not.toContain('secret');
    });

    it('says so when the vendor gives neither a status nor a message', async () => {
      (cloudinary.api.resource as jest.Mock).mockRejectedValue(undefined);
      await expect(makeAdapter().describe('dev/kpm-1/x/1')).rejects.toThrow('Cloudinary refused the lookup (no status): no message');
    });
  });

  describe('copying an object into another owner\u2019s folder (P13.2-T7 AC-3, ADR-0115 \u00a76)', () => {
    const notFound = () => Object.assign(new Error('Resource not found'), { http_code: 404 });

    it('uploads from the source\u2019s private download link into a key minted under the destination', async () => {
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
      // The private download API, short-lived — never a delivery URL, which an account may refuse for a PDF.
      expect(cloudinary.url).not.toHaveBeenCalled();
      const TIMESTAMP = Math.floor(NOW.getTime() / 1000);
      expect(cloudinary.utils.private_download_url).toHaveBeenCalledWith('dev/kpm-0417/training/01SOURCE', '', {
        resource_type: 'raw', type: 'authenticated', timestamp: TIMESTAMP, expires_at: TIMESTAMP + 300,
      });
      expect(cloudinary.uploader.upload).toHaveBeenCalledWith(
        expect.stringContaining('dev/kpm-0417/training/01SOURCE'),
        expect.objectContaining({
          public_id: copied.storageKey, resource_type: 'raw', type: 'authenticated', overwrite: false,
        }),
      );
    });

    it('takes the source as `authenticated` — the type it was looked up as — when the vendor names none, a PDF fetched as format pdf', async () => {
      (cloudinary.api.resource as jest.Mock).mockResolvedValueOnce({ format: 'pdf', bytes: 10 });
      await makeAdapter().copy({
        storageKey: 'dev/company/co-1/training/01A', owner: { kind: 'company', companyId: 'co-2' }, folder: 'training',
      });
      expect(cloudinary.utils.private_download_url).toHaveBeenCalledWith(
        'dev/company/co-1/training/01A', 'pdf', expect.objectContaining({ resource_type: 'image', type: 'authenticated' }),
      );
      expect(cloudinary.uploader.upload).toHaveBeenCalledWith(
        expect.any(String), expect.objectContaining({ resource_type: 'image', type: 'authenticated' }),
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
      })).rejects.toThrow('Cloudinary refused the copy (no status): Rate limited');
    });

    it('passes on the uploader’s own refusal by its status and message, never the vendor’s object', async () => {
      (cloudinary.api.resource as jest.Mock).mockResolvedValueOnce({ format: 'pdf', bytes: 10 });
      (cloudinary.uploader.upload as jest.Mock).mockRejectedValueOnce({ message: 'Resource not found', http_code: 404, name: 'x' });
      await expect(makeAdapter().copy({
        storageKey: 'dev/kpm-1/training/a', owner: { kind: 'company', companyId: 'co-2' }, folder: 'training',
      })).rejects.toThrow('Cloudinary refused the copy (404): Resource not found');
    });
  });

  describe('a server-held file (Phase 17, D-seed — the demo seed’s demonstration PDFs)', () => {
    const notFound = () => Object.assign(new Error('Resource not found'), { http_code: 404 });
    const pdf = Buffer.from('%PDF-1.4 demonstration');
    const params = {
      owner: { kind: 'kpm', kpmId: 'kpm-0417' } as const, folder: 'recruitment-pitch',
      name: 'opportunity-demonstration', mimeType: 'application/pdf', body: pdf,
    };

    it('stores it under a key named for it in the owner’s folder, and reports what landed', async () => {
      (cloudinary.api.resource as jest.Mock).mockRejectedValue(notFound());
      (cloudinary.uploader.upload as jest.Mock).mockResolvedValueOnce({ format: 'pdf', bytes: 812 });

      const stored = await makeAdapter('dev').putObject(params);

      expect(stored).toEqual({
        storageKey: 'dev/kpm-0417/recruitment-pitch/opportunity-demonstration',
        mimeType: 'application/pdf', bytes: 812, sent: true,
      });
      expect(cloudinary.uploader.upload).toHaveBeenCalledWith(
        `data:application/pdf;base64,${pdf.toString('base64')}`,
        {
          public_id: 'dev/kpm-0417/recruitment-pitch/opportunity-demonstration', resource_type: 'auto',
          type: 'authenticated', overwrite: false,
        },
      );
    });

    it('describes a key storage already holds and sends nothing, so a re-seed uploads nothing', async () => {
      (cloudinary.api.resource as jest.Mock).mockResolvedValueOnce({ format: 'pdf', bytes: 812 });

      const stored = await makeAdapter('dev').putObject(params);

      expect(stored).toEqual({
        storageKey: 'dev/kpm-0417/recruitment-pitch/opportunity-demonstration',
        mimeType: 'application/pdf', bytes: 812, sent: false,
      });
      expect(cloudinary.uploader.upload).not.toHaveBeenCalled();
    });

    it('falls back to the bytes it sent, and passes an unmapped format through for the allow-list to refuse', async () => {
      (cloudinary.api.resource as jest.Mock).mockRejectedValue(notFound());
      (cloudinary.uploader.upload as jest.Mock).mockResolvedValueOnce({});

      const stored = await makeAdapter('dev').putObject({ ...params, owner: { kind: 'company', companyId: 'co-1' } });

      expect(stored).toEqual({
        storageKey: 'dev/company/co-1/recruitment-pitch/opportunity-demonstration', mimeType: '', bytes: pdf.length, sent: true,
      });
    });
  });
});
