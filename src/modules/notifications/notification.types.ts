/**
 * Notifications are addressed to a template and a payload, never to a channel.
 *
 * That indirection is the whole point of ADR-0010: v1 wires in-app and email, and
 * adding WhatsApp later is a new adapter plus a template mapping — not a rewrite of
 * the five phases that call this service.
 */

import type { Reader } from '@/common/i18n/reader';

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
   * P18.8-T3 (ADR-0170): the invitee accepted a leader's invite and is in their unit, to the leader; a transfer
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
   * so the notice names its time and place (P18.7-T7 AC-4; `inbox-copy.ts`). A reminder written before those four,
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
  /*
   * A change of the account's email (UI V1, UI-111; ADR-0181): the link that applies it, **to the new address**
   * (`SendRequest.toAddress`), and a notice that it was asked for, to the address the account has now, with no link
   * that applies anything. Email only, as the two above: the link proves the mailbox, and an inbox row proves nothing.
   */
  EMAIL_CHANGE_VERIFICATION: 'auth.email_change_verification',
  EMAIL_CHANGE_REQUESTED: 'auth.email_change_requested',
  /*
   * **The password was changed** (P19-T1 AC-5; UI-163, ADR-0190 §5): after a reset and after a change from *Profil
   * saya*, to the address the account has. No token — a link to ask for a reset, for somebody who did not do it. Email
   * only, as the auth templates above: it is about the account, and every session was just signed out.
   */
  PASSWORD_CHANGED: 'auth.password_changed',
  /*
   * **A linked login** (UI-169 item 5; ADR-0199 §2): the link, **to the other login's address** (B), naming who asked;
   * a notice that it was asked for, to the starting login's (A), with no link that applies anything; and, once it is
   * confirmed, a notice to both, each naming the other login. Email only, as every auth template: the link proves the
   * mailbox, and a notice about the account must reach whoever holds the mailbox, signed in or not.
   */
  ACCOUNT_LINK_REQUEST: 'auth.account_link_request',
  ACCOUNT_LINK_REQUESTED: 'auth.account_link_requested',
  ACCOUNT_LINKED: 'auth.account_linked',
  /*
   * **A new person added by a member import** (P19.3-T4; ADR-0205 §10): a one-time link to choose their password, through
   * the reset link's mechanism, worded as an invitation. Email only (ADR-0010): it is about an account nobody has signed in
   * to yet, so an inbox row would wait for a sign-in the link exists to make possible. Not one of `AUTH_TEMPLATES`: the
   * person has chosen nothing, so their choices cannot stop it, and it is a notice the office sent, not the account's own.
   */
  MEMBER_INVITATION: 'member.invitation',
  /*
   * **The Owner a KPM was made with, invited** (ADR-0212 §2; P19.4-T3 AC-6): the member invitation's mechanism — a
   * one-time link to choose a password, alive for `ROSTER_INVITATION.TTL_DAYS` — worded for an Owner: the KPM's code
   * and branch, and that they run it. Sent by *KPM baru*'s *"Kirim undangan … sekarang"*, by *Ganti pemilik* to a new
   * person, and by *Kirim ulang undangan*. Email only (ADR-0010): nothing goes by WhatsApp, and an inbox row would wait
   * for the sign-in the link exists to make possible. Not one of `AUTH_TEMPLATES`, as the member invitation is not.
   */
  OWNER_INVITATION: 'kpm.owner_invitation',
  /*
   * **The Super Admin applied a template's sections to the office** (ADR-0208 §7; OD-260's default), to its Owner and
   * Admins: the template's name, the sections (`kinds`) and whether they wait for the office's own publish
   * (`awaitingPublish`). In-app only: the push changes settings, not anybody's account.
   */
  TEMPLATE_APPLIED: 'template.applied',
  /*
   * **The template's Data upload changed** (P19.5-T1 AC-17; AA UI-019; ADR-0214 §4), to each Owner and each Admin of
   * every KPM on the template, once per person per publish: the template's name and version, and the columns it added
   * with their start months. Only for a publish that changes the columns, the archive or the upload rules. In-app only:
   * nothing is emailed.
   */
  ANALYTICS_TEMPLATE_PUBLISHED: 'analytics_template.published',
  /*
   * **A subscription quote for the KPM** (ADR-0211 §5; P19.4-T3 AC-10), to its Owner alone — never the Admins, because
   * commercial terms are the Owner's. In-app and email: the email carries the printable quote's content (`QUOTE_WORDS`),
   * the inbox row what came and its total. The payload is the server's figures and the dialog's names, never a client's
   * total. The recipient's choices apply as to any notice.
   */
  BILLING_QUOTE_RECEIVED: 'billing.quote_received',
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
  [NotificationTemplate.EMAIL_CHANGE_VERIFICATION]: ['email'],
  [NotificationTemplate.EMAIL_CHANGE_REQUESTED]: ['email'],
  [NotificationTemplate.PASSWORD_CHANGED]: ['email'],
  [NotificationTemplate.ACCOUNT_LINK_REQUEST]: ['email'],
  [NotificationTemplate.ACCOUNT_LINK_REQUESTED]: ['email'],
  [NotificationTemplate.ACCOUNT_LINKED]: ['email'],
  [NotificationTemplate.MEMBER_INVITATION]: ['email'],
  [NotificationTemplate.OWNER_INVITATION]: ['email'],
  [NotificationTemplate.TEMPLATE_APPLIED]: ['in_app'],
  [NotificationTemplate.ANALYTICS_TEMPLATE_PUBLISHED]: ['in_app'],
  [NotificationTemplate.BILLING_QUOTE_RECEIVED]: ['in_app', 'email'],
};

