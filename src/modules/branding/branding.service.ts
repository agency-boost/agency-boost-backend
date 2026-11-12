import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { NamedTemplate, NamedTemplateDocument } from '@/modules/config/named-template.schema';
import { ulid } from 'ulid';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import {
  DomainException, InvalidRequestException, NotFoundException, VersionConflictException,
} from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { can } from '@/modules/rbac/permissions';
import { checkFields, type CheckedFields } from '@/domain/branding/branding-fields';
import { derivePalette, type BrandingPalette, type FilledColour } from '@/domain/branding/palette';
import {
  BRANDING, BRANDING_ICON_FILES, BRANDING_MASCOT_FILE, type BrandingUploadKind, type MascotPose,
} from '@/domain/constants/branding';
import { AuditService } from '@/modules/audit/audit.service';
import { RateLimiter } from '@/modules/auth/rate-limiter';
import { ownerSegment, StoragePort, type AssetOwner, type SignedUpload } from '@/modules/assets/storage.port';
import { BrandingImageRefused, renderUpload, sizeOf, sniffImage } from './branding-images';
import { BrandingReader, fieldsOf, sessionOf, type BrandingFields, type SessionBranding, type ShownBranding } from './branding-reader';
import { BRANDING_REFUSALS } from './branding.messages';
import { KpmBrandingRepository } from './kpm-branding.repository';
import type { KpmBranding } from './kpm-branding.schema';

/** An image as the settings page previews it: its folder, and a 300-second link to the size it draws. */
export interface ImageView {
  key: string;
  url: string;
}

/** A branding's fields as the page draws them (the KPM's own, or its template's). */
export interface BrandingView {
  logo: (ImageView & { width: number; height: number }) | null;
  logoSquare: ImageView | null;
  primary: string | null;
  secondary: string | null;
  mascot: { default: ImageView; poses: Partial<Record<Exclude<MascotPose, 'default'>, ImageView>> } | null;
}

/** `GET /kpm/settings/branding`. */
export interface BrandingSettings {
  own: BrandingView | null;
  template: BrandingView | null;
  shown: SessionBranding & { source: ShownBranding['source'] };
  /** The own row's version, `0` with none: what a `PUT` and a reset send back as `expectedVersion`. */
  version: number;
  /** Whether this reader may change it: the Owner and the Admins, never in a view-as session (AC-17). */
  canWrite: boolean;
}

/** Each colour's words and fill, as the preview answers them: the field's note says when the fill is not the colour. */
export type PreviewColour = Pick<FilledColour, 'contrast' | 'ratio' | 'fill' | 'adjusted'>;

export interface PreviewAnswer {
  palette: BrandingPalette;
  primary: PreviewColour;
  secondary: PreviewColour;
}

const previewOf = ({ contrast, ratio, fill, adjusted }: FilledColour): PreviewColour => ({ contrast, ratio, fill, adjusted });

export interface ConfirmedImage {
  storageKey: string;
  width: number;
  height: number;
  previews: Record<string, string>;
}

const ORIGINALS = 'branding/originals';

/**
 * **Whether a confirm's key is an original this owner was signed for** (P19.6-T1; ADR-0218 §2):
 * `<prefix>/<ownerSegment>/branding/originals/<leaf>`, **anchored at the start** — this environment's prefix
 * (`STORAGE_KEY_PREFIX`, what `gcs.adapter.ts` mints) and this owner's folder, then one leaf. A key that only *contains*
 * the owner's folder somewhere (`dev/<another>/…/<mine>/branding/originals/…`), or another environment's, is not
 * theirs, whatever storage holds under it; `isOwnAvatarKey` checks a photo the same way.
 */
export function isOwnOriginalKey(storageKey: unknown, owner: string, prefix: string): storageKey is string {
  const mine = `${prefix}/${owner}/${ORIGINALS}/`;
  return typeof storageKey === 'string' && storageKey.startsWith(mine) && /^[^/]+$/.test(storageKey.slice(mine.length));
}

/**
 * ***Tampilan KPM***, the settings page and the template's section (P19.6-T1 AC-2 to AC-17; ADR-0218 §1 to §5, §12,
 * §13). The reads of what a KPM shows are `BrandingReader`'s; this writes, and checks, and audits.
 */
@Injectable()
export class BrandingService {
  constructor(
    private readonly rows: KpmBrandingRepository,
    private readonly reader: BrandingReader,
    private readonly storage: StoragePort,
    private readonly audit: AuditService,
    private readonly limiter: RateLimiter,
    private readonly clock: Clock,
    @InjectModel(NamedTemplate.name) private readonly named: Model<NamedTemplateDocument>,
    private readonly config: ConfigService,
  ) {}

