import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AVATAR } from '@/domain/constants';
import { ASSETS_REFUSALS } from '@/modules/assets/assets.messages';
import { SignedUpload, StoragePort } from '@/modules/assets/storage.port';
import { AUTH_REFUSALS } from '@/modules/auth/auth.messages';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import { User, UserDocument } from './user.schema';
import { USERS_REFUSALS } from './users.messages';

/** The folder a person's photo lands in, under their own `user/<userId>` (UI-111). */
export const AVATAR_FOLDER = 'avatar';

/** A ULID: what every key storage mints ends in (`gcs.adapter.ts`). */
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * **Whether a storage key is a photo this person uploaded** (UI-111): `<prefix>/user/<userId>/avatar/<ulid>`, and
 * nothing else. The key comes back from the browser, so it is a claim: a key in an office's folder, the company's, or
 * another person's is not theirs to attach, whatever storage holds under it. **The prefix is checked too** (the Phase
 * 18.11 exit review, L5): it is this environment's (`STORAGE_KEY_PREFIX`, the key `gcs.adapter.ts` mints), so a key
 * another environment minted — staging's, in a bucket two environments share — is not this account's photo either.
 */
export function isOwnAvatarKey(storageKey: string, userId: string, prefix: string): boolean {
  const mine = `${prefix}/user/${userId}/${AVATAR_FOLDER}/`;
  return storageKey.startsWith(mine) && ULID.test(storageKey.slice(mine.length));
}

/*
 * `AvatarLinks` is declared before `AvatarService`, which takes it in its constructor: a decorated class's parameter
 * types are read when it is defined, and a class declared later in the module is not there yet.
 */
/**
 * **The signed link a photo is drawn through** (UI-111; `AVATAR.URL_TTL_SECONDS`). The bucket is private
 * (ADR-0153), so a read that draws somebody's photo turns the key on `users.avatarUrl` into a link here — `GET
 * /auth/me` for the title row and the *Lainnya* sheet, the group tree's rows, the forum's leaders.
 *
 * **One signature per photo per half day, per process**: a link is kept until `URL_RENEW_SECONDS` before it ends, so a
 * roster read signs nothing it signed an hour ago (each signature is a call to IAM, `gcs.adapter.ts`), and a browser
 * finds the same address and keeps the picture it holds. **A photo that cannot be signed is no photo**: the reader
 * draws initials (`null`), and the read that wanted it still answers — a storage outage, or a server with no
 * storage configured, never takes `/auth/me` down with it.
 */
@Injectable()
export class AvatarLinks {
  private readonly logger = new Logger(AvatarLinks.name);
  private readonly cache = new Map<string, { url: string; renewAt: number }>();

  constructor(
    private readonly storage: StoragePort,
    private readonly clock: Clock,
  ) {}

  /** The link for one stored photo, or `null` for none. */
  async linkFor(storageKey: string | null | undefined): Promise<string | null> {
    if (!storageKey) return null;
    const now = this.clock.now().getTime();
    const held = this.cache.get(storageKey);
    if (held && held.renewAt > now) return held.url;
    try {
      const url = await this.storage.createSignedUrl(storageKey, AVATAR.URL_TTL_SECONDS, AVATAR.MIME_TYPES[0]);
      this.cache.set(storageKey, { url, renewAt: now + (AVATAR.URL_TTL_SECONDS - AVATAR.URL_RENEW_SECONDS) * 1000 });
      return url;
    } catch (err) {
      this.logger.warn(`A profile photo could not be signed; initials drawn instead: ${(err as Error).message}`);
      return null;
    }
  }

  /** Links for many photos at once, keyed by storage key: what a roster read needs. */
  async linksFor(storageKeys: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
    const keys = [...new Set(storageKeys.filter((k): k is string => typeof k === 'string' && k !== ''))];
    const out = new Map<string, string>();
    await Promise.all(keys.map(async (key) => {
      const url = await this.linkFor(key);
      if (url) out.set(key, url);
    }));
    return out;
  }
}

/**
 * **A person's profile photo: its upload, its attachment and its removal** (UI V1, UI-111).
 *
 * The browser crops the picture to a 256 × 256 JPEG and uploads it **straight to storage** with a signed form, as
 * every upload in the product does (ADR-0153: *file bytes never transit the API*): `requestUpload` checks the claim
 * against `AVATAR` and signs a form for a fresh key under `user/<userId>/avatar/`; `attach` asks storage what landed
 * (ADR-0040: the claim is a claim — the type is read from the bytes) and only then writes the key on `users.avatarUrl`.
 * `remove` clears it. **The object stays in storage**: the runtime signer can create and read, never delete
 * (ADR-0153), and a person's erasure removes their whole `user/<userId>` folder (P20-T1).
 *
 * The person's own, and never a support session's (ADR-0162 §4): the controller refuses all three in one.
 * `users` is global identity (ADR-0002), so this reads it by the caller's own id and needs no tenant scope.
 */
