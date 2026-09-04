/**
 * Notifications are addressed to a template and a payload, never to a channel.
 *
 * That indirection is the whole point of ADR-0010: v1 wires in-app and email, and
 * adding WhatsApp later is a new adapter plus a template mapping — not a rewrite of
 * the five phases that call this service.
 */

export type NotificationChannel = 'in_app' | 'email';

export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ['in_app', 'email'] as const;

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'suppressed';

/**
 * Every template the product sends. Adding one here forces a decision about which
 * channels it uses, rather than defaulting silently to all of them.
 */
export const NotificationTemplate = {
  JOIN_REQUEST_RECEIVED: 'join_request.received',
  JOIN_REQUEST_APPROVED: 'join_request.approved',
  JOIN_REQUEST_DECLINED: 'join_request.declined',
  MEMBER_TAGGED_BY_LEADER: 'member.tagged_by_leader',
  MEMBER_REMOVED: 'member.removed',
  ROLE_CHANGED: 'member.role_changed',
  GOAL_PROPOSED_BY_LEADER: 'goal.proposed_by_leader',
  COACHING_SESSION_FINALIZED: 'coaching.session_finalized',
  EVENT_REMINDER: 'event.reminder',
  EMAIL_VERIFICATION: 'auth.email_verification',
  PASSWORD_RESET: 'auth.password_reset',
} as const;

export type NotificationTemplateId =
  (typeof NotificationTemplate)[keyof typeof NotificationTemplate];

/**
 * Which channels a template uses.
 *
 * Transactional auth templates are email-only — an in-app notification you cannot see
 * until you sign in is useless for signing in. Everything else defaults to both, with
 * in-app treated as the authoritative channel (ADR-0010: agents live in WhatsApp and
 * will under-read email).
 */
export const TEMPLATE_CHANNELS: Record<NotificationTemplateId, readonly NotificationChannel[]> = {
  [NotificationTemplate.JOIN_REQUEST_RECEIVED]: ['in_app', 'email'],
  [NotificationTemplate.JOIN_REQUEST_APPROVED]: ['in_app', 'email'],
  [NotificationTemplate.JOIN_REQUEST_DECLINED]: ['in_app', 'email'],
  [NotificationTemplate.MEMBER_TAGGED_BY_LEADER]: ['in_app', 'email'],
  [NotificationTemplate.MEMBER_REMOVED]: ['in_app', 'email'],
  [NotificationTemplate.ROLE_CHANGED]: ['in_app', 'email'],
  [NotificationTemplate.GOAL_PROPOSED_BY_LEADER]: ['in_app', 'email'],
  [NotificationTemplate.COACHING_SESSION_FINALIZED]: ['in_app'],
  [NotificationTemplate.EVENT_REMINDER]: ['in_app', 'email'],
  [NotificationTemplate.EMAIL_VERIFICATION]: ['email'],
  [NotificationTemplate.PASSWORD_RESET]: ['email'],
};

export interface SendRequest {
  /** Recipient membership. Auth templates that precede membership use `userId` instead. */
  readonly membershipId?: string;
  readonly userId?: string;
  readonly templateId: NotificationTemplateId;
  readonly payload: Record<string, unknown>;
}

/** A channel implementation. Adding WhatsApp means implementing this once. */
export abstract class NotificationChannelAdapter {
  abstract readonly channel: NotificationChannel;
  abstract send(to: SendRequest, rendered: RenderedMessage): Promise<void>;
}

export interface RenderedMessage {
  readonly subject: string;
  readonly body: string;
}