  /** A template of this company, live, or `404`: a template's images go only into its own company's folder. */
  async requireTemplate(companyId: string, templateId: string): Promise<void> {
    const found = isValidObjectId(templateId)
      ? await this.named.exists({ _id: templateId, companyId, deletedAt: null }).exec()
      : null;
    if (!found) throw new NotFoundException('Template');
  }

  // ------------------------------------------------------------------ the KPM's page

  /** **`GET /kpm/settings/branding`**: the KPM's own fields, its template's, and what it shows. */
  async settings(ctx: RequestContext): Promise<BrandingSettings> {
    const kpmId = ctx.kpmId!;
    const shown = await this.reader.shownFor(kpmId);
    if (!shown) throw new NotFoundException('KPM');
    const own = await this.reader.ownOf(kpmId);
    const kpm = await this.kpmOf(kpmId);
    const template = kpm ? await this.reader.templateOf(kpm) : null;
    return {
      own: own ? await this.viewOf(own.fields) : null,
      // A template whose *Tampilan* sets nothing is no default: the page says AgencyBoost's.
      template: template && Object.values(template.fields).some((v) => v !== null) ? await this.viewOf(template.fields) : null,
      shown: { ...sessionOf(shown), source: shown.source },
      version: own?.version ?? 0,
      canWrite: can(ctx, 'tenant_config:write') && !ctx.isImpersonating && !ctx.impersonationReadOnly,
    };
  }

  /**
   * **`POST /kpm/settings/branding/preview`**: the palette of two colours, and each one's words and fill — every colour
   * is accepted (P19.12-T3 AC-1, AC-3; ADR-0246). Writes nothing.
   */
  preview(primary: string, secondary: string): PreviewAnswer {
    const result = derivePalette(primary, secondary);
    return { palette: result.palette, primary: previewOf(result.primary), secondary: previewOf(result.secondary) };
  }

  /**
   * **`PUT /kpm/settings/branding`** (*Simpan*): the three groups, each whole, at `expectedVersion`. A group sent as
   * `null` is cleared, and the KPM shows its template's or AgencyBoost's for it. Audited old → new (AC-15).
   */
  async save(ctx: RequestContext, input: Partial<BrandingFields> & { expectedVersion: number }): Promise<BrandingSettings> {
    const kpmId = ctx.kpmId!;
    const fields = this.checked(input, { kind: 'kpm', kpmId });
    // The wide logo's size is the stored PNG's, never the client's word; and every folder must hold what it names.
    if (fields.logo) fields.logo = { key: fields.logo.key, ...(await this.storedSize(`${fields.logo.key}/logo.png`, 'logo')) };
    if (fields.logoSquare) await this.storedSize(`${fields.logoSquare.key}/logo-square.png`, 'logoSquare');
    if (fields.mascot) {
      await this.storedSize(`${fields.mascot.default}/mascot-120.webp`, 'mascot.default');
      for (const [pose, key] of Object.entries(fields.mascot.poses)) await this.storedSize(`${key}/mascot-120.webp`, `mascot.poses.${pose}`);
    }
    const colours = fields.primary && fields.secondary ? derivePalette(fields.primary, fields.secondary) : null;
    // P19.12-T3 (ADR-0246 §3): each colour's words, their ratio and the fill they read on, as measured now.
    const contrast = colours
      ? {
        primary: { side: colours.primary.contrast, ratio: colours.primary.ratio, fill: colours.primary.fill },
        secondary: { side: colours.secondary.contrast, ratio: colours.secondary.ratio, fill: colours.secondary.fill },
      }
      : null;
    const set = { ...fields, contrast };

    const current = await this.rows.live(ctx);
    const actual = current?.version ?? 0;
    if (input.expectedVersion !== actual) throw new VersionConflictException(input.expectedVersion, actual);
    const before = current ? auditFields(fieldsOf(current as unknown as KpmBranding), current as unknown as KpmBranding) : null;
    const written = current
      ? await this.rows.writeAt(ctx, String(current._id), actual, set)
      : await this.rows.insert(ctx, set);
    if (!written) {
      const now = await this.rows.live(ctx);
      throw new VersionConflictException(input.expectedVersion, now?.version ?? 0);
    }
    await this.audit.record(ctx, {
      action: 'kpm_branding.updated',
      targetCollection: 'kpmBranding',
      targetId: String(written._id),
      before,
      after: auditFields(fields, { contrast } as KpmBranding),
    });
    return this.settings(ctx);
  }

