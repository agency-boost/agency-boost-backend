import mongoose from 'mongoose';
import type { ConfigService } from '@nestjs/config';
import { FixedClock } from '@/common/clock/clock.port';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { EmailTemplateRenderer } from '@/modules/notifications/email-renderer';
import {
  Notification, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from '@/modules/notifications/notification.schema';
import { NotificationRepository } from '@/modules/notifications/notification.repository';
import { NotificationService } from '@/modules/notifications/notification.service';
import {
  NotificationChannel, NotificationChannelAdapter, NotificationTemplate, RenderedMessage, SendRequest,
} from '@/modules/notifications/notification.types';
import { RecipientLanguages } from '@/modules/notifications/recipient-languages';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { SystemNames } from './system-name.port';

const NOW = new Date('2026-11-20T03:00:00Z');
const NAMED_KPM = '66f0000000000000000000a1';
const PLAIN_KPM = '66f0000000000000000000b2';

class CapturingEmail extends NotificationChannelAdapter {
  readonly channel: NotificationChannel = 'email';
  sent: { to: SendRequest; rendered: RenderedMessage }[] = [];
  async send(to: SendRequest, rendered: RenderedMessage): Promise<void> {
    this.sent.push({ to, rendered });
  }
}

class InApp extends NotificationChannelAdapter {
  readonly channel: NotificationChannel = 'in_app';
  async send(): Promise<void> {}
}

/** Everybody reads Bahasa Indonesia: the language is not what this is about. */
class Indonesian extends RecipientLanguages {
  async languageOf(): Promise<'id'> { return 'id'; }
}

/** One KPM named *Dynamic Smart System*, another with no name. */
class Names extends SystemNames {
  async nameOf(kpmId: string) { return kpmId === NAMED_KPM ? 'Dynamic Smart System' : null; }
}

/**
 * **P19.21-T4 AC-1 — an email to a KPM's member says its *Nama sistem*** (ADR-0274), through the notification service as
 * the app wires it (`SystemNames` injected); a platform email, and one with no KPM, still say AgencyBoost.
 */
describe('P19.21-T4 AC-1 the system name in a KPM’s emails', () => {
  const renderer = new EmailTemplateRenderer({ getOrThrow: () => 'https://app.agencyboost.test' } as unknown as ConfigService);
  let email: CapturingEmail;
  let service: NotificationService;

  async function emails(count: number): Promise<CapturingEmail['sent']> {
    for (let attempt = 0; attempt < 200 && email.sent.length < count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return email.sent;
  }

  beforeAll(async () => {
    await startMongo();
    mongoose.model(Notification.name, NotificationSchema);
    await syncIndexes();
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    email = new CapturingEmail();
    const model = mongoose.model(Notification.name);
    service = new NotificationService(
      model as never,
      new NotificationRepository(model as never),
      mongoose.model(NotificationPreferences.name, NotificationPreferencesSchema) as never,
      renderer,
      new FixedClock(NOW),
      new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never),
      [new InApp(), email],
      new Indonesian(),
      new Names(),
    );
  });

  it('P19.21-T4 AC-1 a member of a KPM with a name reads it in the subject’s tag and the sign-off', async () => {
    await service.send({ userId: 'u-1', kpmId: NAMED_KPM, templateId: NotificationTemplate.ROLE_CHANGED, payload: {} });
    const [{ rendered }] = await emails(1);
    expect(rendered.subject).toBe('[Dynamic Smart System] Peran Anda berubah');
    expect(rendered.body.endsWith('— Dynamic Smart System')).toBe(true);
    expect(`${rendered.subject}${rendered.body}`).not.toContain('AgencyBoost');
  });

  it('P19.21-T4 AC-1 an invitation to the KPM names the app as the KPM calls it', async () => {
    await service.send({
      userId: 'u-2', kpmId: NAMED_KPM, templateId: NotificationTemplate.MEMBER_INVITATION,
      payload: { office: 'KPM Bintaro', token: 't', days: 7, fullName: 'Rina' },
    });
    const [{ rendered }] = await emails(1);
    expect(rendered.subject).toBe('[Dynamic Smart System] Anda diundang ke KPM Bintaro di Dynamic Smart System');
  });

  it('P19.21-T4 AC-1 a KPM with no name, an email with no KPM, and the platform’s own voice keep AgencyBoost', async () => {
    await service.send({ userId: 'u-3', kpmId: PLAIN_KPM, templateId: NotificationTemplate.ROLE_CHANGED, payload: {} });
    await service.send({ userId: 'u-4', templateId: NotificationTemplate.PASSWORD_RESET, payload: { token: 't' } });
    await service.send({
      userId: 'u-5', kpmId: NAMED_KPM, templateId: NotificationTemplate.OWNER_INVITATION,
      payload: { office: 'KPM Bintaro', token: 't', days: 7 },
    });
    const sent = await emails(3);
    expect(sent).toHaveLength(3);
    for (const { rendered } of sent) {
      expect(rendered.subject.startsWith('[AgencyBoost]')).toBe(true);
      expect(rendered.body).not.toContain('Dynamic Smart System');
    }
  });

  it('P19.21-T4 AC-1 a held email, sent when its session is finalized, reads the KPM’s name too', async () => {
    await service.sendCoalesced({
      userId: 'u-6', kpmId: NAMED_KPM, coalesceKey: 's1:1', templateId: NotificationTemplate.GOAL_SET_BY_LEADER,
      payload: { byName: 'Agus', fullName: 'Rina' },
    });
    expect(email.sent).toEqual([]);
    await service.releaseHeld(NAMED_KPM, 's1:1', NotificationTemplate.GOAL_SET_BY_LEADER);
    const [{ rendered }] = await emails(1);
    expect(rendered.subject.startsWith('[Dynamic Smart System]')).toBe(true);
  });
});
