import { NotificationTemplate, NotificationTemplateId, TEMPLATE_CHANNELS } from './notification.types';

/** The templates that belong in an inbox: the ones with an `in_app` channel. */
export const IN_APP_TEMPLATES: readonly string[] = Object.entries(TEMPLATE_CHANNELS)
  .filter(([, channels]) => channels.includes('in_app'))
  .map(([id]) => id);

function name(payload: Record<string, unknown>, key: string, fallback: string): string {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/**
 * What a notification says, in words.
 *
 * **Composed on the server, deliberately.** ADR-0010 makes the in-app inbox the
 * authoritative channel — *"v1 notifications will be under-read, because agents live in
 * WhatsApp… the in-app inbox, not email, is treated as the authoritative channel for
 * anything the product depends on"* — so what a row says is product copy, not a
 * rendering detail a client may improvise. One source, quoted by the manual books.
 *
 * Separate from `TemplateRenderer`, which composes **email** and is still the console
 * placeholder until the email adapter lands. The two will share templates then; today
 * they say different things because only one of them has anything to say.
 *
 * A template with no entry falls back to something true rather than throwing: an inbox
 * that breaks on an unrecognised row is worse than one that says *"Something happened"*.
 */
export function describeNotification(
  templateId: string,
  payload: Record<string, unknown>,
): { title: string; detail: string | null } {
  switch (templateId) {
    case NotificationTemplate.JOIN_REQUEST_RECEIVED:
      return {
        title: `${name(payload, 'fullName', 'Somebody')} asked to join your unit`,
        detail: 'Approve or decline it on Pending requests.',
      };
    case NotificationTemplate.JOIN_REQUEST_APPROVED:
      return { title: 'You are in', detail: 'Your request was approved. You now have a leader.' };
    case NotificationTemplate.JOIN_REQUEST_DECLINED:
      return {
        title: 'Your request was declined',
        detail: name(payload, 'reason', 'You can search for another leader and ask again.'),
      };
    case NotificationTemplate.MEMBER_TAGGED_BY_LEADER:
      return {
        title: 'A leader added you to their unit',
        detail: 'You did not have to ask — they picked you up from the unassigned list.',
      };
    case NotificationTemplate.MEMBER_REMOVED:
      return {
        title: 'You were removed from your unit',
        detail: name(payload, 'reason', 'Search for a leader and ask to join again if you want to come back.'),
      };
    case NotificationTemplate.ROLE_CHANGED:
      return {
        title: 'Your role changed',
        detail: name(payload, 'reason', 'Your leader changed what you are. You still report to them.'),
      };
    case NotificationTemplate.ADMIN_ACCESS_CHANGED:
      return payload.granted === true
        ? { title: 'You can now administer this office', detail: 'The Owner gave you KPM Admin access.' }
        : { title: 'Your admin access was removed', detail: 'You are still in the office; you just cannot administer it.' };
    case NotificationTemplate.GOAL_PROPOSED_BY_LEADER:
      return { title: 'Your leader proposed a goal', detail: 'Open Goals to accept it or talk about it.' };
    case NotificationTemplate.COACHING_SESSION_FINALIZED:
      return { title: 'A coaching session was finalised', detail: 'What was agreed is now on the record.' };
    case NotificationTemplate.IMPERSONATION_STARTED:
      return payload.isSubject === true
        ? {
          title: 'Somebody from AgencyBoost is looking at your screens',
          detail: `${name(payload, 'reason', 'A support session has started.')} `
            + 'They can only look, unless a second person approves otherwise.',
        }
        : {
          title: 'A support session started in your office',
          detail: name(payload, 'reason', 'Somebody from AgencyBoost is helping a member.'),
        };
    case NotificationTemplate.IMPERSONATION_ELEVATED:
      return {
        title: 'That support session can now make changes',
        detail: name(payload, 'reason', 'A second person from AgencyBoost approved it.'),
      };
    case NotificationTemplate.EVENT_REMINDER:
      return {
        title: `${name(payload, 'title', 'An event')} is coming up`,
        detail: 'Check the time and where it is.',
      };
    default:
      // Includes the email-only templates, which the inbox filters out before this is
      // reached — so this is genuinely for a template nobody has written copy for yet.
      return { title: 'Something happened', detail: null };
  }
}

export type { NotificationTemplateId };
