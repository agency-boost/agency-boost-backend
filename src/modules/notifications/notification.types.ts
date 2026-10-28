/**
 * Notifications are addressed to a template and a payload, never to a channel.
 *
 * That indirection is the whole point of ADR-0010: v1 wires in-app and email, and
 * adding WhatsApp later is a new adapter plus a template mapping — not a rewrite of
 * the five phases that call this service.
 */

export type NotificationChannel = 'in_app' | 'email';

export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ['in_app', 'email'] as const;

/**
 * Where one channel's delivery stands. **`held`** is a coalesced notice's email, kept back until the
 * coaching session it belongs to is finalized and then sent once (`functional/coaching.md`, *One notice
 * per session*); `pending` is that email claimed for sending, between the claim and the adapter's answer.
 */
export type DeliveryStatus = 'pending' | 'held' | 'sent' | 'failed' | 'suppressed';

/**
 * Every template the product sends. Adding one here forces a decision about which
 * channels it uses, rather than defaulting silently to all of them.
 */
export const NotificationTemplate = {
  JOIN_REQUEST_RECEIVED: 'join_request.received',
  JOIN_REQUEST_APPROVED: 'join_request.approved',
  JOIN_REQUEST_DECLINED: 'join_request.declined',
  MEMBER_TAGGED_BY_LEADER: 'member.tagged_by_leader',
  /*
   * P18.96-T3 (ADR-0170): the invitee accepted a leader's invite and is in their unit, to the leader; a transfer
   * request, to the office's Owner and Admins; and its decision — to whoever asked, and when approved to the member and
   * the leader they left (`payload.audience`). The payload names people by their names and ids, never a phone.
   */
  MEMBER_INVITE_ACCEPTED: 'member_invite.accepted',
  TRANSFER_REQUEST_RECEIVED: 'transfer_request.received',
  TRANSFER_REQUEST_DECIDED: 'transfer_request.decided',
  MEMBER_REMOVED: 'member.removed',
  ROLE_CHANGED: 'member.role_changed',
  ADMIN_ACCESS_CHANGED: 'member.admin_access_changed',
  /*
   * AgencyBoost's answer to a leader past the office's limit (ADR-0157 §3), to whoever asked. The payload is the
   * subject's name and, for a decline, the reason — the request says the rest.
   */
  LEADER_LIMIT_REQUEST_APPROVED: 'leader_limit_request.approved',
  LEADER_LIMIT_REQUEST_DECLINED: 'leader_limit_request.declined',
  /**
   * A leader set somebody's goal (§3.6, ADR-0046).
   *
   * **This was `GOAL_PROPOSED_BY_LEADER: 'goal.proposed_by_leader'` until 2026-09-26** — the
   * fourth artefact written from OD-09's *propose and accept* recommendation before anything
   * ratified it, after `goals.acceptedByAgentAt`, `GOAL_ACCEPTANCE_REQUIRED`, and the spec's own
   * permission table. ADR-0046 settled it the other way: a leader sets the goal directly, and what
   * the agent is owed is knowing.
   *
   * It is renamed rather than left alone because **the copy is what a person reads**, and the old
   * copy told them to *accept* something no screen offers. Nothing had ever written the old id —
   * no service, no seed, no fixture — so there are no rows to migrate.
   */
  GOAL_SET_BY_LEADER: 'goal.set_by_leader',
  COACHING_SESSION_FINALIZED: 'coaching.session_finalized',
  /*
   * The calendar's three (ADR-0095; `functional/calendar.md`, *Notifications*): an invitation to each
   * invitee added, a block to the member it was placed on, and a change — moved or cancelled — to each
   * attendee of a future entry. The payload is ids and the entry's office date, never anything typed.
   */
  CALENDAR_INVITATION: 'calendar.invitation',
  CALENDAR_BLOCK_PLACED: 'calendar.block_placed',
  CALENDAR_ENTRY_CHANGED: 'calendar.entry_changed',
  /*
   * An office event is coming up. The payload is the event as it stood when the reminder went: `eventId`, its
   * `title`, `startsAt` (the instant, ISO) with the office's `timezone` that instant is read in, and its `location` —
   * so the notice names its time and place (P18.95-T7 AC-4; `inbox-copy.ts`). A reminder written before those four,
   * with its title alone, still reads, in the words it had.
   */
  EVENT_REMINDER: 'event.reminder',
  /*
   * A support session, announced to the person and their Owner (§3.13, P4-T10).
   *
   * `in_app` **and** email, deliberately: this is the one class of notification whose
   * whole purpose is that it cannot be missed, and the inbox is only read by somebody who
   * opens the product.
   */
  IMPERSONATION_STARTED: 'impersonation.started',
  IMPERSONATION_ELEVATED: 'impersonation.elevated',
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
  [NotificationTemplate.MEMBER_INVITE_ACCEPTED]: ['in_app', 'email'],
  [NotificationTemplate.TRANSFER_REQUEST_RECEIVED]: ['in_app', 'email'],
  [NotificationTemplate.TRANSFER_REQUEST_DECIDED]: ['in_app', 'email'],
  [NotificationTemplate.MEMBER_REMOVED]: ['in_app', 'email'],
  [NotificationTemplate.ROLE_CHANGED]: ['in_app', 'email'],
  [NotificationTemplate.ADMIN_ACCESS_CHANGED]: ['in_app', 'email'],
  [NotificationTemplate.LEADER_LIMIT_REQUEST_APPROVED]: ['in_app', 'email'],
  [NotificationTemplate.LEADER_LIMIT_REQUEST_DECLINED]: ['in_app', 'email'],
  [NotificationTemplate.GOAL_SET_BY_LEADER]: ['in_app', 'email'],
  [NotificationTemplate.COACHING_SESSION_FINALIZED]: ['in_app'],
  // The inbox always, as ADR-0010's authoritative channel; email by the member's preferences.
  [NotificationTemplate.CALENDAR_INVITATION]: ['in_app', 'email'],
  [NotificationTemplate.CALENDAR_BLOCK_PLACED]: ['in_app', 'email'],
  [NotificationTemplate.CALENDAR_ENTRY_CHANGED]: ['in_app', 'email'],
  [NotificationTemplate.EVENT_REMINDER]: ['in_app', 'email'],
  [NotificationTemplate.IMPERSONATION_STARTED]: ['in_app', 'email'],
  [NotificationTemplate.IMPERSONATION_ELEVATED]: ['in_app', 'email'],
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
