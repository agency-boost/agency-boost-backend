/**
 * The vendor is mocked at the boundary — we test our adapter, not Google's SDK
 * (docs/03-engineering/testing-strategy.md, "What we deliberately do not test"). The real bucket is the opt-in
 * `pnpm test:storage-live` suite's (`gcs.adapter.live.spec.ts`).
 */
const mockFile = {
  generateSignedPostPolicyV4: jest.fn(),
  getSignedUrl: jest.fn(),
  getMetadata: jest.fn(),
  download: jest.fn(),
  copy: jest.fn(),
  save: jest.fn(),
  delete: jest.fn(),
};
const mockBucketFile = jest.fn((name: string) => ({ name, ...mockFile }));
const mockBucket = jest.fn((_name: string) => ({ file: mockBucketFile }));
jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: mockBucket })),
}));

import { Storage } from '@google-cloud/storage';
import { HttpStatus } from '@nestjs/common';
import { FixedClock } from '@/common/clock/clock.port';
import { ErrorCode } from '@/common/errors/error-codes';
import { ASSET_LIMITS, AVATAR, DOCUMENT_MIME_TYPES } from '@/domain/constants';
import { AssetService } from './asset.service';
import { GcsAdapter, storageRefusal } from './gcs.adapter';

/** The injected clock: what the API reports. */
const NOW = new Date('2026-10-19T03:00:00Z');
/** The SDK's clock, deliberately elsewhere: what the signature is measured from. */
const SDK_NOW = Date.parse('2026-10-19T03:00:07Z');
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PDF_BYTES = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj', 'latin1');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const EXE_BYTES = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

/** What the SDK hands back for a POST policy: every field the form must carry, as strings. */
const POLICY = {
  url: 'https://storage.googleapis.com/agencyboost-staging-assets/',
  fields: {
    'Content-Type': 'application/pdf',
    key: 'set-per-test',
    'x-goog-date': '20261019T030007Z',
    'x-goog-credential': 'api-runtime@agencyboost-staging.iam.gserviceaccount.com/20261019/auto/storage/goog4_request',
    'x-goog-algorithm': 'GOOG4-RSA-SHA256',
    policy: 'eyJjb25kaXRpb25zIjpbXX0=',
    'x-goog-signature': '5f2a9c',
  },
};

/** A Cloud Storage `ApiError`: the status in `code`. */
const apiError = (code: number, message: string) => Object.assign(new Error(message), { code, errors: [{ message }] });
/** A gaxios failure: the status on the response, and the request it made — bearer token included. */
const gaxiosError = (status: number, message: string) => Object.assign(new Error(message), {
  response: { status }, config: { headers: { Authorization: 'Bearer ya29.a0-secret-token' } },
});

function makeAdapter(values: Record<string, string> = {}) {
  const all: Record<string, string> = { GCS_BUCKET: 'agencyboost-staging-assets', STORAGE_KEY_PREFIX: 'dev', ...values };
  const config = {
    get: (k: string) => all[k],
    getOrThrow: (k: string) => {
      if (!(k in all)) throw new Error(`${k} is not set.`);
      return all[k];
    },
  };
  return new GcsAdapter(config as never, new FixedClock(NOW));
}

/** The bucket holds `body` under every key, claimed as `contentType`. */
function holds(body: Buffer, contentType: string, size: number = body.length) {
  mockFile.getMetadata.mockResolvedValue([{ size: String(size), contentType }, {}]);
  mockFile.download.mockResolvedValue([body]);
}

