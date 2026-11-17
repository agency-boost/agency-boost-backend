import mongoose, { type Model } from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { describeNotification } from '@/modules/notifications/inbox-copy';
import { InAppChannelAdapter } from '@/modules/notifications/local-adapters';
import { NotificationRepository } from '@/modules/notifications/notification.repository';
import {
  Notification, type NotificationDocument, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from '@/modules/notifications/notification.schema';
import { NotificationService, TemplateRenderer } from '@/modules/notifications/notification.service';
import type { RenderedMessage } from '@/modules/notifications/notification.types';
import { PremiumNoticesService, type PremiumNoticesReport } from '@/modules/product-data/premium-notices.service';
import { ProductDataGrant, ProductDataGrantSchema } from '@/modules/product-data/product-data-grant.schema';
import { RateTable, RateTableSchema } from '@/modules/product-data/rate-table.schema';
import { Product, ProductSchema } from '@/modules/products/product.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';

/**
 * ***Kelola data produk* and the premium table notices, seeded** (P19.15-T4; ADR-0260, ADR-0261).
 *
 * | What | Who to sign in as, and what they see |
 * |---|---|
 * | **Maya Halim, KPM 0417's Admin, holds *Kelola data produk* for Prudential**, given by the Super Admin | `admin@kpm0417.test`: ***Data produk*** under *Pengaturan* (and in *Lainnya* on a phone) → Prudential's *Proposal* tab, in full. `superadmin@agencyboost.test` at `/admin/tenant-admins`: Maya's row reads *Kelola data produk · Prudential*; its key opens the switch and the ticks |
 * | **The Owner without it** | `owner@kpm0417.test`: no *Data produk* in the menu; *Products* → *Lihat data proposal* opens Prudential's tab read-only |
 * | **The premium table notices, by the daily run itself** over the premium tables the demo holds (`PremiumNoticesService`, as `daily-notices` runs it at 00:10) | `superadmin@agencyboost.test`'s bell: *"Tabel tarif … berakhir … Unggah tarif baru."* for a table ending within 15 days with nothing scheduled; `owner@kpm0417.test`'s bell: *"Tarif … diperbarui mulai …"* for each version in force |
 *
 * **Written once, until `--reset`.** The grant is given only when Maya holds none, audited as the Super Admin's; the
 * notices are the run's, each claimed on its table version, so a second seed — like a second run — tells nobody again.
 */

const RECOMPILE = { overwriteModels: true } as const;

/** The in-app row's words, as the CLI renders them: an in-app notice needs no email frame. */
class InboxWordsRenderer extends TemplateRenderer {
  render(templateId: string, payload: Record<string, unknown>): RenderedMessage {
    const words = describeNotification(templateId, payload);
    return { subject: words.title, body: words.detail ?? '' };
  }
}

export interface ProductDataAccessFixture {
  granted: boolean;
  notices: PremiumNoticesReport;
  guide: string;
}

export async function seedProductDataAccessFixture(input: {
  clock: Clock;
  /** Prudential's id: the insurer Maya is given. */
  companyId: string;
  maya: { userId: string };
  superAdminUserId: string;
}): Promise<ProductDataAccessFixture> {
  const { clock, companyId, maya, superAdminUserId } = input;
  const model = (name: string, schema: mongoose.Schema): never => mongoose.model(name, schema, undefined, RECOMPILE) as never;
  const grants: Model<ProductDataGrant> = model(ProductDataGrant.name, ProductDataGrantSchema);
  const auditRows: Model<AuditLog> = model(AuditLog.name, AuditLogSchema);
  const audit = new AuditService(auditRows as never);

  // ADR-0260 §4: given by the Super Admin, once — a live grant is left as a walk left it.
  let granted = false;
  if (!(await grants.exists({ userId: maya.userId, revokedAt: null, deletedAt: null }).exec())) {
    const at = clock.now();
    const grant = await grants.create({ userId: maya.userId, companyIds: [companyId], grantedBy: superAdminUserId, grantedAt: at });
    // Written as `AuditService.record` writes the Super Admin's own: the platform's log, no office.
    await auditRows.create({
      kpmId: null, actorUserId: superAdminUserId, effectiveUserId: null, actorMembershipId: null,
      action: 'product_data_grant.granted', targetCollection: 'productDataGrants', targetId: String(grant._id),
      before: null, after: { userId: maya.userId, companyIds: [companyId] }, onBehalfOf: false,
    });
    granted = true;
  }

  // ADR-0261: the daily run, over whatever premium tables the demo holds, as `daily-notices` would run it now.
  const notificationRows: Model<NotificationDocument> = model(Notification.name, NotificationSchema);
  const notices = await new PremiumNoticesService(
    model(RateTable.name, RateTableSchema),
    model(Product.name, ProductSchema),
    model(Company.name, CompanySchema),
    model(Kpm.name, KpmSchema),
    model(User.name, UserSchema),
    new NotificationService(
      notificationRows, new NotificationRepository(notificationRows),
      model(NotificationPreferences.name, NotificationPreferencesSchema), new InboxWordsRenderer(), clock, audit,
      [new InAppChannelAdapter()],
    ),
    clock,
  ).run();

  return {
    granted,
    notices,
    guide: 'Kelola data produk: admin@kpm0417.test (Maya) manages Prudential\'s proposal data under Pengaturan → Data '
      + 'produk; owner@kpm0417.test reads it from Products → Lihat data proposal. Premium table notices on '
      + `${notices.today}: ${notices.ending.recipients} to Super Admins (ending), ${notices.started.recipients} to KPM Owners `
      + '(started) — superadmin@agencyboost.test and owner@kpm0417.test, the bell.',
  };
}
