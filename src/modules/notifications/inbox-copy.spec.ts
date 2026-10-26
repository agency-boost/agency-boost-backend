import { describeNotification, IN_APP_TEMPLATES, inboxAddress } from './inbox-copy';
import { NotificationTemplate, TEMPLATE_CHANNELS } from './notification.types';

/**
 * What a notification says.
 *
 * ADR-0010 makes the in-app inbox the authoritative channel, so this is **product copy**,
 * not a rendering detail — the manual books quote it, and a change here changes what six
 * books say. Pinned per template for that reason.
 */
describe('inbox copy', () => {
  it('carries an entry for every template that reaches an inbox', () => {
    // A template with in_app delivery and no copy would render "Something happened",
    // which is true and useless. This fails when somebody adds the eleventh.
    for (const id of IN_APP_TEMPLATES) {
      expect(describeNotification(id, {}).title).not.toBe('Something happened');
    }
  });

  it('excludes the email-only templates from the inbox set', () => {
    expect(IN_APP_TEMPLATES).not.toContain(NotificationTemplate.EMAIL_VERIFICATION);
    expect(IN_APP_TEMPLATES).not.toContain(NotificationTemplate.PASSWORD_RESET);
    // Derived, not listed twice: the channel table is the source.
    expect(IN_APP_TEMPLATES.length).toBe(
      Object.values(TEMPLATE_CHANNELS).filter((c) => c.includes('in_app')).length,
    );
  });

  it('uses the name it was given, and a person when it was not', () => {
    expect(describeNotification(NotificationTemplate.JOIN_REQUEST_RECEIVED, { fullName: 'Putri' }).title)
      .toBe('Putri asked to join your unit');
    // A blank is not a name. Rendering "  asked to join your unit" would look broken.
    expect(describeNotification(NotificationTemplate.JOIN_REQUEST_RECEIVED, { fullName: '  ' }).title)
      .toBe('Somebody asked to join your unit');
    expect(describeNotification(NotificationTemplate.JOIN_REQUEST_RECEIVED, {}).title)
      .toBe('Somebody asked to join your unit');
  });

  it('prefers the reason somebody wrote over the general sentence', () => {
    // The reason is the only thing a refusal gives somebody to act on.
    expect(describeNotification(NotificationTemplate.JOIN_REQUEST_DECLINED, { reason: 'Wrong branch.' }).detail)
      .toBe('Wrong branch.');
    expect(describeNotification(NotificationTemplate.JOIN_REQUEST_DECLINED, {}).detail)
      .toBe('You can search for another leader and ask again.');
  });

  it('ADR-0162 §3: a setup session says so, and what it may change, to the person and to the Owner', () => {
    const subject = describeNotification(NotificationTemplate.IMPERSONATION_STARTED, {
      reason: 'Setting up the activity types.', isSubject: true, purpose: 'setup',
    });
    expect(subject).toEqual({
      title: 'Somebody from AgencyBoost is setting up your office as you',
      detail: 'Setting up the activity types. They can change the office\'s settings, import people and upload '
        + 'production files, and nothing else.',
    });
    const owner = describeNotification(NotificationTemplate.IMPERSONATION_STARTED, {
      reason: 'Setting up the activity types.', isSubject: false, purpose: 'setup',
    });
    expect(owner.title).toBe('A setup session started in your office');
    expect(owner.detail).toContain('import people and upload production files, and nothing else.');
    // Without a reason, the general sentence — never an empty one.
    expect(describeNotification(NotificationTemplate.IMPERSONATION_STARTED, { isSubject: true, purpose: 'setup' }).detail)
      .toMatch(/^A setup session has started\. They can change/);
    // A support session is unchanged: it only looks.
    expect(describeNotification(NotificationTemplate.IMPERSONATION_STARTED, {
      reason: 'Ticket 42.', isSubject: true, purpose: 'support',
    })).toEqual({
      title: 'Somebody from AgencyBoost is looking at your screens',
      detail: 'Ticket 42. They can only look, unless a second person approves otherwise.',
    });
  });

  it('reads admin access both ways round', () => {
    expect(describeNotification(NotificationTemplate.ADMIN_ACCESS_CHANGED, { granted: true }).title)
      .toBe('You can now administer this office');
    expect(describeNotification(NotificationTemplate.ADMIN_ACCESS_CHANGED, { granted: false }).title)
      .toBe('Your admin access was removed');
  });

  it('says something true rather than throwing on a template it does not know', () => {
    // An inbox that breaks on an unrecognised row is worse than one that is vague.
    expect(describeNotification('something.new', {})).toEqual({
      title: 'Something happened',
      detail: null,
    });
  });

  it('P18.8-T2 AC-5 tells whoever asked how AgencyBoost decided a leader past the limit (ADR-0157 §3)', () => {
    expect(describeNotification(NotificationTemplate.LEADER_LIMIT_REQUEST_APPROVED, { subjectName: 'Budi' })).toEqual({
      title: 'AgencyBoost approved your request for Budi',
      detail: 'The change is made: they are a leader now, past your office’s limit.',
    });
    expect(describeNotification(NotificationTemplate.LEADER_LIMIT_REQUEST_DECLINED, { subjectName: 'Budi', reason: 'Not now.' }))
      .toEqual({ title: 'AgencyBoost declined your request for Budi', detail: 'Not now.' });
    expect(describeNotification(NotificationTemplate.LEADER_LIMIT_REQUEST_DECLINED, {})).toEqual({
      title: 'AgencyBoost declined your request for a new leader', detail: 'Nothing about them changed.',
    });
  });

  it('covers the remaining in-app templates', () => {
    const cases: [string, string][] = [
      [NotificationTemplate.MEMBER_TAGGED_BY_LEADER, 'A leader added you to their unit'],
      [NotificationTemplate.MEMBER_REMOVED, 'You were removed from your unit'],
      [NotificationTemplate.ROLE_CHANGED, 'Your role changed'],
      [NotificationTemplate.COACHING_SESSION_FINALIZED, 'A coaching session was finalized'],
    ];
    for (const [id, title] of cases) expect(describeNotification(id, {}).title).toBe(title);

    /*
     * **A leader setting a goal, not proposing one.** This read *"Your leader proposed a goal"* and
     * told the reader to *accept it* — a button no screen has, written from a recommendation
     * nothing had ratified. ADR-0046 settled OD-09's goals half the other way.
     */
    expect(describeNotification(NotificationTemplate.GOAL_SET_BY_LEADER, {}).title)
      .toBe('Your leader set your goal');
    expect(describeNotification(NotificationTemplate.GOAL_SET_BY_LEADER, { byName: 'Ibu Sari' }).title)
      .toBe('Ibu Sari set your goal');
    expect(describeNotification(NotificationTemplate.GOAL_SET_BY_LEADER, {}).detail)
      .not.toMatch(/accept/i);

    expect(describeNotification(NotificationTemplate.EVENT_REMINDER, { title: 'Leader Forum' }).title)
      .toBe('Leader Forum is coming up');
    expect(describeNotification(NotificationTemplate.EVENT_REMINDER, {}).title)
      .toBe('An event is coming up');
    expect(describeNotification(NotificationTemplate.MEMBER_REMOVED, { reason: 'Left the company.' }).detail)
      .toBe('Left the company.');
    expect(describeNotification(NotificationTemplate.ROLE_CHANGED, { reason: 'Ready to lead.' }).detail)
      .toBe('Ready to lead.');
  });

  /*
   * **ADR-0078, P11-T10 AC-8: the finalize notice opens the session.** Composed here, beside the words,
   * so the inbox and the manual books read one address. No other item has one.
   */
  describe('where an item opens', () => {
    const SESSION = '66f0000000000000000000d1';

    it('P11-T10 AC-8 a finalized coaching session opens /coaching/me on the session it names', () => {
      expect(inboxAddress(NotificationTemplate.COACHING_SESSION_FINALIZED, { sessionId: SESSION }))
        .toBe(`/coaching/me?session=${SESSION}`);
    });

    it('P11-T10 AC-8 a payload with no well-formed session id opens /coaching/me, never a broken address', () => {
      for (const payload of [{}, { sessionId: 42 }, { sessionId: '' }, { sessionId: '../admin' }, { sessionId: `${SESSION}&x=1` }]) {
        expect(inboxAddress(NotificationTemplate.COACHING_SESSION_FINALIZED, payload)).toBe('/coaching/me');
      }
    });

    it('P11-T10 AC-8 no other inbox item changes: every template but the session’s and the calendar’s opens nowhere', () => {
      const ADDRESSED: string[] = [
        NotificationTemplate.COACHING_SESSION_FINALIZED, NotificationTemplate.CALENDAR_INVITATION,
        NotificationTemplate.CALENDAR_BLOCK_PLACED, NotificationTemplate.CALENDAR_ENTRY_CHANGED,
      ];
      for (const id of IN_APP_TEMPLATES.filter((t) => !ADDRESSED.includes(t))) {
        expect([id, inboxAddress(id, { sessionId: SESSION, entryId: SESSION, date: '2026-10-05' })]).toEqual([id, null]);
      }
      expect(inboxAddress('something.new', { sessionId: SESSION })).toBeNull();
    });
  });

  /*
   * **ADR-0095: the calendar's three notices** (P12-T4 AC-7; `functional/calendar.md`, *Notifications*).
   * General words in ADR-0096's terms — the payload carries ids and a date and nothing anybody typed —
   * and an address that opens the entry at its week, or the week a cancelled entry was in.
   */
  describe('the calendar’s notices', () => {
    const ENTRY = '66f0000000000000000000e1';
    const DATE = '2026-10-05';

    it('P12-T4 AC-7 an invitation, a block and a change each say their own words, a cancellation its second wording', () => {
      expect(describeNotification(NotificationTemplate.CALENDAR_INVITATION, { entryId: ENTRY, date: DATE })).toEqual({
        title: 'You have a new invitation', detail: 'Open it on your calendar to accept or decline.',
      });
      expect(describeNotification(NotificationTemplate.CALENDAR_BLOCK_PLACED, { entryId: ENTRY, date: DATE })).toEqual({
        title: 'Time was blocked on your calendar', detail: 'A leader above you placed it. Open it to see when.',
      });
      expect(describeNotification(NotificationTemplate.CALENDAR_ENTRY_CHANGED, { entryId: ENTRY, date: DATE, change: 'moved' }))
        .toEqual({ title: 'An entry on your calendar has moved', detail: 'Open it to see the new time.' });
      expect(describeNotification(NotificationTemplate.CALENDAR_ENTRY_CHANGED, { entryId: ENTRY, date: DATE, change: 'cancelled' }))
        .toEqual({ title: 'An entry on your calendar was cancelled', detail: 'It is no longer on your calendar.' });
    });

    it('P12-T4 AC-7 the words use none of the six words, and name nothing anybody typed (ADR-0096)', () => {
      const SIX = /\b(office|KPM|reports to|tagged to|untagged|unassigned)\b/i;
      const payloads = [{}, { change: 'moved' }, { change: 'cancelled' }];
      for (const id of [
        NotificationTemplate.CALENDAR_INVITATION, NotificationTemplate.CALENDAR_BLOCK_PLACED, NotificationTemplate.CALENDAR_ENTRY_CHANGED,
      ]) {
        for (const payload of payloads) {
          const { title, detail } = describeNotification(id, { ...payload, title: 'Client visit — Kusuma' });
          expect([id, SIX.test(`${title} ${detail}`), `${title} ${detail}`.includes('Kusuma')]).toEqual([id, false, false]);
        }
      }
    });

    it('P12-T4 AC-7 each row opens its entry at its week; a cancellation opens the week it was in', () => {
      for (const id of [NotificationTemplate.CALENDAR_INVITATION, NotificationTemplate.CALENDAR_BLOCK_PLACED]) {
        expect(inboxAddress(id, { entryId: ENTRY, date: DATE })).toBe(`/calendar?entry=${ENTRY}&date=${DATE}`);
      }
      expect(inboxAddress(NotificationTemplate.CALENDAR_ENTRY_CHANGED, { entryId: ENTRY, date: DATE, change: 'moved' }))
        .toBe(`/calendar?entry=${ENTRY}&date=${DATE}`);
      expect(inboxAddress(NotificationTemplate.CALENDAR_ENTRY_CHANGED, { entryId: ENTRY, date: DATE, change: 'cancelled' }))
        .toBe(`/calendar?date=${DATE}`);
    });

    it('P12-T4 AC-7 a payload without a well-formed id or date opens /calendar, never a broken address', () => {
      const broken = [{}, { entryId: ENTRY }, { date: DATE }, { entryId: '../admin', date: DATE }, { entryId: ENTRY, date: '5 Oct' },
        { entryId: 42, date: DATE }, { entryId: `${ENTRY}&x=1`, date: DATE }];
      for (const payload of broken) {
        for (const id of [NotificationTemplate.CALENDAR_INVITATION, NotificationTemplate.CALENDAR_BLOCK_PLACED]) {
          expect(inboxAddress(id, payload)).toBe('/calendar');
        }
        expect(inboxAddress(NotificationTemplate.CALENDAR_ENTRY_CHANGED, { ...payload, change: 'moved' })).toBe('/calendar');
      }
      expect(inboxAddress(NotificationTemplate.CALENDAR_ENTRY_CHANGED, { change: 'cancelled' })).toBe('/calendar');
      expect(inboxAddress(NotificationTemplate.CALENDAR_ENTRY_CHANGED, { change: 'cancelled', date: '2026/10/05' })).toBe('/calendar');
    });

    it('P12-T4 AC-7 all three reach the inbox and the email (ADR-0010)', () => {
      for (const id of [
        NotificationTemplate.CALENDAR_INVITATION, NotificationTemplate.CALENDAR_BLOCK_PLACED, NotificationTemplate.CALENDAR_ENTRY_CHANGED,
      ]) {
        expect([id, TEMPLATE_CHANNELS[id]]).toEqual([id, ['in_app', 'email']]);
        expect(IN_APP_TEMPLATES).toContain(id);
      }
    });
  });
});
