import {
  AssetOwner, SignedUpload, StoragePort, StoredObject,
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
  /** Keys storage "holds". A key absent from here confirms as never having arrived. */
  private objects = new Map<string, StoredObject>();
  private next = 0;

  async createSignedUpload(params: {
    owner: AssetOwner; folder: string; filename: string; mimeType: string;
  }): Promise<SignedUpload> {
    const owner = params.owner.kind === 'kpm'
      ? params.owner.kpmId
      : `company/${params.owner.companyId}`;
    this.next += 1;
    const storageKey = `dev/${owner}/${params.folder}/${String(this.next).padStart(4, '0')}`;
    // Present from the moment a signature is issued, so the common path in a test is the
    // happy one. A test that wants "the bytes never came" calls `loseUpload`.
    this.objects.set(storageKey, {
      storageKey, mimeType: params.mimeType, bytes: 1024,
    });
    return {
      uploadUrl: 'https://upload.test',
      storageKey,
      signature: 'sig',
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

  /** Make storage report that a key holds nothing, as a dropped upload would. */
  loseUpload(storageKey: string): void {
    this.objects.delete(storageKey);
  }

  /** Make storage report something other than what the client claimed. */
  setStored(storageKey: string, object: StoredObject): void {
    this.objects.set(storageKey, object);
  }
}
