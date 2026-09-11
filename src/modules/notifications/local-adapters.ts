import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationChannel, NotificationChannelAdapter, RenderedMessage, SendRequest,
} from './notification.types';

/**
 * The in-app channel, whose delivery **is** the row.
 *
 * `NotificationService` writes the notification document itself; there is nothing further
 * to hand anywhere. Without this, every in-app send recorded `failed: 'no adapter'` beside
 * a row that had in fact been delivered — a delivery record that contradicted the thing
 * it was recording.
 */
@Injectable()
export class InAppChannelAdapter extends NotificationChannelAdapter {
  readonly channel: NotificationChannel = 'in_app';

  async send(): Promise<void> {
    // Nothing to do. The row is the delivery.
  }
}

/**
 * Development delivery: the message, in the log, exactly as it would have been sent.
 *
 * This replaces `ConsoleTemplateRenderer`, which logged the raw **payload** — a JSON blob
 * with a bare token in it — and did so from inside the renderer, where nothing about
 * delivery belongs. Logging the rendered message instead means a developer reads the same
 * words, and clicks the same link, that production sends.
 *
 * Chosen only outside production, by the factory in `app.module.ts`. Falling back to this
 * in production is the defect ADR-0019 exists to end.
 */
@Injectable()
export class LogEmailAdapter extends NotificationChannelAdapter {
  readonly channel: NotificationChannel = 'email';
  private readonly logger = new Logger('Email');

  async send(to: SendRequest, rendered: RenderedMessage): Promise<void> {
    this.logger.log(
      `\n── would send to ${to.userId ?? '(unknown)'} ──\n`
        + `${rendered.subject}\n\n${rendered.body}\n──`,
    );
  }
}
