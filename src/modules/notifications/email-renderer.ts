import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readerOf, type Reader } from '@/common/i18n/reader';
import { render, type Sentence } from '@/common/i18n/sentence';
import { ROSTER_INVITATION } from '@/domain/constants';
import { describeNotification, inboxAddress } from './inbox-copy';
import { MEMBER_INVITATION_WORDS, OWNER_INVITATION_WORDS } from './member-invitation.messages';
import { EMAIL_MESSAGES } from './notification.messages';
import { quoteEmailLines, QUOTE_WORDS } from './billing-quote.messages';
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
 * **In the recipient's language** (P18.10-T5 AC-5; ADR-0179 §7): the reader `NotificationService` hands it — the
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

      // P19-T1 AC-5 (UI-163, ADR-0190 §5): no token in it — the link asks for a reset, for somebody who did not do this.
      case NotificationTemplate.PASSWORD_CHANGED:
        return compose(say(EMAIL_MESSAGES.passwordChangedSubject), [
          say(EMAIL_MESSAGES.passwordChangedLine),
          '',
          say(EMAIL_MESSAGES.passwordChangedNotYou),
          `${origin}/forgot-password`,
        ]);

      // UI-169 item 5 (ADR-0199 §2): the link goes to the other login's address; the two notices carry no link that applies.
      case NotificationTemplate.ACCOUNT_LINK_REQUEST:
        return compose(say(EMAIL_MESSAGES.linkRequestSubject), [
          say(EMAIL_MESSAGES.linkRequestAsked({ name: str(payload, 'requesterName'), email: str(payload, 'requesterEmail') })),
          '',
          `${origin}/link-account/${str(payload, 'token')}`,
          '',
          say(EMAIL_MESSAGES.linkRequestIgnore),
        ]);

      case NotificationTemplate.ACCOUNT_LINK_REQUESTED:
        return compose(say(EMAIL_MESSAGES.linkNoticeSubject), [
          say(EMAIL_MESSAGES.linkNoticeAsked({ email: str(payload, 'linkEmail') })),
          '',
          say(EMAIL_MESSAGES.linkNoticeNotYou),
        ]);

      case NotificationTemplate.ACCOUNT_LINKED:
        return compose(say(EMAIL_MESSAGES.linkedSubject), [
          say(EMAIL_MESSAGES.linkedLine({ email: str(payload, 'otherEmail') })),
          '',
          say(EMAIL_MESSAGES.linkedNotYou),
          `${origin}/profile`,
        ]);

      // P19.3-T4 (ADR-0205 §10): the member import's invitation — the reset page, which sets their first password.
      case NotificationTemplate.MEMBER_INVITATION: {
        const office = str(payload, 'office');
        const days = typeof payload.days === 'number' ? payload.days : ROSTER_INVITATION.TTL_DAYS;
        return compose(say(MEMBER_INVITATION_WORDS.subject({ office })), [
          say(MEMBER_INVITATION_WORDS.open({ office })),
          '',
          `${origin}/reset-password/${str(payload, 'token')}`,
          '',
          say(MEMBER_INVITATION_WORDS.expires({ days })),
        ]);
      }

      // P19.4-T3 (ADR-0212 §2): a new KPM's Owner — the same reset page, which sets their first password.
      case NotificationTemplate.OWNER_INVITATION: {
        const office = str(payload, 'office');
        const days = typeof payload.days === 'number' ? payload.days : ROSTER_INVITATION.TTL_DAYS;
        return compose(say(OWNER_INVITATION_WORDS.subject({ office })), [
          say(OWNER_INVITATION_WORDS.open({ office })),
          '',
          `${origin}/reset-password/${str(payload, 'token')}`,
          '',
          say(MEMBER_INVITATION_WORDS.expires({ days })),
        ]);
      }

      // P19.4-T3 (ADR-0211 §5): a KPM's quote, to its Owner — the printable quote's content, every figure the server's.
      case NotificationTemplate.BILLING_QUOTE_RECEIVED:
        return compose(say(QUOTE_WORDS.subject({ office: str(payload, 'office') })), quoteEmailLines(payload, say));

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
