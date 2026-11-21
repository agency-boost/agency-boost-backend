import { withSystemName } from '@/domain/branding/system-name';
import { NotificationTemplate } from '@/modules/notifications/notification.types';

/**
 * **A KPM's *Nama sistem*, for whatever writes to its members outside a screen** (P19.21-T4 AC-1; ADR-0274): the port
 * the notifications read it through, so they import nothing of the branding module but this. `null` is the default,
 * *AgencyBoost*.
 */
export abstract class SystemNames {
  abstract nameOf(kpmId: string): Promise<string | null>;
}

/**
 * **The templates in which AgencyBoost speaks as the platform**, not as the app the KPM's members use: the Super Admin's
 * answer to a leader-limit request, a new KPM's Owner invitation and the subscription quote. Each keeps *AgencyBoost*:
 * the KPM did not write them, and *"Dynamic Smart System approved your request"* would name the wrong party.
 */
export const PLATFORM_VOICE_TEMPLATES: readonly string[] = Object.freeze([
  NotificationTemplate.LEADER_LIMIT_REQUEST_APPROVED,
  NotificationTemplate.LEADER_LIMIT_REQUEST_DECLINED,
  NotificationTemplate.OWNER_INVITATION,
  NotificationTemplate.BILLING_QUOTE_RECEIVED,
]);

/**
 * **A rendered email in the KPM's name** (ADR-0274): subject and body, every *AgencyBoost* written as the KPM's system
 * name — for a request that names a KPM, outside `PLATFORM_VOICE_TEMPLATES`, with a port to ask. Anything else, as it is.
 */
export async function inSystemName<T extends { subject: string; body: string }>(
  names: SystemNames | null | undefined,
  request: { templateId: string; kpmId?: string | null },
  message: T,
): Promise<T> {
  if (!names || !request.kpmId || PLATFORM_VOICE_TEMPLATES.includes(request.templateId)) return message;
  const name = await names.nameOf(request.kpmId);
  if (!name) return message;
  return { ...message, subject: withSystemName(message.subject, name), body: withSystemName(message.body, name) };
}
