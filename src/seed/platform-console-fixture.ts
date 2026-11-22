import { ownerUserIdsOf } from '@/modules/tenants/kpm-owners';
import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { Announcement, AnnouncementSchema } from '@/modules/announcements/announcement.schema';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { Notification, NotificationSchema } from '@/modules/notifications/notification.schema';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { PlatformSettings, PlatformSettingsSchema } from '@/modules/platform-settings/platform-settings.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { seedPersonalFor } from './personal-fixture';

/**
 * ***Platform*'s demo data** (P19.23-T6; ADR-0279): every section has something to show, and each action can be walked
 * from `superadmin@agencyboost.test`.
 *
 * | Section | What is seeded |
 * |---|---|
 * | *Audit log* | a Super Admin's change **inside** KPM 0417 (*Target rekrutmen ditetapkan · 6 → 8*), a Super Admin made, the WhatsApp number saved, the announcement sent — so *Semua KPM* reads platform and KPM rows, and *Cari perubahan* finds them |
 * | *Tim Super Admin* | the seed's Super Admins as they are (Platform Operator, Second Operator, Wilson's console login), and **Rudi Hartono** (`rudi.hartono@agencyboost.test`): registered with Prudential and verified, in no KPM — *Tambah Super Admin* takes him |
 * | *Pengaturan platform* | the WhatsApp number `+62 811 2000 300`; the AI key's state is whatever the API's environment says |
 * | *Pengumuman* | one announcement to every Owner, in each live, active KPM's Owner's notifications |
 *
 * **Written once, until `--reset`**: each row is found by what it says before it is written.
 */
export const PLATFORM_CONSOLE_SEED = {
  whatsappNumber: '+628112000300',
  candidate: { email: 'rudi.hartono@agencyboost.test', fullName: 'Rudi Hartono', agentCode: '81951' },
  announcement: 'Fitur proposal baru sudah tersedia di menu Leads.',
} as const;

export interface PlatformConsoleFixtureDeps {
  clock: Clock;
  superAdminUserId: string;
  /** Another Super Admin the seed made, whose grant the log records. */
  secondSuperAdminUserId: string;
  /** KPM 0417, where the Super Admin's change inside a KPM is written. */
  kpmId: string;
  /** The company the candidate registered with (Prudential): registration takes a company and its agent code. */
  companyId: string;
  /** The seed's password hasher, for the candidate's account. */
  hash: (password: string) => Promise<string>;
}

