import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { DateTime } from 'luxon';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { DEFAULT_TENANT_TIMEZONE, PREMIUM_TABLE_NOTICES } from '@/domain/constants';
import { NotificationService } from '@/modules/notifications/notification.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { Product, ProductDocument } from '@/modules/products/product.schema';
import { Company, CompanyDocument } from '@/modules/tenants/company.schema';
import { HAS_AN_OWNER, OWNERS_PROJECTION, ownerUserIdsOf, type WithOwners } from '@/modules/tenants/kpm-owners';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { User, UserDocument } from '@/modules/users/user.schema';
import { inForceOn, nextScheduled, type VersionFacts } from './rate-table-status';
import { RateTable, RateTableDocument } from './rate-table.schema';

/** What one run did: the office day it ran for, and per notice the table versions told about and the people told. */
export interface PremiumNoticesReport {
  today: string;
  ending: { tables: number; recipients: number };
  started: { tables: number; recipients: number };
}

/** A version as the run reads it: the status facts, and what the notices name. */
type Version = VersionFacts & { companyId: string; productId: string };

/** `YYYY-MM-DD` plus whole days, calendar arithmetic with no clock involved. */
function plusDays(day: string, days: number): string {
  return DateTime.fromISO(day, { zone: 'utc' }).plus({ days }).toFormat('yyyy-MM-dd');
}

/**
 * **The premium table notices** (ADR-0261; P19.15-T4 AC-4; the P1b spec's *Notifications*), what the daily run sends —
 * `cli/daily-notices.ts`, started at 00:10 `Asia/Jakarta` by `agencyboost-daily.timer`.
 *
 * - **Ending** (§2): a version **in force today** whose *Berlaku sampai* is at most `PREMIUM_TABLE_NOTICES.EXPIRY_NOTICE_DAYS`
 *   days away, with **no newer version scheduled** for the product, tells every Super Admin *"Tabel tarif {produk}
 *   berakhir {date}. Unggah tarif baru."* — once per version, whichever run first finds it so.
 * - **Started** (§3): a version **in force today** that has not been announced tells the KPM Owner of every active KPM of
 *   its company *"Tarif {produk} diperbarui mulai {date}"* — once per version, on the first run on or after its
 *   *Berlaku mulai*. A version superseded before any run found it in force is never announced; nothing would be true.
 *
 * **Each notice is claimed before it is sent** — `expiryNoticeSentAt` / `activationNoticeSentAt` written in one
 * conditional update — so two runs, or a run repeated by hand, never tell anybody twice; a send that fails gives the
 * claim back for the next run. **Today is the office's** (the Clock port in `Asia/Jakarta`, ADR-0016), never the
 * server's. **Nothing else depends on the run**: a version's status is worked out on every read (ADR-0258 §2), so a
 * timer that never ran only means nobody was told.
 */
@Injectable()
export class PremiumNoticesService {
  private readonly logger = new Logger(PremiumNoticesService.name);

