import { formatDateTime } from '@/common/format/format';
import { NotificationTemplate, NotificationTemplateId, TEMPLATE_CHANNELS } from './notification.types';

/** The templates that belong in an inbox: the ones with an `in_app` channel. */
export const IN_APP_TEMPLATES: readonly string[] = Object.entries(TEMPLATE_CHANNELS)
  .filter(([, channels]) => channels.includes('in_app'))
  .map(([id]) => id);

function name(payload: Record<string, unknown>, key: string, fallback: string): string {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

/** The first of these keys the payload holds a name under, or the fallback: one notice, written by two senders. */
function nameOf(payload: Record<string, unknown>, keys: readonly string[], fallback: string): string {
  for (const key of keys) {
    const value = name(payload, key, '');
    if (value) return value;
  }
  return fallback;
}

/**
 * **Who asked to join** (P18.96-T1 AC-3). `requestLeader` writes the asker's name as `askerName`; the demo seed and
 * every notice stored before this read wrote `fullName`. The template read only `fullName`, so every real request
 * said *"Somebody asked to join your unit"*. Either is the asker's name; `askerName` first, as the sender writes it.
 */
const ASKER_KEYS = ['askerName', 'fullName'] as const;

/** **Who walked in with the leader's code** (`LeaderCodeService.redeem`), the one `MEMBER_TAGGED_BY_LEADER` sent to a leader. */
const JOINER_KEYS = ['joinerName', 'fullName'] as const;

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
        title: `${nameOf(payload, ASKER_KEYS, 'Somebody')} asked to join your unit`,
        // The tab's own name: the row opens it (`inboxAddress`).
        detail: 'Approve or decline it under Review requests on New hires.',
      };
    case NotificationTemplate.JOIN_REQUEST_APPROVED:
      return { title: 'You are in', detail: 'Your request was approved. You now have a leader.' };
    case NotificationTemplate.JOIN_REQUEST_DECLINED:
      return {
        title: 'Your request was declined',
        detail: name(payload, 'reason', 'You can search for another leader and ask again.'),
      };
    case NotificationTemplate.MEMBER_TAGGED_BY_LEADER:
      /*
       * **One template, two readers** (P18.96-T1 AC-3). A tag (`ApprovalsService.tag`, or AgencyBoost approving one
       * past the leader limit) tells the member, `via: 'tagged'`; a leader code redeemed (`LeaderCodeService.redeem`)
       * tells the **leader** whose code it was, `via: 'leader-code'`. The member's sentence reached the leader, who
       * read *"A leader added you to their unit"* about somebody joining theirs.
       */
      if (payload.via === 'leader-code') {
        return {
          title: `${nameOf(payload, JOINER_KEYS, 'Somebody')} joined your unit with your leader code`,
          detail: 'A leader code needs no approval, so they are in your unit already.',
        };
      }
      return {
        title: 'A leader added you to their unit',
        detail: 'You did not have to ask — they picked you up from the unassigned list.',
      };
    /*
     * P18.96-T3 (ADR-0170 §2, §4): an invite accepted, a transfer asked for, and its decision — which reads by who it
     * is addressed to (`audience`): whoever asked, the member who moved, or the leader they left.
     */
    case NotificationTemplate.MEMBER_INVITE_ACCEPTED:
      return {
        title: `${nameOf(payload, JOINER_KEYS, 'Somebody')} accepted your invite and joined your unit`,
        detail: 'They are in your unit now, with the join date you gave.',
      };
    case NotificationTemplate.TRANSFER_REQUEST_RECEIVED:
      return {
        title: `${name(payload, 'requesterName', 'A leader')} asked to move ${name(payload, 'memberName', 'a member')} into their unit`,
        detail: 'Approve or decline it on All Members, under Pending.',
      };
    case NotificationTemplate.TRANSFER_REQUEST_DECIDED:
      return transferDecided(payload);
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
    /*
     * ADR-0157 §3: AgencyBoost's answer to a leader past the office's limit, to whoever asked. Approved, the change
     * is already made; declined, nothing about the member changed, and the reason is the Super Admin's.
     */
    case NotificationTemplate.LEADER_LIMIT_REQUEST_APPROVED:
      return {
        title: `AgencyBoost approved your request for ${name(payload, 'subjectName', 'a new leader')}`,
        detail: 'The change is made: they are a leader now, past your office’s limit.',
      };
    case NotificationTemplate.LEADER_LIMIT_REQUEST_DECLINED:
      return {
        title: `AgencyBoost declined your request for ${name(payload, 'subjectName', 'a new leader')}`,
        detail: name(payload, 'reason', 'Nothing about them changed.'),
      };
    case NotificationTemplate.GOAL_SET_BY_LEADER:
      /*
       * **Not *"accept it"*.** There is nothing to accept: a leader's write is the agent's goal
       * immediately (ADR-0046), and the copy that sent somebody looking for a button no screen has
       * was written from a recommendation nothing had ratified.
       */
      return {
        title: `${name(payload, 'byName', 'Your leader')} set your goal`,
        detail: 'Open Goal settings to see it — you can change it, it is your plan.',
      };
    case NotificationTemplate.COACHING_SESSION_FINALIZED:
      return { title: 'A coaching session was finalized', detail: 'What was agreed is now on the record.' };
    /*
     * The calendar's (ADR-0095, in ADR-0096's words): general, because the payload carries ids and a date
     * and nothing anybody typed — the entry says the rest.
     */
    case NotificationTemplate.CALENDAR_INVITATION:
      return { title: 'You have a new invitation', detail: 'Open it on your calendar to accept or decline.' };
    case NotificationTemplate.CALENDAR_BLOCK_PLACED:
      return { title: 'Time was blocked on your calendar', detail: 'A leader above you placed it. Open it to see when.' };
    case NotificationTemplate.CALENDAR_ENTRY_CHANGED:
      return payload.change === 'cancelled'
        ? { title: 'An entry on your calendar was cancelled', detail: 'It is no longer on your calendar.' }
        : { title: 'An entry on your calendar has moved', detail: 'Open it to see the new time.' };
    case NotificationTemplate.IMPERSONATION_STARTED:
      /*
       * **A setup session says so, and what it may change** (ADR-0162 §3): it writes in the person's name, which
       * a support session does not, so the notice that said *"They can only look"* would be untrue of it.
       */
      if (payload.purpose === 'setup') {
        return payload.isSubject === true
          ? {
            title: 'Somebody from AgencyBoost is setting up your office as you',
            detail: `${name(payload, 'reason', 'A setup session has started.')} `
              + 'They can change the office\'s settings, import people and upload production files, and nothing else.',
          }
          : {
            title: 'A setup session started in your office',
            detail: `${name(payload, 'reason', 'Somebody from AgencyBoost is helping set up your office.')} `
              + 'They can change the office\'s settings, import people and upload production files, and nothing else.',
          };
      }
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
        detail: whenAndWhere(payload) ?? 'Check the time and where it is.',
      };
    default:
      // Includes the email-only templates, which the inbox filters out before this is
      // reached — so this is genuinely for a template nobody has written copy for yet.
      return { title: 'Something happened', detail: null };
  }
}