export async function seedPlatformConsoleFixture(deps: PlatformConsoleFixtureDeps): Promise<{ guide: string }> {
  const { clock, superAdminUserId, secondSuperAdminUserId, kpmId } = deps;
  const model = <T>(name: string, schema: mongoose.Schema) =>
    (mongoose.models[name] ?? mongoose.model(name, schema)) as unknown as mongoose.Model<T>;
  const Users = model<User>(User.name, UserSchema);
  const Audit = model<AuditLog>(AuditLog.name, AuditLogSchema);
  const Settings = model<PlatformSettings>(PlatformSettings.name, PlatformSettingsSchema);
  const Announcements = model<Announcement>(Announcement.name, AnnouncementSchema);
  const Notifications = model<Notification>(Notification.name, NotificationSchema);
  const Kpms = model<Kpm>(Kpm.name, KpmSchema);
  const now = clock.now();
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60_000);
  const audit = async (row: Record<string, unknown>, at: Date) => {
    if (await Audit.exists({ action: row.action, targetId: row.targetId, kpmId: row.kpmId ?? null })) return;
    await Audit.collection.insertOne({
      kpmId: null, actorUserId: superAdminUserId, effectiveUserId: null, actorMembershipId: null, targetMembershipId: null,
      before: null, after: null, onBehalfOf: false, ip: null, userAgent: null, ...row, createdAt: at, updatedAt: at,
    });
  };

  /*
   * *Tim Super Admin*: somebody *Tambah Super Admin* can take — verified, in no KPM. The person registers, verifies and
   * is added (ADR-0279), so the account is what registration leaves: a company, its agent code, and the four every
   * seeded person records (ADR-0158, P18.5-T4) — a birth date, a gender, the company join month.
   */
  const { email, fullName, agentCode } = PLATFORM_CONSOLE_SEED.candidate;
  if (!(await Users.exists({ email }))) {
    const { dateOfBirth, gender, companyJoinMonth } = seedPersonalFor(email, 'he');
    await Users.create({
      email, fullName, passwordHash: await deps.hash('demo password field'), platformRole: 'none', status: 'active',
      companyId: deps.companyId, agentCode, dateOfBirth, gender, companyJoinMonth, pronoun: 'he', emailVerifiedAt: now,
    });
  }
  await audit({
    action: 'super_admin.granted', targetCollection: 'users', targetId: secondSuperAdminUserId,
    before: { platformRole: 'none' }, after: { platformRole: 'super_admin' },
  }, daysAgo(4));

  // *Pengaturan platform*: the number AgencyBoost's messages give.
  const settings = await Settings.findOne({ key: 'platform' }).exec();
  if (!settings) {
    const saved = await Settings.create({
      key: 'platform', whatsappNumber: PLATFORM_CONSOLE_SEED.whatsappNumber, updatedByUserId: superAdminUserId, deletedAt: null,
    });
    await audit({
      action: 'platform_settings.updated', targetCollection: 'platformSettings', targetId: String(saved._id),
      before: { whatsappNumber: null }, after: { whatsappNumber: PLATFORM_CONSOLE_SEED.whatsappNumber },
    }, daysAgo(3));
  }

  // *Audit log*: a Super Admin's change inside KPM 0417, as its Owner (ADR-0268 §3) — *Semua KPM* reads it.
  await audit({
    kpmId, action: 'kpm_overview.recruit_target_set', targetCollection: 'kpms', targetId: kpmId,
    before: { target: 6 }, after: { target: 8 },
  }, daysAgo(1));

  // *Pengumuman*: one, to every Owner of a live, active KPM — each once, in their notifications.
  let announcement = await Announcements.findOne({ message: PLATFORM_CONSOLE_SEED.announcement }).exec();
  if (!announcement) {
    const offices = await Kpms.find({ deletedAt: null, status: 'active', 'owners.0': { $exists: true } }, { owners: 1 }).lean().exec();
    // Every owner of every KPM (ADR-0285 §5), each once.
    const owners = new Map<string, string>();
    for (const office of offices) {
      for (const owner of ownerUserIdsOf(office as never)) if (!owners.has(owner)) owners.set(owner, String(office._id));
    }
    const sentAt = daysAgo(2);
    announcement = await Announcements.create({
      message: PLATFORM_CONSOLE_SEED.announcement, audience: 'owners', companyIds: [], kpmIds: [],
      recipientCount: owners.size, sentByUserId: superAdminUserId, sentAt, deletedAt: null,
    });
    const announcementId = String(announcement._id);
    await Notifications.insertMany([...owners].map(([userId, officeId]) => ({
      kpmId: officeId, membershipId: null, userId, templateId: NotificationTemplate.PLATFORM_ANNOUNCEMENT,
      payload: { announcementId, message: PLATFORM_CONSOLE_SEED.announcement },
      delivery: { in_app: { status: 'sent', at: sentAt } }, readAt: null, coalesceKey: null, deletedAt: null,
      createdAt: sentAt, updatedAt: sentAt,
    })));
    await audit({
      action: 'announcement.sent', targetCollection: 'announcements', targetId: announcementId,
      after: { audience: 'owners', companyIds: [], kpmIds: [], recipientCount: owners.size, message: PLATFORM_CONSOLE_SEED.announcement },
    }, sentAt);
  }

  return {
    guide: `Platform (P19.23-T6): sign in as superadmin@agencyboost.test → Platform. Audit log reads a change inside KPM 0417 `
      + `(Target rekrutmen 6 → 8) beside the platform's rows; Tim Super Admin can add ${email}; Pengaturan platform holds `
      + `0811 2000 300; Pengumuman lists "${PLATFORM_CONSOLE_SEED.announcement}" sent to ${announcement.recipientCount} owner(s).`,
  };
}