  /**
   * **`POST /kpm/settings/branding/reset`** (*Kembalikan ke default*, acceptance 3): the own row soft-deleted, so the
   * KPM shows its template's *Tampilan*, else AgencyBoost's. Audited with what was cleared.
   */
  async reset(ctx: RequestContext, expectedVersion: number): Promise<BrandingSettings> {
    const current = await this.rows.live(ctx);
    const actual = current?.version ?? 0;
    if (expectedVersion !== actual) throw new VersionConflictException(expectedVersion, actual);
    if (current) {
      const gone = await this.rows.softDeleteAt(ctx, String(current._id), actual, this.clock.now());
      if (!gone) throw new VersionConflictException(expectedVersion, (await this.rows.live(ctx))?.version ?? 0);
      await this.audit.record(ctx, {
        action: 'kpm_branding.reset',
        targetCollection: 'kpmBranding',
        targetId: String(current._id),
        before: auditFields(fieldsOf(current as unknown as KpmBranding), current as unknown as KpmBranding),
        after: null,
      });
    }
    return this.settings(ctx);
  }

  // ------------------------------------------------------------------ uploads, the KPM's and a template's

  /**
   * **A signed form for one picture** (ADR-0218 §2): its type and size checked first, the form itself holding the 1 MB
   * ceiling. `UPLOADS_PER_WINDOW` per owner per hour, then `429`.
   */
  async requestUpload(owner: AssetOwner, claim: { kind: BrandingUploadKind; filename: string; mimeType: string; bytes: number }): Promise<SignedUpload> {
    const retry = this.limiter.check(`branding-upload:${ownerSegment(owner)}`, BRANDING.UPLOADS_PER_WINDOW, BRANDING.UPLOAD_WINDOW_SECONDS);
    if (retry !== null) {
      throw new DomainException(ErrorCode.AUTH_RATE_LIMITED, BRANDING_REFUSALS.AUTH_RATE_LIMITED.tooMany, HttpStatus.TOO_MANY_REQUESTS, { retryAfterSeconds: retry });
    }
    refuseType(claim.kind, claim.mimeType);
    refuseSize(claim.bytes);
    return this.storage.createSignedUpload({
      owner,
      folder: ORIGINALS,
      filename: claim.filename,
      mimeType: claim.mimeType,
      allowedMimeTypes: BRANDING.MIME_TYPES[claim.kind],
      maxBytes: BRANDING.IMAGE_MAX_BYTES,
    });
  }

  /**
   * **The confirm** (ADR-0040, ADR-0218 §2): the stored bytes are read whole, typed from themselves, checked, and made
   * into the sizes, which are stored in a folder of their own. What it answers is what a `PUT` names.
   */
  async confirmUpload(owner: AssetOwner, input: { kind: BrandingUploadKind; storageKey: string; mimeType?: string }): Promise<ConfirmedImage> {
    if (!isOwnOriginalKey(input.storageKey, ownerSegment(owner), this.config.getOrThrow<string>('STORAGE_KEY_PREFIX'))) {
      throw new InvalidRequestException(BRANDING_REFUSALS.VALIDATION_FAILED.notYours, { field: 'storageKey' });
    }
    let bytes: Buffer | null;
    try {
      bytes = await this.storage.read(input.storageKey, BRANDING.IMAGE_MAX_BYTES);
    } catch (err) {
      if (err instanceof DomainException) throw err;
      throw tooLarge();
    }
    if (!bytes || bytes.length === 0) {
      throw new DomainException(ErrorCode.ASSET_NOT_UPLOADED, BRANDING_REFUSALS.ASSET_NOT_UPLOADED.neverFinished, HttpStatus.CONFLICT, { storageKey: input.storageKey });
    }
    refuseSize(bytes.length);
    const described = await this.storage.describe(input.storageKey);
    const type = sniffImage(bytes, input.mimeType ?? described?.mimeType ?? '');
    if (!type || !(BRANDING.MIME_TYPES[input.kind] as readonly string[]).includes(type)) {
      throw new DomainException(ErrorCode.ASSET_TYPE_NOT_ALLOWED, BRANDING_REFUSALS.ASSET_TYPE_NOT_ALLOWED.notAccepted, HttpStatus.UNSUPPORTED_MEDIA_TYPE, {
        mimeType: type ?? 'application/octet-stream', allowed: BRANDING.MIME_TYPES[input.kind],
      });
    }
    let rendered;
    try {
      rendered = await renderUpload(input.kind, bytes, type);
    } catch (err) {
      if (err instanceof BrandingImageRefused) throw imageRefused(err.reason);
      throw imageRefused('unreadable');
    }
    const folder = `branding/${ulid()}`;
    let setKey = '';
    for (const file of rendered.files) {
      const stored = await this.storage.putObject({ owner, folder, name: file.name, mimeType: file.mimeType, body: file.body });
      setKey = stored.storageKey.slice(0, stored.storageKey.length - file.name.length - 1);
    }
    const shown = input.kind === 'logo' ? 'logo.png' : input.kind === 'logo_square' ? 'logo-square.png' : 'mascot-240.webp';
    return {
      storageKey: setKey,
      width: rendered.width,
      height: rendered.height,
      previews: { [shown]: await this.storage.createSignedUrl(`${setKey}/${shown}`, BRANDING.PREVIEW_TTL_SECONDS, shown.endsWith('.webp') ? 'image/webp' : 'image/png') },
    };
  }