describe('P18.4-T2 GcsAdapter (ADR-0153)', () => {
  let sdkClock: jest.SpyInstance<number, []>;
  beforeEach(() => {
    jest.clearAllMocks();
    mockFile.getMetadata.mockReset();
    mockFile.download.mockReset();
    sdkClock = jest.spyOn(Date, 'now').mockReturnValue(SDK_NOW);
  });
  afterEach(() => sdkClock.mockRestore());

  describe('the client', () => {
    it('P18.4-T2 opens the configured bucket with Application Default Credentials — no key in the config', () => {
      makeAdapter();
      expect(Storage).toHaveBeenLastCalledWith({});
      expect(mockBucket).toHaveBeenLastCalledWith('agencyboost-staging-assets');
    });

    it('P18.4-T2 names the project when GCS_PROJECT_ID is set, and not when it is blank', () => {
      makeAdapter({ GCS_PROJECT_ID: ' agencyboost-staging ', GCS_BUCKET: ' agencyboost-staging-assets ' });
      expect(Storage).toHaveBeenLastCalledWith({ projectId: 'agencyboost-staging' });
      expect(mockBucket).toHaveBeenLastCalledWith('agencyboost-staging-assets');
      // Blank reaches the adapter raw: `ConfigService.get` falls back to `process.env` when validation unset it.
      makeAdapter({ GCS_PROJECT_ID: '   ' });
      expect(Storage).toHaveBeenLastCalledWith({});
    });

    it('P18.4-T2 refuses to build without a bucket', () => {
      const config = { get: () => undefined, getOrThrow: (k: string) => { throw new Error(`${k} is not set.`); } };
      expect(() => new GcsAdapter(config as never, new FixedClock(NOW))).toThrow('GCS_BUCKET is not set.');
    });
  });

  describe('the browser’s signed upload: a V4 POST policy', () => {
    const upload = (adapter = makeAdapter(), extra: Record<string, unknown> = {}) => adapter.createSignedUpload({
      owner: { kind: 'kpm', kpmId: 'kpm-0417' }, folder: 'recruitment-pitch', filename: 'a.pdf', mimeType: 'application/pdf',
      ...extra,
    });
    beforeEach(() => mockFile.generateSignedPostPolicyV4.mockResolvedValue([POLICY]));

    it('P18.4-T2 keys it <prefix>/<kpmId>/<folder>/<ulid>, the shape every registered key already has', async () => {
      const signed = await upload();
      expect(signed.storageKey).toMatch(new RegExp(`^dev/kpm-0417/recruitment-pitch/${ULID.source}$`));
      expect(mockBucketFile).toHaveBeenCalledWith(signed.storageKey);
    });

    it('P18.4-T2 uses the configured prefix, and folders the company’s material apart from any office (ADR-0032)', async () => {
      const prod = await upload(makeAdapter({ STORAGE_KEY_PREFIX: 'prod' }));
      expect(prod.storageKey.startsWith('prod/kpm-0417/recruitment-pitch/')).toBe(true);
      const company = await makeAdapter().createSignedUpload({
        owner: { kind: 'company', companyId: 'co-1' }, folder: 'training', filename: 'a.pdf', mimeType: 'application/pdf',
      });
      expect(company.storageKey).toMatch(new RegExp(`^dev/company/co-1/training/${ULID.source}$`));
    });

    it('UI-111 folders a person’s profile photo under user/<userId>, apart from every office and company', async () => {
      const photo = await makeAdapter().createSignedUpload({
        owner: { kind: 'user', userId: 'u-1' }, folder: 'avatar', filename: 'avatar.jpg', mimeType: 'image/jpeg',
      });
      expect(photo.storageKey).toMatch(new RegExp(`^dev/user/u-1/avatar/${ULID.source}$`));
    });

    it('L5 a route’s own ceiling replaces 25 MB in the policy: a profile photo’s 512 KB, enforced by storage on the bytes', async () => {
      await makeAdapter().createSignedUpload({
        owner: { kind: 'user', userId: 'u-1' }, folder: 'avatar', filename: 'avatar.jpg', mimeType: 'image/jpeg',
        maxBytes: AVATAR.MAX_BYTES,
      });
      expect(mockFile.generateSignedPostPolicyV4).toHaveBeenCalledWith(expect.objectContaining({
        conditions: [['content-length-range', 1, 512 * 1024]],
        fields: { 'Content-Type': 'image/jpeg' },
      }));
    });

    it('P18.4-T2 mints a fresh key per request', async () => {
      const adapter = makeAdapter();
      expect((await upload(adapter)).storageKey).not.toBe((await upload(adapter)).storageKey);
    });

    it('P18.4-T2 pins the Content-Type to the checked type and the size to 1 byte .. 25 MB, expiring 10 minutes out by the SDK’s clock', async () => {
      await upload();
      expect(mockFile.generateSignedPostPolicyV4).toHaveBeenCalledTimes(1);
      expect(mockFile.generateSignedPostPolicyV4).toHaveBeenCalledWith({
        expires: SDK_NOW + 10 * 60 * 1000,
        conditions: [['content-length-range', 1, ASSET_LIMITS.MAX_BYTES]],
        fields: { 'Content-Type': 'application/pdf' },
      });
      expect(ASSET_LIMITS.MAX_BYTES).toBe(25 * 1024 * 1024);
    });

    it('P18.4-T2 hands the browser every field the policy covers, the signature among them, and reports expiry by the injected clock', async () => {
      const signed = await upload();
      expect(signed.uploadUrl).toBe(POLICY.url);
      expect(signed.fields).toEqual(POLICY.fields);
      expect(signed.fields).not.toBe(POLICY.fields);
      expect(signed.signature).toBe('5f2a9c');
      expect(signed.signature).toBe(signed.fields['x-goog-signature']);
      expect(signed.expiresAt).toEqual(new Date(NOW.getTime() + 10 * 60 * 1000));
      expect(Object.values(signed.fields).every((v) => typeof v === 'string')).toBe(true);
    });

    it('P18.4-T2 asks nothing more of a PDF-only route: the pinned Content-Type already is its list (N5)', async () => {
      await upload(makeAdapter(), { allowedMimeTypes: ['application/pdf'] });
      expect(mockFile.generateSignedPostPolicyV4).toHaveBeenCalledWith(expect.objectContaining({
        fields: { 'Content-Type': 'application/pdf' },
      }));
    });

    it('P18.4-T2 passes on a signer’s refusal by status and message, never the request it carried', async () => {
      mockFile.generateSignedPostPolicyV4.mockRejectedValueOnce(
        gaxiosError(403, "Permission 'iam.serviceAccounts.signBlob' denied on resource"),
      );
      const failure = await upload().catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message)
        .toBe("Storage refused to sign the upload (403): Permission 'iam.serviceAccounts.signBlob' denied on resource");
      expect(JSON.stringify(failure)).not.toContain('ya29');
      expect(Object.keys(failure as object)).toEqual([]);
    });
  });

  describe('the link: a V4 signed read, served as the recorded type', () => {
    beforeEach(() => mockFile.getSignedUrl.mockResolvedValue(['https://storage.googleapis.com/b/k?X-Goog-Signature=abc']));

    it('P18.4-T2 signs a PDF for 300 seconds by the SDK’s clock, inline, as a PDF', async () => {
      const url = await makeAdapter().createSignedUrl('dev/k/recruitment-pitch/01ABC', 300, 'application/pdf');
      expect(url).toBe('https://storage.googleapis.com/b/k?X-Goog-Signature=abc');
      expect(mockBucketFile).toHaveBeenCalledWith('dev/k/recruitment-pitch/01ABC');
      expect(mockFile.getSignedUrl).toHaveBeenCalledWith({
        version: 'v4', action: 'read', expires: SDK_NOW + 300_000,
        responseType: 'application/pdf', responseDisposition: 'inline',
      });
    });

    it('P18.4-T2 serves a PNG uploaded as a JPEG as image/png: the recorded type, never the stored claim (review L6)', async () => {
      await makeAdapter().createSignedUrl('dev/k/events/01PNG', 300, 'image/png');
      expect(mockFile.getSignedUrl).toHaveBeenCalledWith(
        expect.objectContaining({ responseType: 'image/png', responseDisposition: 'inline' }),
      );
      // The link is signed from the recorded type alone: the object's metadata — the claim — is never read.
      expect(mockFile.getMetadata).not.toHaveBeenCalled();
      expect(mockFile.download).not.toHaveBeenCalled();
    });

    it.each(['image/jpeg', 'image/png', 'image/webp', 'video/mp4'])('P18.4-T2 opens %s inline', async (mimeType) => {
      await makeAdapter().createSignedUrl('dev/k/f/1', 300, mimeType);
      expect(mockFile.getSignedUrl).toHaveBeenCalledWith(
        expect.objectContaining({ responseType: mimeType, responseDisposition: 'inline' }),
      );
    });

    it.each([['text/csv', 'csv'], [XLSX, 'xlsx']])(
      'P18.4-T2 downloads %s as an attachment named with its extension — a key carries none',
      async (mimeType, extension) => {
        await makeAdapter().createSignedUrl('dev/k/uploads/01ROSTER', 60, mimeType);
        expect(mockFile.getSignedUrl).toHaveBeenCalledWith(expect.objectContaining({
          expires: SDK_NOW + 60_000, responseType: mimeType,
          responseDisposition: `attachment; filename="01ROSTER.${extension}"`,
        }));
      },
    );

    it('P18.4-T2 never renders a type nobody recorded or accepts: an attachment, under the platform’s lifetime by default', async () => {
      await makeAdapter().createSignedUrl('dev/k/f/1');
      expect(mockFile.getSignedUrl).toHaveBeenLastCalledWith({
        version: 'v4', action: 'read', expires: SDK_NOW + ASSET_LIMITS.SIGNED_URL_TTL_SECONDS * 1000,
        responseDisposition: 'attachment',
      });
      await makeAdapter().createSignedUrl('dev/k/f/2', 300, 'application/xhtml+xml');
      expect(mockFile.getSignedUrl).toHaveBeenLastCalledWith(
        expect.objectContaining({ responseType: 'application/xhtml+xml', responseDisposition: 'attachment' }),
      );
    });

    it('P19.6-T2 AC-2 serves an HTML file inline as text/html, from the storage host, for 300 seconds (ADR-0217 §3)', async () => {
      const url = await makeAdapter().createSignedUrl('dev/k/training/01LESSON', 300, 'text/html');
      expect(mockFile.getSignedUrl).toHaveBeenLastCalledWith({
        version: 'v4', action: 'read', expires: SDK_NOW + 300_000,
        responseType: 'text/html', responseDisposition: 'inline',
      });
      // The signed link is storage's own host: never a path of the app's origin, never proxied by the API.
      expect(new URL(url).origin).toBe('https://storage.googleapis.com');
    });

    it('P18.4-T2 passes on a refused signature by status and message alone', async () => {
      mockFile.getSignedUrl.mockRejectedValueOnce(gaxiosError(401, 'invalid_grant'));
      await expect(makeAdapter().createSignedUrl('dev/k/f/1', 300, 'application/pdf'))
        .rejects.toThrow(/^Storage refused to sign the link \(401\): invalid_grant$/);
    });
  });

  describe('confirming what the bucket holds (ADR-0040): the size from metadata, the type from the bytes', () => {
    it('P18.4-T2 reports the claimed type when the first 4 KB bear it out, and the stored size', async () => {
      holds(PDF_BYTES, 'application/pdf', 2048);
      await expect(makeAdapter().describe('dev/kpm-1/training/01ABC')).resolves.toEqual({
        storageKey: 'dev/kpm-1/training/01ABC', mimeType: 'application/pdf', bytes: 2048,
      });
      expect(mockFile.download).toHaveBeenCalledWith({ start: 0, end: 4095 });
    });

    it('P18.4-T2 reports an accepted type as what its bytes are, not what the form claimed (review L6)', async () => {
      // A PNG saved as .jpg: the policy pinned `image/jpeg`, and storage keeps that claim as the object's metadata.
      holds(PNG_BYTES, 'image/jpeg', 1_048_576);
      await expect(makeAdapter().describe('dev/kpm-1/events/01PNG')).resolves.toEqual({
        storageKey: 'dev/kpm-1/events/01PNG', mimeType: 'image/png', bytes: 1_048_576,
      });
      holds(JPEG_BYTES, 'application/pdf');
      await expect(makeAdapter().describe('dev/kpm-1/products/01JPG')).resolves.toMatchObject({ mimeType: 'image/jpeg' });
    });

    it('P18.4-T2 reports an executable claimed as a PDF as application/octet-stream, which the allow-list refuses', async () => {
      holds(EXE_BYTES, 'application/pdf', 4_000_000);
      const found = await makeAdapter().describe('dev/kpm-1/recruitment-pitch/01EXE');
      expect(found).toEqual({ storageKey: 'dev/kpm-1/recruitment-pitch/01EXE', mimeType: 'application/octet-stream', bytes: 4_000_000 });
      expect(ASSET_LIMITS.ALLOWED_MIME_TYPES).not.toContain(found!.mimeType);
    });

    it('P18.4-T2 reads nothing of an empty object, and an object with no metadata is nothing it accepts', async () => {
      mockFile.getMetadata.mockResolvedValueOnce([{}, {}]);
      await expect(makeAdapter().describe('dev/k/f/empty')).resolves.toEqual({
        storageKey: 'dev/k/f/empty', mimeType: 'application/octet-stream', bytes: 0,
      });
      expect(mockFile.download).not.toHaveBeenCalled();
    });

    it('P18.4-T2 answers null when the bytes never arrived (404), and reads nothing', async () => {
      mockFile.getMetadata.mockRejectedValueOnce(apiError(404, 'No such object: agencyboost-staging-assets/dev/k/f/1'));
      await expect(makeAdapter().describe('dev/k/f/1')).resolves.toBeNull();
      expect(mockFile.download).not.toHaveBeenCalled();
    });

    it('P18.4-T2 never reads a real failure as "the file is not there", and passes on no more than its status and message', async () => {
      mockFile.getMetadata.mockRejectedValueOnce(gaxiosError(403, 'api-runtime does not have storage.objects.get access'));
      const failure = await makeAdapter().describe('dev/k/f/1').catch((e: unknown) => e);
      expect((failure as Error).message).toBe('Storage refused the lookup (403): api-runtime does not have storage.objects.get access');
      expect(JSON.stringify(failure)).not.toContain('ya29');
    });

    it('P18.4-T2 reads a status from wherever the vendor put it, and says so when there is none', async () => {
      mockFile.getMetadata.mockRejectedValueOnce(Object.assign(new Error('Service Unavailable'), { status: 503 }));
      await expect(makeAdapter().describe('k')).rejects.toThrow('Storage refused the lookup (503): Service Unavailable');
      mockFile.getMetadata.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
      await expect(makeAdapter().describe('k')).rejects.toThrow('Storage refused the lookup (no status): socket hang up');
      mockFile.getMetadata.mockRejectedValueOnce(undefined);
      await expect(makeAdapter().describe('k')).rejects.toThrow('Storage refused the lookup (no status): no message');
      mockFile.getMetadata.mockRejectedValueOnce({ code: 500, message: '' });
      await expect(makeAdapter().describe('k')).rejects.toThrow('Storage refused the lookup (500): no message');
    });

    it('P18.4-T2 passes on a failed read of the first bytes, sanitized', async () => {
      mockFile.getMetadata.mockResolvedValueOnce([{ size: 10, contentType: 'application/pdf' }, {}]);
      mockFile.download.mockRejectedValueOnce(gaxiosError(500, 'Backend Error'));
      await expect(makeAdapter().describe('k')).rejects.toThrow(/^Storage refused the read \(500\): Backend Error$/);
    });
  });

  describe('the confirm step over the adapter: the bytes decide the type, the route’s list decides the file (review L6)', () => {
    /** The asset service over this adapter, with a registry row the browser's signature wrote. */
    function confirming() {
      const updateById = jest.fn(async (_c: unknown, _id: string, u: { $set: Record<string, unknown> }) => u.$set);
      const assets = { findOne: jest.fn(async () => ({ _id: 'a1', uploadState: 'pending' })), updateById };
      const service = new AssetService(assets as never, makeAdapter(), new FixedClock(NOW));
      return { service, updateById, ctx: { kpmId: 'kpm-0417' } as never };
    }

    it('P18.4-T2 a PNG claimed as a JPEG, on an image route: accepted, and recorded as image/png', async () => {
      holds(PNG_BYTES, 'image/jpeg', 2048);
      const { service, updateById, ctx } = confirming();
      await service.confirmUpload(ctx, 'dev/kpm-0417/events/01PNG');
      expect(updateById.mock.calls[0][2].$set).toEqual({ mimeType: 'image/png', bytes: 2048, uploadState: 'confirmed' });
    });

    it('P18.4-T2 a JPEG on a PDF-only route: refused 415, and nothing recorded', async () => {
      holds(JPEG_BYTES, 'application/pdf');
      const { service, updateById, ctx } = confirming();
      const failure = await service.confirmUpload(ctx, 'dev/kpm-0417/products/01JPG', DOCUMENT_MIME_TYPES).catch((e: unknown) => e);
      expect(failure).toMatchObject({ code: ErrorCode.ASSET_TYPE_NOT_ALLOWED, details: { mimeType: 'image/jpeg' } });
      expect((failure as { getStatus(): number }).getStatus()).toBe(HttpStatus.UNSUPPORTED_MEDIA_TYPE);
      expect(updateById).not.toHaveBeenCalled();
    });

    it.each([
      ['the whole allow-list', ASSET_LIMITS.ALLOWED_MIME_TYPES],
      ['a PDF-only route', DOCUMENT_MIME_TYPES],
    ])('P18.4-T2 an .exe claimed as a PDF, on %s: refused 415 as octet-stream, and nothing recorded', async (_route, allowed) => {
      holds(EXE_BYTES, 'application/pdf');
      const { service, updateById, ctx } = confirming();
      await expect(service.confirmUpload(ctx, 'dev/kpm-0417/recruitment-pitch/01EXE', allowed))
        .rejects.toMatchObject({ code: ErrorCode.ASSET_TYPE_NOT_ALLOWED, details: { mimeType: 'application/octet-stream' } });
      expect(updateById).not.toHaveBeenCalled();
    });
  });

  describe('copying into another owner’s folder (P13.2-T7, ADR-0115 §6)', () => {
    const params = { storageKey: 'dev/kpm-0417/training/01SOURCE', owner: { kind: 'company', companyId: 'co-2' } as const, folder: 'training' };

    it('P18.4-T2 copies server side, create-only, into a fresh key in the destination’s folder, and reports what landed', async () => {
      mockFile.copy.mockResolvedValueOnce([{}, {}]);
      holds(PDF_BYTES, 'application/pdf', 812);
      const copied = await makeAdapter().copy(params);
      expect(copied.storageKey).toMatch(new RegExp(`^dev/company/co-2/training/${ULID.source}$`));
      expect(copied).toMatchObject({ mimeType: 'application/pdf', bytes: 812 });
      expect(mockBucketFile.mock.calls[0][0]).toBe('dev/kpm-0417/training/01SOURCE');
      const [destination, options] = mockFile.copy.mock.calls[0];
      expect(destination.name).toBe(copied.storageKey);
      expect(options).toEqual({ preconditionOpts: { ifGenerationMatch: 0 } });
      // The copy is described as an upload is: its size, and its type from its bytes.
      expect(mockBucketFile).toHaveBeenLastCalledWith(copied.storageKey);
      expect(mockFile.download).toHaveBeenCalledWith({ start: 0, end: 4095 });
    });

    it('P18.4-T2 refuses to copy a key that holds nothing', async () => {
      mockFile.copy.mockRejectedValueOnce(apiError(404, 'No such object'));
      await expect(makeAdapter().copy(params)).rejects.toThrow('Storage holds nothing under dev/kpm-0417/training/01SOURCE, so it cannot be copied.');
      expect(mockFile.getMetadata).not.toHaveBeenCalled();
    });

    it('P18.4-T2 lets any other refusal through, so a copy that did not happen is never reported as one', async () => {
      mockFile.copy.mockRejectedValueOnce(gaxiosError(412, 'At least one of the pre-conditions you specified did not hold.'));
      await expect(makeAdapter().copy(params))
        .rejects.toThrow('Storage refused the copy (412): At least one of the pre-conditions you specified did not hold.');
    });

    it('P18.4-T2 does not report a copy the bucket then cannot find', async () => {
      mockFile.copy.mockResolvedValueOnce([{}, {}]);
      mockFile.getMetadata.mockRejectedValueOnce(apiError(404, 'No such object'));
      await expect(makeAdapter().copy(params)).rejects.toThrow(/reported the copy to dev\/company\/co-2\/training\/.+ and then held nothing there/);
    });
  });

  describe('a server-held file (Phase 17, D-seed)', () => {
    const pdf = Buffer.from('%PDF-1.4 demonstration', 'latin1');
    const params = {
      owner: { kind: 'kpm', kpmId: 'kpm-0417' } as const, folder: 'recruitment-pitch',
      name: 'opportunity-demonstration', mimeType: 'application/pdf', body: pdf,
    };
    const KEY = 'dev/kpm-0417/recruitment-pitch/opportunity-demonstration';

    it('P18.4-T2 writes it once, create-only and not resumable, under a key named for it, and reports what landed', async () => {
      mockFile.getMetadata
        .mockRejectedValueOnce(apiError(404, 'No such object'))
        .mockResolvedValueOnce([{ size: String(pdf.length), contentType: 'application/pdf' }, {}]);
      mockFile.download.mockResolvedValueOnce([pdf]);
      mockFile.save.mockResolvedValueOnce(undefined);
      await expect(makeAdapter().putObject(params)).resolves.toEqual({
        storageKey: KEY, mimeType: 'application/pdf', bytes: pdf.length, sent: true,
      });
      expect(mockFile.save).toHaveBeenCalledWith(pdf, {
        contentType: 'application/pdf', resumable: false, preconditionOpts: { ifGenerationMatch: 0 },
      });
      expect(new Set(mockBucketFile.mock.calls.map(([key]) => key))).toEqual(new Set([KEY]));
    });

    it('P18.4-T2 describes a key the bucket already holds and sends nothing, so a re-seed uploads nothing', async () => {
      holds(pdf, 'application/pdf');
      await expect(makeAdapter().putObject(params)).resolves.toEqual({
        storageKey: KEY, mimeType: 'application/pdf', bytes: pdf.length, sent: false,
      });
      expect(mockFile.save).not.toHaveBeenCalled();
    });

    it('P18.4-T2 takes a 412 — written in between — as already there: sent false, and what is there', async () => {
      mockFile.getMetadata
        .mockRejectedValueOnce(apiError(404, 'No such object'))
        .mockResolvedValueOnce([{ size: '900', contentType: 'application/pdf' }, {}]);
      mockFile.download.mockResolvedValueOnce([pdf]);
      mockFile.save.mockRejectedValueOnce(apiError(412, 'At least one of the pre-conditions you specified did not hold.'));
      await expect(makeAdapter().putObject({ ...params, owner: { kind: 'company', companyId: 'co-1' } })).resolves.toEqual({
        storageKey: 'dev/company/co-1/recruitment-pitch/opportunity-demonstration', mimeType: 'application/pdf', bytes: 900, sent: false,
      });
    });

    it('P18.4-T2 lets any other refusal through, sanitized', async () => {
      mockFile.getMetadata.mockRejectedValueOnce(apiError(404, 'No such object'));
      mockFile.save.mockRejectedValueOnce(gaxiosError(403, 'api-runtime does not have storage.objects.create access'));
      const failure = await makeAdapter().putObject(params).catch((e: unknown) => e);
      expect((failure as Error).message).toBe('Storage refused the write (403): api-runtime does not have storage.objects.create access');
      expect(JSON.stringify(failure)).not.toContain('ya29');
    });

    it('P18.4-T2 does not report a write the bucket then cannot find', async () => {
      mockFile.getMetadata.mockRejectedValue(apiError(404, 'No such object'));
      mockFile.save.mockResolvedValueOnce(undefined);
      await expect(makeAdapter().putObject(params)).rejects.toThrow(`Storage accepted ${KEY} and then held nothing there.`);
    });
  });

  describe('reading an object’s bytes (P19.6-T1; ADR-0218 §2, §4)', () => {
    it('P19.6-T1 reads the size first and then the whole object, under the key it was given', async () => {
      holds(PNG_BYTES, 'image/png');
      await expect(makeAdapter().read('dev/kpm-1/branding/01PNG', 1024)).resolves.toEqual(PNG_BYTES);
      expect(mockBucketFile).toHaveBeenCalledWith('dev/kpm-1/branding/01PNG');
      expect(mockFile.download).toHaveBeenCalledWith();
    });

    it('P19.6-T1 reads an object exactly at the ceiling, and one whose metadata carries no size', async () => {
      holds(PNG_BYTES, 'image/png', PNG_BYTES.length);
      await expect(makeAdapter().read('k', PNG_BYTES.length)).resolves.toEqual(PNG_BYTES);
      mockFile.getMetadata.mockResolvedValueOnce([{}, {}]);
      await expect(makeAdapter().read('k', 0)).resolves.toEqual(PNG_BYTES);
    });

    it('P19.6-T1 answers null when the lookup finds nothing (404), and downloads nothing', async () => {
      mockFile.getMetadata.mockRejectedValueOnce(apiError(404, 'No such object: agencyboost-staging-assets/k'));
      await expect(makeAdapter().read('k', 1024)).resolves.toBeNull();
      expect(mockFile.download).not.toHaveBeenCalled();
    });

    it('P19.6-T1 passes on any other refused lookup, sanitized, and downloads nothing', async () => {
      mockFile.getMetadata.mockRejectedValueOnce(gaxiosError(403, 'api-runtime does not have storage.objects.get access'));
      const failure = await makeAdapter().read('k', 1024).catch((e: unknown) => e);
      expect((failure as Error).message).toBe('Storage refused the lookup (403): api-runtime does not have storage.objects.get access');
      expect(JSON.stringify(failure)).not.toContain('ya29');
      expect(mockFile.download).not.toHaveBeenCalled();
    });

    it('P19.6-T1 throws for an object over maxBytes without downloading it', async () => {
      holds(PNG_BYTES, 'image/png', 2048);
      await expect(makeAdapter().read('dev/k/f/big', 1024))
        .rejects.toThrow('Storage holds 2048 bytes under dev/k/f/big, over the 1024 it may read.');
      expect(mockFile.download).not.toHaveBeenCalled();
    });

    it('P19.6-T1 answers null when the object went between the lookup and the download (404)', async () => {
      mockFile.getMetadata.mockResolvedValueOnce([{ size: '10', contentType: 'image/png' }, {}]);
      mockFile.download.mockRejectedValueOnce(apiError(404, 'No such object'));
      await expect(makeAdapter().read('k', 1024)).resolves.toBeNull();
    });

    it('P19.6-T1 passes on any other refused download, sanitized', async () => {
      mockFile.getMetadata.mockResolvedValueOnce([{ size: '10', contentType: 'image/png' }, {}]);
      mockFile.download.mockRejectedValueOnce(gaxiosError(500, 'Backend Error'));
      await expect(makeAdapter().read('k', 1024)).rejects.toThrow(/^Storage refused the read \(500\): Backend Error$/);
    });
  });

  describe('removing (nothing calls it at runtime; the runtime signer cannot delete)', () => {
    it('P18.4-T2 deletes the object, an object already gone being no error', async () => {
      mockFile.delete.mockResolvedValueOnce([{}]);
      await makeAdapter().remove('dev/k/f/1');
      expect(mockBucketFile).toHaveBeenCalledWith('dev/k/f/1');
      expect(mockFile.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
    });

    it('P18.4-T2 passes on the create-only signer’s 403, sanitized', async () => {
      mockFile.delete.mockRejectedValueOnce(gaxiosError(403, 'api-runtime does not have storage.objects.delete access'));
      await expect(makeAdapter().remove('dev/k/f/1'))
        .rejects.toThrow(/^Storage refused the delete \(403\): api-runtime does not have storage.objects.delete access$/);
    });
  });

  describe('storageRefusal', () => {
    it('P18.4-T2 keeps a status and a message, and drops everything else the vendor carried', () => {
      expect(storageRefusal(gaxiosError(401, 'invalid_grant'))).toEqual({ httpCode: 401, message: 'invalid_grant' });
      expect(storageRefusal(apiError(404, 'No such object'))).toEqual({ httpCode: 404, message: 'No such object' });
      expect(storageRefusal(null)).toEqual({ httpCode: undefined, message: 'no message' });
      expect(storageRefusal({ message: 42 })).toEqual({ httpCode: undefined, message: 'no message' });
    });
  });
});
