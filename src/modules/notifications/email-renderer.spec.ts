import { ConfigService } from '@nestjs/config';
import { EmailTemplateRenderer } from './email-renderer';
import { NotificationTemplate, TEMPLATE_CHANNELS } from './notification.types';

const config = { getOrThrow: () => 'https://app.agencyboost.test' } as unknown as ConfigService;
const renderer = new EmailTemplateRenderer(config);

describe('what the transactional mail says (P4-T14)', () => {
  describe('the two templates that have no inbox row', () => {
    it('gives verification a link a person can open, and says what it is for', () => {
      // AC-4. This is the message whose absence meant a registered person could never
      // sign in — the link is the entire product of the email.
      const { subject, body } = renderer.render(NotificationTemplate.EMAIL_VERIFICATION, {
        token: 'tok-123', fullName: 'Rina Wijaya',
      });
      expect(subject).toBe('[AgencyBoost] Verify your email address');
      expect(body).toContain('Hello Rina Wijaya,');
      expect(body).toContain('https://app.agencyboost.test/verify-email/tok-123');
      expect(body).toContain('cannot sign in until');
    });

    it('gives reset a link, and tells somebody who did not ask that nothing has changed', () => {
      const { subject, body } = renderer.render(NotificationTemplate.PASSWORD_RESET, {
        token: 'tok-456', fullName: 'Rina',
      });
      expect(subject).toBe('[AgencyBoost] Reset your password');
      expect(body).toContain('https://app.agencyboost.test/reset-password/tok-456');
      expect(body).toContain('Your password has not changed');
    });

    it('points at the app, not at this API', () => {
      // A person opens a page, not an endpoint, and the two differ in every environment.
      const { body } = renderer.render(NotificationTemplate.EMAIL_VERIFICATION, { token: 't' });
      expect(body).toContain('https://app.agencyboost.test/verify-email/t');
    });

    it('does not put a double slash in the link when the origin carries a trailing one', () => {
      const trailing = { getOrThrow: () => 'https://app.test/' } as unknown as ConfigService;
      const { body } = new EmailTemplateRenderer(trailing)
        .render(NotificationTemplate.PASSWORD_RESET, { token: 't' });
      expect(body).toContain('https://app.test/reset-password/t');
      expect(body).not.toContain('app.test//');
    });

    it('greets somebody whose name it does not have, without a hole in the sentence', () => {
      const { body } = renderer.render(NotificationTemplate.EMAIL_VERIFICATION, { token: 't' });
      expect(body).toContain('Hello,');
      expect(body).not.toContain('undefined');
    });
  });

  describe('every other template', () => {
    it('says what the inbox says, rather than a second set of words', () => {
      /*
       * ADR-0010 makes the inbox authoritative and `inbox-copy.ts` the one place a row's
       * words live — "a change here changes what six books say". An email composing its
       * own wording is how the two channels come to disagree about the same event.
       */
      const { subject, body } = renderer.render(NotificationTemplate.JOIN_REQUEST_APPROVED, {
        fullName: 'Rina',
      });
      expect(subject).toBe('[AgencyBoost] You are in');
      expect(body).toContain('Your request was approved. You now have a leader.');
      expect(body).toContain('https://app.agencyboost.test/notifications');
    });

    it('P12-T4 AC-7 a calendar notice’s email links to the address its row opens, built from APP_ORIGIN', () => {
      const entryId = '66f0000000000000000000e1';
      const invited = renderer.render(NotificationTemplate.CALENDAR_INVITATION, { entryId, date: '2026-10-05' });
      expect(invited.subject).toBe('[AgencyBoost] You have a new invitation');
      expect(invited.body).toContain(`https://app.agencyboost.test/calendar?entry=${entryId}&date=2026-10-05`);
      const cancelled = renderer.render(NotificationTemplate.CALENDAR_ENTRY_CHANGED, {
        entryId, date: '2026-10-05', change: 'cancelled',
      });
      expect(cancelled.subject).toBe('[AgencyBoost] An entry on your calendar was cancelled');
      expect(cancelled.body).toContain('https://app.agencyboost.test/calendar?date=2026-10-05');
      expect(cancelled.body).not.toContain('/notifications');
    });

    it('renders every template that declares an email channel, with no empty body', () => {
      // A template added without copy would otherwise ship an email saying nothing.
      const emailTemplates = Object.entries(TEMPLATE_CHANNELS)
        .filter(([, channels]) => channels.includes('email'))
        .map(([id]) => id);
      expect(emailTemplates.length).toBeGreaterThan(5);

      for (const id of emailTemplates) {
        const { subject, body } = renderer.render(id, { token: 't', fullName: 'X' });
        expect(subject.startsWith('[AgencyBoost] ')).toBe(true);
        expect(subject.length).toBeGreaterThan('[AgencyBoost] '.length);
        expect(body.trim().length).toBeGreaterThan(20);
      }
    });
  });
});