/** **A transfer request's decision** (ADR-0170 §4), in the words of whoever it is addressed to. */
function transferDecided(payload: Record<string, unknown>): { title: string; detail: string | null } {
  const member = name(payload, 'memberName', 'a member');
  const to = name(payload, 'toLeaderName', 'another leader');
  if (payload.audience === 'member') {
    return { title: `You now report to ${to}`, detail: 'Your office moved you to their unit. Your history stays with you.' };
  }
  if (payload.audience === 'from_leader') {
    return { title: `${member} moved to ${to}’s unit`, detail: 'Your office approved a transfer, so they have left your unit.' };
  }
  return payload.decision === 'approved'
    ? { title: `Your request to move ${member} was approved`, detail: 'They are in your unit now.' }
    : { title: `Your request to move ${member} was declined`, detail: name(payload, 'reason', 'They stay where they are.') };
}

/**
 * **An event's time and place**, the reminder's detail (P18.95-T7 AC-4; the client's UI review of 2026-10-26, UI-030):
 * *9 Nov 2026, 09.00 · Kantor KPM* — its start on the office's clock, through the shared formatter (ADR-0167 §1), and
 * where it is as the office wrote it. It said *"Check the time and where it is."*, which sent the reader looking for
 * both. Either half alone when the payload holds one; `null` when it holds neither — a reminder written before the
 * payload carried them — and the old sentence is still true of it.
 *
 * The instant is read in the **office's** zone, which the payload names (invariant §9): never the server's.
 */
