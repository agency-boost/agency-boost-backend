import {
  AssetOwner, ownerSegment, SignedUpload, StoragePort, StoredObject,
} from '@/modules/assets/storage.port';

/**
 * Storage, doubled at the port (P5-T2).
 *
 * The vendor is never reached from a test — `testing-strategy.md`, *"What we deliberately do not
 * test"*. What this has to be faithful about is the two things the service reasons over: the
 * folder a key lands in, which decides whether an asset is an office's or the company's, and
 * whether `describe` finds anything, which is the whole of the confirm step.
 */
export class StubStorage extends StoragePort {
  removed: string[] = [];
  /** Every copy made, source and destination, in order (P13.2-T7). */
  copies: { from: string; to: string }[] = [];
  /** Source keys whose copy fails, as a vendor refusing it would. */
  private failing = new Set<string>();
  /** Keys storage "holds". A key absent from here confirms as never having arrived. */
  private objects = new Map<string, StoredObject>();
  private next = 0;

  /** Every signature asked for, as the service asked — the route's narrower list included (Phase 17, N5). */
  signedWith: { folder: string; mimeType: string; allowedMimeTypes?: readonly string[] }[] = [];

  async createSignedUpload(params: {
    owner: AssetOwner; folder: string; filename: string; mimeType: string; allowedMimeTypes?: readonly string[];
  }): Promise<SignedUpload> {
    this.signedWith.push({ folder: params.folder, mimeType: params.mimeType, allowedMimeTypes: params.allowedMimeTypes });
    const owner = ownerSegment(params.owner);
    this.next += 1;
    const storageKey = `dev/${owner}/${params.folder}/${String(this.next).padStart(4, '0')}`;
    // Present from the moment a signature is issued, so the common path in a test is the
    // happy one. A test that wants "the bytes never came" calls `loseUpload`.
    this.objects.set(storageKey, {
      storageKey, mimeType: params.mimeType, bytes: 1024,
    });
    return {
      uploadUrl: 'https://storage.googleapis.com/stub-bucket/',
      storageKey,
      signature: 'sig',
      // Shaped as `GcsAdapter`'s V4 POST policy (P18.4-T2): the one key, and the Content-Type pinned to the
      // type the service checked — which is how a route's narrower list reaches storage.
      fields: {
        'Content-Type': params.mimeType,
        key: storageKey,
        'x-goog-date': '20260918T020000Z',
        'x-goog-credential': 'stub-signer@stub.iam.gserviceaccount.com/20260918/auto/storage/goog4_request',
        'x-goog-algorithm': 'GOOG4-RSA-SHA256',
        policy: 'eyJjb25kaXRpb25zIjpbXX0=',
        'x-goog-signature': 'sig',
      },
      expiresAt: new Date('2026-09-18T02:10:00Z'),
    };
  }

  async createSignedUrl(storageKey: string): Promise<string> {
    return `https://cdn.test/${storageKey}?sig=abc`;
  }

  async describe(storageKey: string): Promise<StoredObject | null> {
    return this.objects.get(storageKey) ?? null;
  }

  async remove(storageKey: string): Promise<void> {
    this.removed.push(storageKey);
    this.objects.delete(storageKey);
  }

  /**
   * A copy into another owner's folder (P13.2-T7): a key minted as an upload's is, holding what the
   * source holds. Throws for a key that holds nothing, or one `failCopyOf` named.
   */
  async copy(params: { storageKey: string; owner: AssetOwner; folder: string }): Promise<StoredObject> {
    const source = this.objects.get(params.storageKey);
    if (!source || this.failing.has(params.storageKey)) {
      throw new Error(`Storage could not copy ${params.storageKey}.`);
    }
    const owner = ownerSegment(params.owner);
    this.next += 1;
    const storageKey = `dev/${owner}/${params.folder}/${String(this.next).padStart(4, '0')}`;
    const copied = { ...source, storageKey };
    this.objects.set(storageKey, copied);
    this.copies.push({ from: params.storageKey, to: storageKey });
    return copied;
  }

  /** Every server-held file sent, by key, in order (Phase 17's seed). */
  puts: string[] = [];

  /**
   * A server-held file (Phase 17, D-seed): under `<owner>/<folder>/<name>`, as the adapter keys one — and
   * a key already held is answered as it is, `sent: false`, as the adapter answers it.
   */
  async putObject(params: {
    owner: AssetOwner; folder: string; name: string; mimeType: string; body: Buffer;
  }): Promise<StoredObject & { sent: boolean }> {
    const owner = ownerSegment(params.owner);
    const storageKey = `dev/${owner}/${params.folder}/${params.name}`;
    const held = this.objects.get(storageKey);
    if (held) return { ...held, sent: false };
    const object = { storageKey, mimeType: params.mimeType, bytes: params.body.length };
    this.objects.set(storageKey, object);
    this.bodies.set(storageKey, params.body);
    this.puts.push(storageKey);
    return { ...object, sent: true };
  }

  /** Forget every copy made and every failure planned — a spec's `beforeEach`. */
  resetCopies(): void {
    this.copies = [];
    this.failing.clear();
  }

  /** Make the copy of one source key fail, as the vendor refusing it mid-way would. */
  failCopyOf(storageKey: string): void {
    this.failing.add(storageKey);
  }

  /** Make storage report that a key holds nothing, as a dropped upload would. */
  loseUpload(storageKey: string): void {
    this.objects.delete(storageKey);
  }

  /** The bytes storage "holds" under a key, for the routes that read an object back (P19.6-T1). */
  private bodies = new Map<string, Buffer>();

  /** Make a key hold these bytes, as a browser's upload would (P19.6-T1's branding images). */
  holdBytes(storageKey: string, body: Buffer, mimeType: string): void {
    this.objects.set(storageKey, { storageKey, mimeType, bytes: body.length });
    this.bodies.set(storageKey, body);
  }

  async read(storageKey: string, maxBytes: number): Promise<Buffer | null> {
    const body = this.bodies.get(storageKey);
    if (!body) return this.objects.has(storageKey) ? Buffer.alloc(0) : null;
    if (body.length > maxBytes) throw new Error(`Storage holds ${body.length} bytes under ${storageKey}.`);
    return body;
  }

  /** Make storage report something other than what the client claimed. */
  setStored(storageKey: string, object: StoredObject): void {
    this.objects.set(storageKey, object);
  }
}