  /**
   * **A template's *Tampilan*, checked** (P19.6-T1 AC-11; ADR-0218 §3): the same fields and rules as a KPM's, its
   * images in the company's folder. What `config/template.service.ts` stores as the section's payload.
   */
  checkTemplatePayload(companyId: string, payload: unknown): Record<string, unknown> {
    return checkedTemplatePayload(companyId, payload);
  }

  /** A template section's images with their preview links, for its editor. */
  async templateView(payload: unknown): Promise<BrandingView> {
    return this.viewOf(fieldsOf(payload));
  }

  // ------------------------------------------------------------------ the public reads

  /**
   * **`GET /kpm-branding/:kpmId`** (§9): a live KPM's name, version, palette and logo size; the same answer with
   * everything `null` for any other id, so nothing tells an unknown KPM from a suspended one.
   */
  async publicRead(kpmId: string): Promise<{ name: string | null; version: string | null; palette: BrandingPalette | null; logo: { width: number; height: number } | null }> {
    const shown = await this.reader.shownFor(kpmId, true);
    if (!shown) return { name: null, version: null, palette: null, logo: null };
    return { name: shown.name, version: shown.version, palette: shown.palette, logo: shown.logo ? { width: shown.logo.width, height: shown.logo.height } : null };
  }

  /**
   * **`GET /kpm-branding/:kpmId/files/:file`** (§4): one size the KPM shows, read from the private bucket; `null` for a
   * file it does not show, a name outside the list, or a KPM that is not live. A pose with no picture of its own takes
   * the default's.
   */
  async file(kpmId: string, name: string): Promise<{ body: Buffer; mimeType: string; version: string } | null> {
    const shown = await this.reader.shownFor(kpmId, true);
    if (!shown) return null;
    let key: string | null = null;
    if (name === 'logo.png') key = shown.logo ? `${shown.logo.key}/logo.png` : null;
    else if (name === 'logo-square.png') key = shown.logoSquare ? `${shown.logoSquare.key}/logo-square.png` : null;
    else if ((BRANDING_ICON_FILES as readonly string[]).includes(name)) key = shown.iconsKey ? `${shown.iconsKey}/${name}` : null;
    else {
      const m = BRANDING_MASCOT_FILE.exec(name);
      if (m && shown.mascot) {
        const pose = m[1] as MascotPose;
        const folder = pose === 'default' ? shown.mascot.default : shown.mascot.poses[pose] ?? shown.mascot.default;
        key = `${folder}/mascot-${m[2]}.webp`;
      }
    }
    if (!key) return null;
    const body = await this.storage.read(key, BRANDING.IMAGE_MAX_BYTES).catch(() => null);
    if (!body || body.length === 0) return null;
    return { body, mimeType: name.endsWith('.webp') ? 'image/webp' : 'image/png', version: shown.version };
  }

  // ------------------------------------------------------------------ helpers

  private checked(input: unknown, owner: AssetOwner): CheckedFields {
    return checkedFields(input, owner);
  }

  private async storedSize(key: string, field: string): Promise<{ width: number; height: number }> {
    const body = await this.storage.read(key, BRANDING.IMAGE_MAX_BYTES).catch(() => null);
    if (!body || body.length === 0) throw new InvalidRequestException(BRANDING_REFUSALS.VALIDATION_FAILED.notYours, { field });
    return sizeOf(body).catch(() => ({ width: 0, height: 0 }));
  }