/**
 * **The account's own mail** (P19-T1 AC-6; UI-163, ADR-0190 §5): verifying the address, resetting the password, the
 * password changed, and an email change's link and notice. **Sent whatever the recipient chose for notification
 * email** — an opted-out channel or a muted template is a choice about notices, and somebody who turned them off must
 * still be able to verify, reset, and hear that their password changed. Each send's outcome is logged, sent or failed
 * (AC-7), so a mail that never arrived can be found.
 */
export const AUTH_TEMPLATES: readonly NotificationTemplateId[] = [
  NotificationTemplate.EMAIL_VERIFICATION,
  NotificationTemplate.PASSWORD_RESET,
  NotificationTemplate.PASSWORD_CHANGED,
  NotificationTemplate.EMAIL_CHANGE_VERIFICATION,
  NotificationTemplate.EMAIL_CHANGE_REQUESTED,
  // UI-169 item 5 (ADR-0199 §2): the linked login's link and its two notices, sent whatever the reader opted out of.
  NotificationTemplate.ACCOUNT_LINK_REQUEST,
  NotificationTemplate.ACCOUNT_LINK_REQUESTED,
  NotificationTemplate.ACCOUNT_LINKED,
];

export function isAuthTemplate(templateId: string): boolean {
  return (AUTH_TEMPLATES as readonly string[]).includes(templateId);
}

export interface SendRequest {
  /** Recipient membership. Auth templates that precede membership use `userId` instead. */
  readonly membershipId?: string;
  readonly userId?: string;
  readonly templateId: NotificationTemplateId;
  readonly payload: Record<string, unknown>;
  /**
   * **The reader of the request that caused it**, for a recipient with no saved language (P18.10-T5 AC-5): set only
   * where that request was the recipient's own — the verification and reset emails, whose page asked for them in its
   * language. Every other email reads the recipient's `users.locale`, or a reader who has chosen nothing.
   */
  readonly reader?: Reader;
  /**
   * **An address the account does not have yet** (UI V1, UI-111; ADR-0181): the email change's link goes to the new
   * address, which is not `users.email` until that link is opened. The email channel sends there instead of looking
   * the recipient up; every other send leaves it unset, so mail goes to the address the account has at sending.
   */
  readonly toAddress?: string;
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
