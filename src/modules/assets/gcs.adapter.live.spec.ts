import { ulid } from 'ulid';
import { SystemClock } from '@/common/clock/clock.port';
import { ErrorCode } from '@/common/errors/error-codes';
import { ASSET_LIMITS } from '@/domain/constants';
import { AssetService } from './asset.service';
import { GcsAdapter } from './gcs.adapter';
import { SignedUpload } from './storage.port';

/**
 * **The adapter against a real bucket** (P18.4-T2, ADR-0153; the plan's *Verifikasi → GCS*). Opt-in: nothing but
 * `pnpm test:storage-live` runs it — `jest.config.ts` and `test:unit` ignore `*.live.spec.ts`, so it is never part
 * of `pnpm test`, `test:unit` or `test:coverage`, and CI never reaches a bucket.
 *
 *   gcloud auth application-default login \
 *     --impersonate-service-account=api-runtime@<project>.iam.gserviceaccount.com
 *   GCS_LIVE_BUCKET=agencyboost-staging-assets pnpm test:storage-live
 *
 * **Run it as the runtime signer, not as yourself.** It proves the signer is create-only — a replayed form is
 * refused — and an identity that may delete (an owner, `storage.objectAdmin`) can overwrite, so that case would
 * fail for the right reason: the credentials are not the ones production runs with.
 *
 * Everything it writes lands under `<GCS_LIVE_PREFIX, default dev>/live-test-<run>/…` and
 * `<prefix>/company/live-test-<run>/…`, and stays there: the signer cannot delete. Clear it afterwards with an
 * identity that may: `gcloud storage rm -r "gs://<bucket>/dev/live-test-*" "gs://<bucket>/dev/company/live-test-*"`.
 * Node sends no `Origin`, so the bucket's CORS is not exercised here; the browser walk in the runbook does that.
 */
const BUCKET = process.env.GCS_LIVE_BUCKET?.trim();
const PREFIX = process.env.GCS_LIVE_PREFIX?.trim() || 'dev';
const RUN = `live-test-${ulid().toLowerCase()}`;
const NETWORK_MS = 60_000;

if (!BUCKET) {
  console.warn(
    'P18.4-T2 storage-live: skipped — GCS_LIVE_BUCKET is not set. Set it to a bucket, with Application Default '
    + 'Credentials impersonating the runtime signer, to run the suite against real storage.',
  );
}
const live = BUCKET ? describe : describe.skip;

/** A one-page PDF's opening bytes are enough: the sniff reads the header, and storage keeps what it is sent. */
const PDF = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n', 'latin1');
/** An executable's opening bytes: the DOS header, NULs and all. */
const EXE = Buffer.concat([
  Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00]),
  Buffer.from('This program cannot be run in DOS mode.\r\n', 'latin1'),
]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The form exactly as the app's `signedUploadForm` builds it: every signed field first, then `file`. */
function post(signed: SignedUpload, body: Buffer, filename: string, fields = signed.fields): Promise<Response> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  form.append('file', new Blob([new Uint8Array(body)]), filename);
  return fetch(signed.uploadUrl, { method: 'POST', body: form });
}

