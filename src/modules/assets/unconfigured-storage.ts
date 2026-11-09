import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { ASSETS_REFUSALS } from './assets.messages';
import { SignedUpload, StoragePort, StoredObject } from './storage.port';

/**
 * **Storage where there is none** (P18.4-T2, plan decision D12): bound when `GCS_BUCKET` is unset, which
 * `env.validation.ts` allows only for `NODE_ENV` `development` or `test`. A developer's API boots and every screen
 * works without a bucket; whatever needs one — an upload's signature, a file's link, a template copy that carries
 * files — is refused with `STORAGE_NOT_CONFIGURED`, before anything is written (the asset service signs before it
 * registers a row).
 *
 * **Why `503` and not `501`.** The request is well formed and the route exists and works in every deployed
 * environment of this same build; what is missing is a dependency of *this instance*, which is an operator's
 * condition, not the client's (so not a `4xx`). `503 Service Unavailable` says exactly that. `501 Not Implemented`
 * says the server does not support the functionality at all, which a configured instance of the same code
 * contradicts — and a client treating `501` as permanent would be right to stop asking.
 */
export class UnconfiguredStorage extends StoragePort {
  private refuse(): never {
    throw new DomainException(
      ErrorCode.STORAGE_NOT_CONFIGURED,
      ASSETS_REFUSALS.STORAGE_NOT_CONFIGURED.noStorage,
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  async createSignedUpload(): Promise<SignedUpload> {
    return this.refuse();
  }

  async createSignedUrl(): Promise<string> {
    return this.refuse();
  }

  async describe(): Promise<StoredObject | null> {
    return this.refuse();
  }

  async remove(): Promise<void> {
    return this.refuse();
  }

  async read(): Promise<Buffer | null> {
    return this.refuse();
  }

  async copy(): Promise<StoredObject> {
    return this.refuse();
  }

  async putObject(): Promise<StoredObject & { sent: boolean }> {
    return this.refuse();
  }
}
