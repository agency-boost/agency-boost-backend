import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import {
  Notification, NotificationDocument,
  NotificationPreferences, NotificationPreferencesDocument,
} from './notification.schema';
import {
  DeliveryStatus, NotificationChannel, NotificationChannelAdapter,
  RenderedMessage, SendRequest, TEMPLATE_CHANNELS,
} from './notification.types';

/** Renders a template id + payload into a subject and body. */
export abstract class TemplateRenderer {
  abstract render(templateId: string, payload: Record<string, unknown>): RenderedMessage;
}

/**
 * Channel-agnostic dispatch.
 *
 * Callers name a template and a recipient. This service decides the channels, honours
 * opt-outs, records per-channel delivery status, and never lets a channel failure take
 * down the operation that triggered the notification.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly adapters = new Map<NotificationChannel, NotificationChannelAdapter>();

  constructor(
    @InjectModel(Notification.name)
    private readonly notifications: Model<NotificationDocument>,
    @InjectModel(NotificationPreferences.name)
    private readonly preferences: Model<NotificationPreferencesDocument>,
    private readonly renderer: TemplateRenderer,
    private readonly clock: Clock,
    adapters: NotificationChannelAdapter[] = [],
  ) {
    for (const adapter of adapters) this.adapters.set(adapter.channel, adapter);
  }

  async send(request: SendRequest & { userId: string; kpmId?: string | null }): Promise<void> {
    const channels = TEMPLATE_CHANNELS[request.templateId] ?? [];
    const prefs = await this.preferences.findOne({ userId: request.userId }).exec();

    // Guard the arrays, not just the document: a preferences row written before a
    // field existed, or a partial upsert, leaves them undefined — and a crash here
    // would take down whatever operation triggered the notification.
    if (prefs?.mutedTemplates?.includes(request.templateId)) {
      this.logger.debug({ templateId: request.templateId }, 'template muted by recipient');
      return;
    }

    const rendered = this.renderer.render(request.templateId, request.payload);
    const delivery: Record<string, { status: DeliveryStatus; at?: Date; error?: string }> = {};

    for (const channel of channels) {
      if (prefs?.optedOutChannels?.includes(channel)) {
        delivery[channel] = { status: 'suppressed', at: this.clock.now() };
        continue;
      }
      const adapter = this.adapters.get(channel);
      if (!adapter) {
        delivery[channel] = { status: 'failed', at: this.clock.now(), error: 'no adapter' };
        continue;
      }
      try {
        await adapter.send(request, rendered);
        delivery[channel] = { status: 'sent', at: this.clock.now() };
      } catch (err) {
        delivery[channel] = {
          status: 'failed',
          at: this.clock.now(),
          error: err instanceof Error ? err.message : String(err),
        };
        this.logger.error({ err, channel, templateId: request.templateId }, 'delivery failed');
      }
    }

    await this.notifications.create({
      kpmId: request.kpmId ?? null,
      membershipId: request.membershipId ?? null,
      userId: request.userId,
      templateId: request.templateId,
      payload: request.payload,
      delivery,
      readAt: null,
    });
  }

  registerAdapter(adapter: NotificationChannelAdapter): void {
    this.adapters.set(adapter.channel, adapter);
  }
}