function whenAndWhere(payload: Record<string, unknown>): string | null {
  const when = typeof payload.startsAt === 'string' && typeof payload.timezone === 'string'
    ? formatDateTime(payload.startsAt, payload.timezone)
    : '';
  const where = name(payload, 'location', '').trim();
  const parts = [when, where].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * The leader's request inbox: **`/new-hires`'s *Review requests***, opened by `?review=requests` (P18.96-T3 AC-5,
 * ADR-0170 §5). It was the *Pending Requests* tab of User management, which lists the same requests and stays.
 */
export const JOIN_REQUEST_INBOX = '/new-hires?review=requests';

/** An id as a notice carries one: a MongoDB ObjectId, 24 hex characters. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** An office date as a calendar notice carries one. Whether it is a real day the page decides, never failing. */
const OFFICE_DATE = /^\d{4}-\d{2}-\d{2}$/;

const wellFormed = (value: unknown, shape: RegExp): value is string => typeof value === 'string' && shape.test(value);

/**
 * **Where a notification opens**, composed on the server beside its words, for the same reason they are
 * (ADR-0010): what a row does is product behaviour, not something a client improvises.
 *
 * - `COACHING_SESSION_FINALIZED` opens the session it announces, at `/coaching/me?session={sessionId}` —
 *   the coachee's own read-only page (ADR-0078, P11-T10 AC-8). A payload without a well-formed id opens
 *   `/coaching/me` on its latest session rather than on an address that would fail.
 * - **The calendar's three** (ADR-0095; `functional/calendar.md`, *The address*) open the entry at its
 *   week, `/calendar?entry={entryId}&date={date}`; a cancellation opens the week it was in,
 *   `/calendar?date={date}`, since the entry no longer reads. A payload without a well-formed id or date
 *   opens `/calendar`.
 * - **A join request** (P18.96-T1 AC-3) opens the leader's request inbox, `/new-hires?review=requests` since P18.96-T3
 *   (*Review requests* on *New hires*; `/user-management/pending` until then), where it is
 *   approved or declined. It goes only to an AB or an AAB, who reach that route. The payload names nobody's row,
 *   so the address names none either.
 * - **A transfer request** (P18.96-T3, ADR-0170 §4) opens the office's *All Members* on its *Pending* tab,
 *   `/people/members?tab=pending`, where the Owner and the Admins decide it; **an accepted invite** opens `/new-hires`.
 * - **Every other item is `null`**.
 */
export function inboxAddress(templateId: string, payload: Record<string, unknown>): string | null {
  switch (templateId) {
    case NotificationTemplate.COACHING_SESSION_FINALIZED:
      return wellFormed(payload.sessionId, OBJECT_ID) ? `/coaching/me?session=${payload.sessionId}` : '/coaching/me';
    case NotificationTemplate.CALENDAR_ENTRY_CHANGED:
      if (payload.change === 'cancelled') {
        return wellFormed(payload.date, OFFICE_DATE) ? `/calendar?date=${payload.date}` : '/calendar';
      }
      return calendarEntryAddress(payload);
    case NotificationTemplate.CALENDAR_INVITATION:
    case NotificationTemplate.CALENDAR_BLOCK_PLACED:
      return calendarEntryAddress(payload);
    case NotificationTemplate.JOIN_REQUEST_RECEIVED:
      return JOIN_REQUEST_INBOX;
    // P18.96-T3: a transfer waits on the office's Pending tab; an accepted invite is in the leader's unit.
    case NotificationTemplate.TRANSFER_REQUEST_RECEIVED:
      return '/people/members?tab=pending';
    case NotificationTemplate.MEMBER_INVITE_ACCEPTED:
      return '/new-hires';
    default:
      return null;
  }
}

/** An entry at its week, its detail open — or the calendar, when the payload names neither well. */
function calendarEntryAddress(payload: Record<string, unknown>): string {
  return wellFormed(payload.entryId, OBJECT_ID) && wellFormed(payload.date, OFFICE_DATE)
    ? `/calendar?entry=${payload.entryId}&date=${payload.date}`
    : '/calendar';
}

export type { NotificationTemplateId };