@Injectable()
export class AvatarService {
  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly storage: StoragePort,
    private readonly links: AvatarLinks,
    private readonly limiter: RateLimiter,
    private readonly config: ConfigService,
  ) {}

  /**
   * A signed form for the photo, after the claim passes the photo's own ceiling and type — and **the form itself holds
   * the photo's ceiling** (`maxBytes`, the Phase 18.11 exit review, L5), so storage refuses a larger file whatever the
   * claim said. `AVATAR.UPLOADS_PER_WINDOW` forms per account per hour, refused or not, then `429 AUTH_RATE_LIMITED`:
   * every form signed may leave an object nobody attaches, and the runtime signer cannot delete one (ADR-0153).
   */
  async requestUpload(ctx: RequestContext, claim: { mimeType: string; bytes: number }): Promise<SignedUpload> {
    const retryAfter = this.limiter.check(
      `avatar-upload:${ctx.userId}`, AVATAR.UPLOADS_PER_WINDOW, AVATAR.UPLOAD_WINDOW_SECONDS,
    );
    if (retryAfter !== null) {
      throw new DomainException(
        ErrorCode.AUTH_RATE_LIMITED,
        AUTH_REFUSALS.AUTH_RATE_LIMITED.tooMany({ minutes: Math.ceil(retryAfter / 60) }),
        HttpStatus.TOO_MANY_REQUESTS,
        { retryAfterSeconds: retryAfter },
      );
    }
    refuseBeyondPhotoLimits(claim.mimeType, claim.bytes);
    return this.storage.createSignedUpload({
      owner: { kind: 'user', userId: ctx.userId },
      folder: AVATAR_FOLDER,
      filename: 'avatar.jpg',
      mimeType: claim.mimeType,
      allowedMimeTypes: AVATAR.MIME_TYPES,
      maxBytes: AVATAR.MAX_BYTES,
    });
  }

  /**
   * The uploaded photo becomes theirs: storage is asked what it holds under the key, the limits are checked against
   * that, and the key is written on their account. Answers the signed link every avatar of theirs now draws.
   */
  async attach(ctx: RequestContext, storageKey: string): Promise<{ avatarUrl: string | null }> {
    // Another folder's key is answered as one that does not exist: a 403 would say it does (404, not 403).
    if (!isOwnAvatarKey(storageKey, ctx.userId, this.config.getOrThrow<string>('STORAGE_KEY_PREFIX'))) {
      throw new NotFoundException('Asset');
    }
    const stored = await this.storage.describe(storageKey);
    if (!stored) {
      throw new DomainException(
        ErrorCode.ASSET_NOT_UPLOADED,
        ASSETS_REFUSALS.ASSET_NOT_UPLOADED.neverFinished,
        HttpStatus.CONFLICT,
        { storageKey },
      );
    }
    refuseBeyondPhotoLimits(stored.mimeType, stored.bytes);
    await this.users.updateOne({ _id: ctx.userId }, { $set: { avatarUrl: storageKey } }).exec();
    return { avatarUrl: await this.links.linkFor(storageKey) };
  }

  /** *Hapus foto*: no photo, so every avatar of theirs draws their initials again. */
  async remove(ctx: RequestContext): Promise<{ avatarUrl: null }> {
    await this.users.updateOne({ _id: ctx.userId }, { $set: { avatarUrl: null } }).exec();
    return { avatarUrl: null };
  }
}

/** The photo's ceiling and type, checked on the claim and again on what storage holds (ADR-0040). */
function refuseBeyondPhotoLimits(mimeType: string, bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > AVATAR.MAX_BYTES) {
    throw new DomainException(
      ErrorCode.ASSET_TOO_LARGE,
      USERS_REFUSALS.ASSET_TOO_LARGE.photoAtMost({ kb: AVATAR.MAX_BYTES / 1024 }),
      HttpStatus.PAYLOAD_TOO_LARGE,
      { maxBytes: AVATAR.MAX_BYTES, receivedBytes: bytes },
    );
  }
  if (!(AVATAR.MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new DomainException(
      ErrorCode.ASSET_TYPE_NOT_ALLOWED,
      ASSETS_REFUSALS.ASSET_TYPE_NOT_ALLOWED.notAccepted,
      HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      { mimeType, allowed: AVATAR.MIME_TYPES },
    );
  }
}
