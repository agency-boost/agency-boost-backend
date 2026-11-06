import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { readerIn, readerOf, type Reader } from '@/common/i18n/reader';
import type { Language } from '@/domain/constants/language';
import { clearCollections, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { EmailTemplateRenderer } from './email-renderer';
import {
  Notification, NotificationPreferences, NotificationPreferencesSchema, NotificationSchema,
} from './notification.schema';
import { NotificationRepository } from './notification.repository';
import { NotificationService } from './notification.service';
import {
  NotificationChannel, NotificationChannelAdapter, NotificationTemplate, RenderedMessage, SendRequest,
} from './notification.types';
import { RecipientLanguages } from './recipient-languages';
import type { ConfigService } from '@nestjs/config';

const NOW = new Date('2026-10-03T03:00:00Z');

/** The email as the adapter was handed it. */
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

/** Saved languages by user id, and every id asked for. */
class SavedLanguages extends RecipientLanguages {
  asked: string[] = [];
  constructor(private readonly saved: Record<string, Language>) {
    super();
  }
  async languageOf(userId: string): Promise<Language | null> {
    this.asked.push(userId);
    return this.saved[userId] ?? null;
  }
}

/**
 * **P18.10-T5 AC-5 — an email in its recipient's language** (ADR-0179 §7): their saved `users.locale`; for one with
 * none, the language of the request that caused it where that was theirs (the verification and reset emails); else a
 * reader who has chosen nothing — Bahasa Indonesia, since the default went live at P18.10-T4's exit. Read when the email
 * is rendered, off the request.
 */
describe('P18.10-T5 AC-5 the email in its recipient’s language', () => {
  const renderer = new EmailTemplateRenderer({ getOrThrow: () => 'https://app.agencyboost.test' } as unknown as ConfigService);
  let email: CapturingEmail;
  let languages: SavedLanguages;
  let service: NotificationService;

  /** Every email the adapter was handed, once each delivery has settled. */
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
    languages = new SavedLanguages({ 'u-id': 'id', 'u-en': 'en' });
    const model = mongoose.model(Notification.name);
    service = new NotificationService(
      model as never,
      new NotificationRepository(model as never),
      mongoose.model(NotificationPreferences.name, NotificationPreferencesSchema) as never,
      renderer,
      new FixedClock(NOW),
      new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never),
      [new InApp(), email],
      languages,
    );
  });

  it('AC-5 writes it in the recipient’s saved language, subject, greeting and sign-off included', async () => {
    await service.send({ userId: 'u-id', templateId: NotificationTemplate.JOIN_REQUEST_APPROVED, payload: { fullName: 'Rina' } });
    const [{ rendered }] = await emails(1);
    expect(rendered.subject).toBe('[AgencyBoost] Anda sudah bergabung');
    expect(rendered.body.startsWith('Halo Rina,')).toBe(true);
    expect(rendered.body.endsWith('— AgencyBoost')).toBe(true);
    expect(languages.asked).toEqual(['u-id']);
  });

  it('AC-5 a saved English is English, whatever the request that caused it read', async () => {
    await service.send({
      userId: 'u-en', templateId: NotificationTemplate.PASSWORD_RESET, payload: { token: 't', fullName: 'Agus' },
      reader: readerIn('id'),
    });
    const [{ rendered }] = await emails(1);
    expect(rendered.subject).toBe('[AgencyBoost] Reset your password');
  });

  it('AC-5 a verification or reset email for a person with no saved language reads the request that caused it', async () => {
    await service.send({
      userId: 'u-none', templateId: NotificationTemplate.EMAIL_VERIFICATION, payload: { token: 't', fullName: 'Dewi' },
      reader: readerOf({ header: 'id' }),
    });
    const [{ rendered }] = await emails(1);
    expect(rendered.subject).toBe('[AgencyBoost] Verifikasi alamat email Anda');
  });

  it('AC-5 any other email to a person with no saved language reads as nobody’s choice: Bahasa Indonesia, as it is live', async () => {
    await service.send({ userId: 'u-none', templateId: NotificationTemplate.ROLE_CHANGED, payload: {} });
    const [{ rendered }] = await emails(1);
    expect(rendered.subject).toBe('[AgencyBoost] Peran Anda berubah');
    expect(rendered).toEqual(renderer.render(NotificationTemplate.ROLE_CHANGED, {}, readerIn('id')));
  });

  it('AC-5 asks nobody’s language for a notice with no email: the inbox writes its row when it is read', async () => {
    await service.send({ userId: 'u-id', templateId: NotificationTemplate.COACHING_SESSION_FINALIZED, payload: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(email.sent).toEqual([]);
    expect(languages.asked).toEqual([]);
  });

  it('AC-5 a held email, sent when its session is finalized, is written in the recipient’s language too', async () => {
    const kpmId = new mongoose.Types.ObjectId().toString();
    await service.sendCoalesced({
      userId: 'u-id', kpmId, coalesceKey: 's1:1', templateId: NotificationTemplate.GOAL_SET_BY_LEADER,
      payload: { byName: 'Agus', fullName: 'Rina' },
    });
    expect(email.sent).toEqual([]);
    await service.releaseHeld(kpmId, 's1:1', NotificationTemplate.GOAL_SET_BY_LEADER);
    const [{ rendered }] = await emails(1);
    expect(rendered.subject).toBe('[AgencyBoost] Agus mengatur goal Anda');
  });

  it('AC-5 records an email whose words cannot be written as failed, never failing the notice', async () => {
    const broken = new NotificationService(
      mongoose.model(Notification.name) as never,
      new NotificationRepository(mongoose.model(Notification.name) as never),
      mongoose.model(NotificationPreferences.name) as never,
      // The email, rendered for its English recipient, fails; the in-app row's render, for nobody's language — Bahasa
      // Indonesia, as the default is live — does not.
      { render: (_id: string, _payload: Record<string, unknown>, reader?: Reader) => {
        if (reader?.language === 'en') throw new Error('no words');
        return { subject: '', body: '' };
      } } as never,
      new FixedClock(NOW),
      new AuditService(mongoose.model(AuditLog.name) as never),
      [new InApp(), email],
      languages,
    );
    await expect(broken.send({ userId: 'u-en', templateId: NotificationTemplate.ROLE_CHANGED, payload: {} })).resolves.toBeUndefined();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [row] = await mongoose.model(Notification.name).find({}).lean().exec() as unknown as { delivery: { email?: { status: string } } }[];
      if (row?.delivery.email?.status === 'failed') return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('the email was never recorded failed');
  });
});