  private async viewOf(fields: BrandingFields): Promise<BrandingView> {
    const link = async (key: string, file: string): Promise<ImageView> => ({
      key, url: await this.storage.createSignedUrl(`${key}/${file}`, BRANDING.PREVIEW_TTL_SECONDS, file.endsWith('.webp') ? 'image/webp' : 'image/png'),
    });
    const poses: NonNullable<BrandingView['mascot']>['poses'] = {};
    if (fields.mascot) {
      for (const [pose, key] of Object.entries(fields.mascot.poses)) {
        if (key) poses[pose as Exclude<MascotPose, 'default'>] = await link(key, 'mascot-240.webp');
      }
    }
    return {
      logo: fields.logo ? { ...(await link(fields.logo.key, 'logo.png')), width: fields.logo.width, height: fields.logo.height } : null,
      logoSquare: fields.logoSquare ? await link(fields.logoSquare.key, 'logo-square.png') : null,
      primary: fields.primary,
      secondary: fields.secondary,
      mascot: fields.mascot ? { default: await link(fields.mascot.default, 'mascot-240.webp'), poses } : null,
    };
  }

  private async kpmOf(kpmId: string) {
    return this.reader.kpmOf(kpmId);
  }
}

/** **The fields, checked or refused** in the API's words: `400`. Every colour is accepted (P19.12-T3; ADR-0246). */
export function checkedFields(input: unknown, owner: AssetOwner): CheckedFields {
  const result = checkFields(input, ownerSegment(owner));
  if (result.ok) return result.fields;
  const { problem } = result;
  if (problem.problem === 'notYours') throw new InvalidRequestException(BRANDING_REFUSALS.VALIDATION_FAILED.notYours, { field: problem.field });
  throw new InvalidRequestException(BRANDING_REFUSALS.VALIDATION_FAILED[problem.problem], { field: problem.problem });
}

/**
 * **A template's *Tampilan* payload, checked** (P19.6-T1 AC-11; ADR-0218 §3): what `config/template.service.ts` stores
 * at a draft's save and at its publish — the same rules as a KPM's, its images in the company's own folder.
 */
export function checkedTemplatePayload(companyId: string, payload: unknown): Record<string, unknown> {
  return { ...checkedFields(payload, { kind: 'company', companyId }) } as unknown as Record<string, unknown>;
}

function imageRefused(reason: string): DomainException {
  return new DomainException(ErrorCode.BRANDING_IMAGE_REFUSED, BRANDING_REFUSALS.BRANDING_IMAGE_REFUSED.refused({ reason }), HttpStatus.UNPROCESSABLE_ENTITY, { reason });
}

function tooLarge(): DomainException {
  return new DomainException(ErrorCode.ASSET_TOO_LARGE, BRANDING_REFUSALS.ASSET_TOO_LARGE.atMost, HttpStatus.PAYLOAD_TOO_LARGE, { maxBytes: BRANDING.IMAGE_MAX_BYTES });
}

function refuseSize(bytes: number): void {
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > BRANDING.IMAGE_MAX_BYTES) {
    throw new DomainException(ErrorCode.ASSET_TOO_LARGE, BRANDING_REFUSALS.ASSET_TOO_LARGE.atMost, HttpStatus.PAYLOAD_TOO_LARGE, {
      maxBytes: BRANDING.IMAGE_MAX_BYTES, receivedBytes: bytes,
    });
  }
}

function refuseType(kind: BrandingUploadKind, mimeType: string): void {
  if (!(BRANDING.MIME_TYPES[kind] as readonly string[]).includes(mimeType)) {
    throw new DomainException(ErrorCode.ASSET_TYPE_NOT_ALLOWED, BRANDING_REFUSALS.ASSET_TYPE_NOT_ALLOWED.notAccepted, HttpStatus.UNSUPPORTED_MEDIA_TYPE, {
      mimeType, allowed: BRANDING.MIME_TYPES[kind],
    });
  }
}

/** **The audit's old → new** (AC-15): each colour with its contrast and fill, and each image by its folder and size. */
function auditFields(fields: BrandingFields, row: Pick<KpmBranding, 'contrast'>): Record<string, unknown> {
  return {
    logo: fields.logo ? { key: fields.logo.key, width: fields.logo.width, height: fields.logo.height } : null,
    logoSquare: fields.logoSquare?.key ?? null,
    primary: fields.primary ? { hex: fields.primary, contrast: row.contrast?.primary ?? null } : null,
    secondary: fields.secondary ? { hex: fields.secondary, contrast: row.contrast?.secondary ?? null } : null,
    mascot: fields.mascot ?? null,
  };
}
