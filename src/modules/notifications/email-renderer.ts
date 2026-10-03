import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describeNotification, inboxAddress } from './inbox-copy';
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
 * greeting, and somewhere to go. The two auth templates have no inbox row at all (no
 * `in_app` channel), so their words are written here, and nowhere else says them twice.
 *
 * Links are built from `APP_ORIGIN` — the app's origin, not this API's. A person opens a
 * page, not an endpoint, and the two differ in every environment.
 */
@Injectable()
export class EmailTemplateRenderer extends TemplateRenderer {
  constructor(private readonly config: ConfigService) {
    super();
  }

  render(templateId: string, payload: Record<string, unknown>): RenderedMessage {
    const origin = this.config.getOrThrow<string>('APP_ORIGIN').replace(/\/+$/, '');
    const greeting = (() => {
      const person = str(payload, 'fullName');
      return person ? `Hello ${person},` : 'Hello,';
    })();

    const compose = (subject: string, lines: string[]): RenderedMessage => ({
      subject: `[AgencyBoost] ${subject}`,
      body: [greeting, '', ...lines, '', '— AgencyBoost'].join('\n'),
    });

    switch (templateId) {
      case NotificationTemplate.EMAIL_VERIFICATION:
        return compose('Verify your email address', [
          'Open this link to verify your address. You cannot sign in until you have.',
          '',
          `${origin}/verify-email/${str(payload, 'token')}`,
          '',
          'If you did not create an AgencyBoost account, ignore this — nothing happens '
            + 'until the link is opened.',
        ]);

      case NotificationTemplate.PASSWORD_RESET:
        return compose('Reset your password', [
          'Open this link to choose a new password.',
          '',
          `${origin}/reset-password/${str(payload, 'token')}`,
          '',
          'If you did not ask for this, ignore it. Your password has not changed, and the '
            + 'link expires on its own.',
        ]);

      default: {
        // Everything else already has words, written once for the inbox. Repeating them
        // here is how the two channels would come to disagree. The link is the row's own
        // address where it has one — a calendar notice opens its entry (ADR-0095) — and the
        // inbox otherwise.
        const { title, detail } = describeNotification(templateId, payload);
        return compose(title, [
          detail ?? 'Open AgencyBoost to see what changed.',
          '',
          `${origin}${inboxAddress(templateId, payload) ?? '/notifications'}`,
        ]);
      }
    }
  }
}
