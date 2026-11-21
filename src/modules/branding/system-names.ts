import { Injectable, Logger } from '@nestjs/common';
import { isValidObjectId } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { BRANDING } from '@/domain/constants/branding';
import { BrandingReader } from './branding-reader';
import { SystemNames } from './system-name.port';

/**
 * **The KPM's own row, read through the branding reader** — tenant-scoped by a context naming the KPM — and kept for
 * `SYSTEM_NAME_CACHE_SECONDS`, so a roster import's hundred invitations read it once. A read that fails is *AgencyBoost*:
 * an email is never refused over its name.
 */
@Injectable()
export class BrandingSystemNames extends SystemNames {
  private readonly logger = new Logger(BrandingSystemNames.name);
  private readonly cache = new Map<string, { name: string | null; until: number }>();

  constructor(private readonly reader: BrandingReader, private readonly clock: Clock) {
    super();
  }

  async nameOf(kpmId: string): Promise<string | null> {
    if (!isValidObjectId(kpmId)) return null;
    const now = this.clock.now().getTime();
    const held = this.cache.get(kpmId);
    if (held && held.until > now) return held.name;
    let name: string | null = null;
    try {
      name = (await this.reader.ownOf(kpmId))?.systemName ?? null;
    } catch (err) {
      this.logger.warn({ err, kpmId }, 'system name not read; the email says AgencyBoost');
    }
    this.cache.set(kpmId, { name, until: now + BRANDING.SYSTEM_NAME_CACHE_SECONDS * 1000 });
    return name;
  }
}