live('P18.4-T2 GcsAdapter against a real bucket (opt-in, `pnpm test:storage-live`)', () => {
  const clock = new SystemClock();
  let adapter: GcsAdapter;
  // Built here, not in the describe body, which runs even when the suite is skipped.
  beforeAll(() => {
    const values: Record<string, string> = { GCS_BUCKET: BUCKET!, STORAGE_KEY_PREFIX: PREFIX };
    const config = {
      get: (k: string) => values[k],
      getOrThrow: (k: string) => {
        if (!(k in values)) throw new Error(`${k} is not set.`);
        return values[k];
      },
    };
    adapter = new GcsAdapter(config as never, clock);
  });
  const owner = { kind: 'kpm', kpmId: RUN } as const;
  const sign = (mimeType = 'application/pdf') =>
    adapter.createSignedUpload({ owner, folder: 'live', filename: 'live.pdf', mimeType });
  /** The PDF the first case uploads; the replay, the links and the copy read it. */
  let uploaded: SignedUpload;

  it('P18.4-T2 an upload through the signed form answers 204, and lands as what it is', async () => {
    uploaded = await sign();
    expect(uploaded.storageKey).toMatch(new RegExp(`^${PREFIX}/${RUN}/live/[0-9A-HJKMNP-TV-Z]{26}$`));
    const res = await post(uploaded, PDF, 'Opportunity_Overview.pdf');
    expect(res.status).toBe(204);
    await expect(adapter.describe(uploaded.storageKey)).resolves.toEqual({
      storageKey: uploaded.storageKey, mimeType: 'application/pdf', bytes: PDF.length,
    });
  }, NETWORK_MS);

  it('P18.4-T2 the same form replayed is refused 403: the create-only signer cannot replace an object', async () => {
    const replay = await post(uploaded, EXE, 'replay.pdf');
    expect(replay.status).toBe(403);
    // And what was there is still there.
    await expect(adapter.describe(uploaded.storageKey)).resolves.toMatchObject({ mimeType: 'application/pdf', bytes: PDF.length });
  }, NETWORK_MS);

  it('P18.4-T2 a 26 MB file is refused by the policy’s content-length-range, and nothing lands', async () => {
    const signed = await sign();
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.alloc(26 * 1024 * 1024, 0x20)]);
    expect(big.length).toBeGreaterThan(ASSET_LIMITS.MAX_BYTES);
    const res = await post(signed, big, 'too-big.pdf');
    // Storage answers `400 EntityTooLarge`; a 4xx of any kind, with nothing stored, is the guarantee.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    await expect(adapter.describe(signed.storageKey)).resolves.toBeNull();
  }, 3 * NETWORK_MS);

  it('P18.4-T2 a form whose Content-Type differs from the signed one is refused 403, and nothing lands', async () => {
    const signed = await sign('application/pdf');
    const res = await post(signed, PNG, 'poster.png', { ...signed.fields, 'Content-Type': 'image/png' });
    expect(res.status).toBe(403);
    await expect(adapter.describe(signed.storageKey)).resolves.toBeNull();
  }, NETWORK_MS);

  it('P18.4-T2 an executable renamed .pdf uploads, and is refused at confirm: its bytes are no PDF', async () => {
    const signed = await sign('application/pdf');
    expect((await post(signed, EXE, 'Opportunity_Overview.pdf')).status).toBe(204);
    await expect(adapter.describe(signed.storageKey)).resolves.toEqual({
      storageKey: signed.storageKey, mimeType: 'application/octet-stream', bytes: EXE.length,
    });
    // The confirm step itself, as a company upload's runs it: refused, and nothing recorded as confirmed.
    const updateCompanyAsset = jest.fn();
    const assets = { findCompanyAsset: async () => ({ storageKey: signed.storageKey }), updateCompanyAsset };
    const service = new AssetService(assets as never, adapter, clock);
    await expect(service.confirmCompanyUpload(RUN, signed.storageKey))
      .rejects.toMatchObject({ code: ErrorCode.ASSET_TYPE_NOT_ALLOWED });
    expect(updateCompanyAsset).not.toHaveBeenCalled();
  }, NETWORK_MS);

  it('P18.4-T2 a PNG uploaded as a JPEG is confirmed as image/png, and its link serves image/png over the stored claim (review L6)', async () => {
    const signed = await sign('image/jpeg');
    expect((await post(signed, PNG, 'IMG-20261019-WA0001.jpg')).status).toBe(204);
    const stored = await adapter.describe(signed.storageKey);
    expect(stored).toEqual({ storageKey: signed.storageKey, mimeType: 'image/png', bytes: PNG.length });
    // The object's metadata still holds the claim, `image/jpeg`; the link names the confirmed type and storage obeys it.
    const opened = await fetch(await adapter.createSignedUrl(signed.storageKey, 300, stored!.mimeType));
    expect(opened.status).toBe(200);
    expect(opened.headers.get('content-type')).toBe('image/png');
  }, NETWORK_MS);

  it('P18.4-T2 a link opens the file inline as a PDF while it lives, and is refused once it has expired', async () => {
    const opened = await fetch(await adapter.createSignedUrl(uploaded.storageKey, ASSET_LIMITS.SIGNED_URL_TTL_SECONDS, 'application/pdf'));
    expect(opened.status).toBe(200);
    expect(opened.headers.get('content-type')).toBe('application/pdf');
    expect(opened.headers.get('content-disposition')).toBe('inline');
    expect(Buffer.from(await opened.arrayBuffer()).equals(PDF)).toBe(true);

    const short = await adapter.createSignedUrl(uploaded.storageKey, 1, 'application/pdf');
    await sleep(3_000);
    const expired = await fetch(short);
    // The plan's runbook expects 403; Cloud Storage documents an expired V4 signature as `ExpiredToken`, which it
    // has answered as 400. Either refuses the read — which is the guarantee — and the first live run settles which.
    expect([400, 403]).toContain(expired.status);
    expect(await expired.text()).toMatch(/expired/i);
  }, NETWORK_MS);

  it('P18.4-T2 a copy lands in the destination’s folder under a fresh key, as what the source is', async () => {
    const copied = await adapter.copy({
      storageKey: uploaded.storageKey, owner: { kind: 'company', companyId: RUN }, folder: 'training',
    });
    expect(copied.storageKey).toMatch(new RegExp(`^${PREFIX}/company/${RUN}/training/[0-9A-HJKMNP-TV-Z]{26}$`));
    expect(copied).toMatchObject({ mimeType: 'application/pdf', bytes: PDF.length });
    await expect(adapter.describe(copied.storageKey)).resolves.toEqual(copied);
  }, NETWORK_MS);

  it('P18.4-T2 putObject is idempotent: the second run sends nothing and reports what the first stored', async () => {
    const params = { owner, folder: 'live', name: 'opportunity-demonstration', mimeType: 'application/pdf', body: PDF };
    const first = await adapter.putObject(params);
    expect(first).toEqual({
      storageKey: `${PREFIX}/${RUN}/live/opportunity-demonstration`, mimeType: 'application/pdf', bytes: PDF.length, sent: true,
    });
    await expect(adapter.putObject(params)).resolves.toEqual({ ...first, sent: false });
  }, NETWORK_MS);
});
