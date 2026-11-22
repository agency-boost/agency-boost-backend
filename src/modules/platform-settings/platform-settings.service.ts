import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { InvalidRequestException, PermissionDeniedException } from '@/common/errors/domain.exception';
import { BRANDING, normalisePhone } from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { can, type Permission } from '@/modules/rbac/permissions';
import { PLATFORM_SETTINGS_REFUSALS } from './platform-settings.messages';
import { PlatformSettings, PlatformSettingsDocument } from './platform-settings.schema';

/** What *Pengaturan platform* reads. */
export interface PlatformSettingsView {
  whatsappNumber: string | null;
  aiReadingKey: 'set' | 'not_set';
  defaultLook: { systemName: string; editable: false };
  updatedAt: string | null;
}

const KEY = 'platform' as const;

/**
 * ***Pengaturan platform*** (P19.23-T6 AC-3; ADR-0279; spec §10: *"AI file-reading key, WhatsApp sender number, default
 * look"*):
 *
 * - ***Kunci AI untuk membaca file*** — **a state, never a value.** Whether the deployment's environment carries
 *   `ANTHROPIC_API_KEY` (ADR-0262 §4, OD-358: the key is on hold and lives in the environment). Nothing here can read
 *   it back: the view holds `set` or `not_set`, and neither the database, the API nor a log ever sees the key.
 * - ***Nomor WhatsApp pengirim*** — the one thing saved: the number AgencyBoost's messages give (the subscription offer
 *   and its PDF read it through `whatsappNumber()`), as `+62` and its digits, or none.
 * - ***Tampilan bawaan*** — the look every KPM has until it sets its own: shown, not changed (OD-426's default; the
 *   decision is ADR-0279's).
 *
 * The Super Admin's alone. Every save audited as `platform_settings.updated`, the number before and after.
 */
@Injectable()
export class PlatformSettingsService {
  constructor(
    @InjectModel(PlatformSettings.name) private readonly settings: Model<PlatformSettingsDocument>,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  private require(ctx: RequestContext, permission: Permission): void {
    if (!can(ctx, permission)) throw new PermissionDeniedException(permission);
  }

  /** **`GET /admin/platform/settings`**. */
  async read(ctx: RequestContext): Promise<PlatformSettingsView> {
    this.require(ctx, 'platform_settings:read');
    return this.viewOf(await this.current());
  }

  /** **`PUT /admin/platform/settings`**: the WhatsApp number, normalised; blank or null clears it. */
  async update(ctx: RequestContext, input: { whatsappNumber?: string | null }): Promise<PlatformSettingsView> {
    this.require(ctx, 'platform_settings:update');
    const typed = typeof input.whatsappNumber === 'string' ? input.whatsappNumber.trim() : '';
    const next = typed === '' ? null : normalisePhone(typed);
    if (typed !== '' && next === null) {
      throw new InvalidRequestException(PLATFORM_SETTINGS_REFUSALS.VALIDATION_FAILED.whatsapp, { field: 'whatsappNumber' });
    }
    const before = await this.current();
    const saved = await this.settings
      .findOneAndUpdate(
        { key: KEY },
        { $set: { whatsappNumber: next, updatedByUserId: ctx.userId }, $setOnInsert: { key: KEY, deletedAt: null } },
        { new: true, upsert: true },
      )
      .exec();
    if ((before?.whatsappNumber ?? null) !== next) {
      await this.audit.record(ctx, {
        action: 'platform_settings.updated',
        targetCollection: 'platformSettings',
        targetId: String(saved._id),
        before: { whatsappNumber: before?.whatsappNumber ?? null },
        after: { whatsappNumber: next },
      });
    }
    return this.viewOf(saved);
  }

  /**
   * **The number AgencyBoost's messages give** (for the subscription offer and its PDF, P19.23-T5): `+62…`, or `null`
   * when none is saved. No permission check: it is what a message prints, read by the service that writes the message,
   * which checks its own caller.
   */
  async whatsappNumber(): Promise<string | null> {
    return (await this.current())?.whatsappNumber ?? null;
  }

  private current(): Promise<PlatformSettingsDocument | null> {
    return this.settings.findOne({ key: KEY, deletedAt: null }).exec();
  }

  private viewOf(row: PlatformSettingsDocument | null): PlatformSettingsView {
    const key = this.config.get<string>('ANTHROPIC_API_KEY');
    const updatedAt = (row as unknown as { updatedAt?: Date } | null)?.updatedAt;
    return {
      whatsappNumber: row?.whatsappNumber ?? null,
      aiReadingKey: typeof key === 'string' && key.trim() !== '' ? 'set' : 'not_set',
      defaultLook: { systemName: BRANDING.DEFAULT_SYSTEM_NAME, editable: false },
      updatedAt: updatedAt ? updatedAt.toISOString() : null,
    };
  }
}
