import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readerOf, type Reader } from '@/common/i18n/reader';
import { render, type Sentence } from '@/common/i18n/sentence';
import { describeNotification, inboxAddress } from './inbox-copy';
import { EMAIL_MESSAGES } from './notification.messages';
import { NotificationTemplate, RenderedMessage } from './notification.types';
import { TemplateRenderer } from './notification.service';

function str(payload: Record<string, unknown>, key: string, fallback = ''): string {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/**
 * What the transactional mail says (P4-T14).
 *
 * **Plain text, deliberately.** Every one of these messages is one sentence and one link,
 * and a person acts on it inside a minute. HTML would buy nothing and cost the two things
 * that actually matter here: it renders differently in every client, and an HTML link is
 * the shape a phishing filter is most suspicious of.
 *
 * **The in-app copy is the source, not a parallel one.** ADR-0010 makes the inbox the
 * authoritative channel, and `inbox-copy.ts` is the one place a row's words live —
 * "a change here changes what six books say". So every template that has both channels is
 * rendered *from* that copy, with the email adding only what an inbox does not need: a
 * greeting, and somewhere to go. The auth templates have no inbox row at all (no
 * `in_app` channel), so their words are written here, and nowhere else says them twice.
 *
 * Links are built from `APP_ORIGIN` — the app's origin, not this API's. A person opens a
 * page, not an endpoint, and the two differ in every environment.
 *
 * **In the recipient's language** (P18.98-T5 AC-5; ADR-0179 §7): the reader `NotificationService` hands it — the
 * recipient's saved `users.locale`, else the language of the request that caused the email where that was theirs (the
 * verification and reset emails), else a reader who has chosen nothing. The subject, the greeting and the sign-off
 * with it (`EMAIL_MESSAGES`).
 */
@Injectable()
export class EmailTemplateRenderer extends TemplateRenderer {
  constructor(private readonly config: ConfigService) {
    super();
  }

  render(templateId: string, payload: Record<string, unknown>, reader: Reader = readerOf()): RenderedMessage {
    const origin = this.config.getOrThrow<string>('APP_ORIGIN').replace(/\/+$/, '');
    const say = (sentence: Sentence) => render(sentence, reader);
    const greeting = (() => {
      const person = str(payload, 'fullName');
      return person ? say(EMAIL_MESSAGES.hello({ name: person })) : say(EMAIL_MESSAGES.helloNobody);
    })();

    const compose = (subject: string, lines: string[]): RenderedMessage => ({
      subject: say(EMAIL_MESSAGES.subject({ subject })),
      body: [greeting, '', ...lines, '', say(EMAIL_MESSAGES.signOff)].join('\n'),
    });

    switch (templateId) {
      case NotificationTemplate.EMAIL_VERIFICATION:
        return compose(say(EMAIL_MESSAGES.verifySubject), [
          say(EMAIL_MESSAGES.verifyOpen),
          '',
          `${origin}/verify-email/${str(payload, 'token')}`,
          '',
          say(EMAIL_MESSAGES.verifyIgnore),
        ]);

      case NotificationTemplate.PASSWORD_RESET:
        return compose(say(EMAIL_MESSAGES.resetSubject), [
          say(EMAIL_MESSAGES.resetOpen),
          '',
          `${origin}/reset-password/${str(payload, 'token')}`,
          '',
          say(EMAIL_MESSAGES.resetIgnore),
        ]);

      // UI V1 (UI-111, ADR-0181): the link to the new address, and a notice with no link to the old one.
      case NotificationTemplate.EMAIL_CHANGE_VERIFICATION:
        return compose(say(EMAIL_MESSAGES.changeVerifySubject), [
          say(EMAIL_MESSAGES.changeVerifyOpen),
          '',
          `${origin}/verify-email-change/${str(payload, 'token')}`,
          '',
          say(EMAIL_MESSAGES.changeVerifyIgnore),
        ]);

      case NotificationTemplate.EMAIL_CHANGE_REQUESTED:
        return compose(say(EMAIL_MESSAGES.changeNoticeSubject), [
          say(EMAIL_MESSAGES.changeNoticeAsked({ newEmail: str(payload, 'newEmail') })),
          '',
          say(EMAIL_MESSAGES.changeNoticeNotYou),
        ]);

      default: {
        // Everything else already has words, written once for the inbox. Repeating them
        // here is how the two channels would come to disagree. The link is the row's own
        // address where it has one — a calendar notice opens its entry (ADR-0095) — and the
        // inbox otherwise.
        const { title, detail } = describeNotification(templateId, payload, reader);
        return compose(title, [
          detail ?? say(EMAIL_MESSAGES.seeWhatChanged),
          '',
          `${origin}${inboxAddress(templateId, payload) ?? '/notifications'}`,
        ]);
      }
    }
  }
}
