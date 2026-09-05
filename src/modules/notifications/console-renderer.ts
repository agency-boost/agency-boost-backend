import { Injectable, Logger } from '@nestjs/common';
import { RenderedMessage } from './notification.types';
import { TemplateRenderer } from './notification.service';

/**
 * Phase 1–2 renderer: writes the message to the log instead of sending it.
 *
 * There is no SMTP in development, and verification and reset flows are unusable
 * without seeing the token. This makes the token visible in the API log so those flows
 * can be exercised end to end. A real renderer with templates arrives with the email
 * adapter; this one is guarded to non-production by ConsoleTemplateRenderer's own
 * check so a production deploy cannot accidentally log a reset token.
 */
@Injectable()
export class ConsoleTemplateRenderer extends TemplateRenderer {
  private readonly logger = new Logger('Notification');

  render(templateId: string, payload: Record<string, unknown>): RenderedMessage {
    const rendered = {
      subject: `[AgencyBoost] ${templateId}`,
      body: JSON.stringify(payload),
    };
    if (process.env.NODE_ENV !== 'production') {
      this.logger.log({ templateId, payload }, 'notification rendered (not sent)');
    }
    return rendered;
  }
}