  constructor(
    @InjectModel(RateTable.name) private readonly tables: Model<RateTableDocument>,
    @InjectModel(Product.name) private readonly products: Model<ProductDocument>,
    @InjectModel(Company.name) private readonly companies: Model<CompanyDocument>,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  /** **One run, for the office day it is now** — or for `today` where a test or the operator names one. */
  async run(today: string = this.clock.localDateFor(DEFAULT_TENANT_TIMEZONE)): Promise<PremiumNoticesReport> {
    const ending = await this.ending(today);
    const started = await this.started(today);
    return { today, ending, started };
  }

  /** §2: the versions ending within the notice's days with nothing after them, each told to every Super Admin. */
  private async ending(today: string): Promise<{ tables: number; recipients: number }> {
    const last = plusDays(today, PREMIUM_TABLE_NOTICES.EXPIRY_NOTICE_DAYS);
    const candidates = await this.versions({
      activatedAt: { $ne: null }, turnedOffAt: null, deletedAt: null, expiryNoticeSentAt: null,
      effectiveTo: { $ne: null, $gte: today, $lte: last },
    });
    let tables = 0;
    let recipients = 0;
    for (const table of candidates) {
      const siblings = await this.versions({ productId: table.productId, deletedAt: null });
      if (inForceOn(siblings, today)?.id !== table.id || nextScheduled(siblings, today) !== null) continue;
      const admins = await this.superAdmins();
      const told = await this.claimAndSend(table, 'expiryNoticeSentAt', admins.map((userId) => ({ userId, kpmId: null })),
        NotificationTemplate.PREMIUM_TABLE_ENDING, { effectiveTo: table.effectiveTo });
      if (told === null) continue;
      tables += 1;
      recipients += told;
    }
    return { tables, recipients };
  }

  /** §3: the versions in force today and not yet announced, each told to the KPM Owners of its company. */
  private async started(today: string): Promise<{ tables: number; recipients: number }> {
    const candidates = await this.versions({
      activatedAt: { $ne: null }, turnedOffAt: null, deletedAt: null, activationNoticeSentAt: null,
      effectiveFrom: { $lte: today },
    });
    let tables = 0;
    let recipients = 0;
    for (const table of candidates) {
      const siblings = await this.versions({ productId: table.productId, deletedAt: null });
      if (inForceOn(siblings, today)?.id !== table.id) continue;
      const owners = await this.ownersOf(table.companyId);
      const told = await this.claimAndSend(table, 'activationNoticeSentAt', owners,
        NotificationTemplate.PREMIUM_TABLE_STARTED, { effectiveFrom: table.effectiveFrom });
      if (told === null) continue;
      tables += 1;
      recipients += told;
    }
    return { tables, recipients };
  }

  /**
   * **Claim the notice, then send it**: the marker written only where it is still empty, so a version another run has
   * claimed answers `null` and sends nothing. A send that fails is logged and the marker given back, so the next run
   * tries again; the people already told in that attempt may be told again then, which is the lesser fault.
   */
  private async claimAndSend(
    table: Version,
    marker: 'expiryNoticeSentAt' | 'activationNoticeSentAt',
    recipients: readonly { userId: string; kpmId: string | null }[],
    templateId: typeof NotificationTemplate.PREMIUM_TABLE_ENDING | typeof NotificationTemplate.PREMIUM_TABLE_STARTED,
    dates: Record<string, string | null>,
  ): Promise<number | null> {
    const at = this.clock.now();
    const claimed = await this.tables
      .findOneAndUpdate({ _id: table.id, [marker]: null }, { $set: { [marker]: at } }, { new: true })
      .exec();
    if (!claimed) return null;
    const [product, company] = await Promise.all([
      this.products.findById(table.productId, { name: 1 }).lean().exec() as Promise<{ name?: string } | null>,
      this.companies.findById(table.companyId, { name: 1 }).lean().exec() as Promise<{ name?: string } | null>,
    ]);
    const payload = {
      rateTableId: table.id, version: table.version, productId: table.productId, productName: product?.name ?? null,
      companyId: table.companyId, companyName: company?.name ?? null, ...dates,
    };
    try {
      for (const { userId, kpmId } of recipients) {
        await this.notifications.send({ userId, kpmId, templateId, payload });
      }
    } catch (err) {
      this.logger.error({ err, rateTableId: table.id, templateId }, 'a premium table notice failed; it will be tried again');
      await this.tables.updateOne({ _id: table.id, [marker]: at }, { $set: { [marker]: null } }).exec();
      return null;
    }
    return recipients.length;
  }

  /** Versions as the status rules read them. */
  private async versions(filter: Record<string, unknown>): Promise<Version[]> {
    const rows = await this.tables
      .find(filter, {
        companyId: 1, productId: 1, version: 1, effectiveFrom: 1, effectiveTo: 1, activatedAt: 1, turnedOffAt: 1,
        deletedAt: 1,
      })
      .sort({ effectiveFrom: 1, version: 1 })
      .lean()
      .exec() as unknown as (Omit<Version, 'id'> & { _id: unknown })[];
    return rows.map(({ _id, ...rest }) => ({ ...rest, id: String(_id) }));
  }

  /** **Every Super Admin** (ADR-0261 §2): the platform's people, active, not deleted. Their inbox has no KPM. */
  private async superAdmins(): Promise<string[]> {
    const rows = await this.users
      .find({ platformRole: 'super_admin', deletedAt: null, status: { $ne: 'deactivated' } }, { _id: 1 })
      .lean()
      .exec();
    return rows.map((u) => String(u._id));
  }

  /**
   * **Every owner of every active KPM of the company** (ADR-0261 §3; ADR-0285 §5: every owner, not the first alone), once
   * each per KPM, with their KPM.
   */
  private async ownersOf(companyId: string): Promise<{ userId: string; kpmId: string }[]> {
    const offices = await this.kpms
      .find({ companyId, status: 'active', deletedAt: null, ...HAS_AN_OWNER }, OWNERS_PROJECTION)
      .lean()
      .exec() as ({ _id: unknown } & WithOwners)[];
    const seen = new Set<string>();
    const owners: { userId: string; kpmId: string }[] = [];
    for (const office of offices) {
      for (const userId of ownerUserIdsOf(office)) {
        const key = `${userId}:${String(office._id)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        owners.push({ userId, kpmId: String(office._id) });
      }
    }
    return owners;
  }
}
