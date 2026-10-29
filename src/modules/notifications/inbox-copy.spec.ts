import { readerIn } from '@/common/i18n/reader';
import { describeNotification, IN_APP_TEMPLATES, inboxAddress, JOIN_REQUEST_INBOX } from './inbox-copy';
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

  /*
   * **P18.96-T1 AC-3: the name the sender writes.** `requestLeader` stores `askerName`; the template read `fullName`
   * alone, so every request a real person sent read *"Somebody asked to join your unit"*. The seed and older rows
   * carry `fullName`, and still read.
   */
  it('P18.96-T1 AC-3 a join request names who asked, from askerName as the sender writes it, else fullName', () => {
    expect(describeNotification(NotificationTemplate.JOIN_REQUEST_RECEIVED, { askerName: 'Rina Wijaya', membershipId: 'm1' }))
      .toEqual({ title: 'Rina Wijaya asked to join your unit', detail: 'Approve or decline it under Review requests on New hires.' });
    expect(describeNotification(NotificationTemplate.JOIN_REQUEST_RECEIVED, { askerName: 'Rina Wijaya', fullName: 'Old' }).title)
      .toBe('Rina Wijaya asked to join your unit');
    expect(describeNotification(NotificationTemplate.JOIN_REQUEST_RECEIVED, { askerName: '  ', fullName: 'Putri' }).title)
      .toBe('Putri asked to join your unit');
    expect(describeNotification(NotificationTemplate.JOIN_REQUEST_RECEIVED, { askerName: 42 }).title)
      .toBe('Somebody asked to join your unit');
  });

  it('P18.96-T1 AC-3 a member tagged reads that a leader added them; a leader whose code was used reads who joined', () => {
    expect(describeNotification(NotificationTemplate.MEMBER_TAGGED_BY_LEADER, { leaderMembershipId: 'm1', via: 'tagged' }))
      .toEqual({
        title: 'A leader added you to their unit',
        detail: 'You did not have to ask — they picked you up from the unassigned list.',
      });
    // `LeaderCodeService.redeem` sends this template to the code's owner: never the member's sentence.
    const leader = describeNotification(NotificationTemplate.MEMBER_TAGGED_BY_LEADER, {
      joinerName: 'Dimas Saputra', via: 'leader-code', code: 'JOR417',
    });
    expect(leader).toEqual({
      title: 'Dimas Saputra joined your unit with your leader code',
      detail: 'A leader code needs no approval, so they are in your unit already.',
    });
    expect(leader.title).not.toMatch(/added you/);
    expect(describeNotification(NotificationTemplate.MEMBER_TAGGED_BY_LEADER, { via: 'leader-code' }).title)
      .toBe('Somebody joined your unit with your leader code');
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
   * **An event's reminder names its time and place** (P18.95-T7 AC-4; the client's UI review, UI-030). It read *"Check
   * the time and where it is."* — the two things the reader opened it for, left for them to find.
   */
  describe('P18.95-T7 AC-4 an event reminder names its time and place', () => {
    const kickoff = {
      eventId: '66f0000000000000000000e1', title: 'Kickoff 2026',
      startsAt: '2026-11-09T02:00:00.000Z', timezone: 'Asia/Jakarta', location: 'Kantor KPM',
    };

    it('P18.95-T7 AC-4 its start on the office’s clock and where it is, through the shared formatter', () => {
      expect(describeNotification(NotificationTemplate.EVENT_REMINDER, kickoff)).toEqual({
        title: 'Kickoff 2026 is coming up', detail: '9 Nov 2026, 09.00 · Kantor KPM',
      });
    });

    it('P18.95-T7 AC-4 the office’s zone decides the day: 18:30 UTC is the next morning in Jakarta', () => {
      expect(describeNotification(NotificationTemplate.EVENT_REMINDER, { ...kickoff, startsAt: '2026-11-08T18:30:00.000Z' }).detail)
        .toBe('9 Nov 2026, 01.30 · Kantor KPM');
    });

    it('P18.95-T7 AC-4 either half alone, when the payload holds only one', () => {
      const { location: _place, ...timed } = kickoff;
      expect(describeNotification(NotificationTemplate.EVENT_REMINDER, timed).detail).toBe('9 Nov 2026, 09.00');
      expect(describeNotification(NotificationTemplate.EVENT_REMINDER, { ...kickoff, location: '   ' }).detail).toBe('9 Nov 2026, 09.00');
      const { startsAt: _at, ...placed } = kickoff;
      expect(describeNotification(NotificationTemplate.EVENT_REMINDER, placed).detail).toBe('Kantor KPM');
    });

    it('P18.95-T7 AC-4 a time it cannot read is left out, never written in the server’s zone or as Invalid', () => {
      expect(describeNotification(NotificationTemplate.EVENT_REMINDER, { ...kickoff, timezone: 'Not/AZone' }).detail).toBe('Kantor KPM');
      expect(describeNotification(NotificationTemplate.EVENT_REMINDER, { ...kickoff, startsAt: 'soon' }).detail).toBe('Kantor KPM');
      expect(describeNotification(NotificationTemplate.EVENT_REMINDER, { ...kickoff, timezone: undefined }).detail).toBe('Kantor KPM');
    });

    it('P18.95-T7 AC-4 a reminder written with its title alone keeps the words it had', () => {
      expect(describeNotification(NotificationTemplate.EVENT_REMINDER, { title: 'Leader Forum' }).detail)
        .toBe('Check the time and where it is.');
    });
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

    it('P18.96-T1 AC-3 a join request opens the leader’s request inbox, whatever its payload holds', () => {
      // P18.96-T3 AC-5: the inbox moved to New hires' Review requests, as ADR-0170 §5 places it.
      expect(JOIN_REQUEST_INBOX).toBe('/new-hires?review=requests');
      for (const payload of [{}, { askerName: 'Rina Wijaya', membershipId: SESSION }, { fullName: 'Putri' }]) {
        expect(inboxAddress(NotificationTemplate.JOIN_REQUEST_RECEIVED, payload)).toBe('/new-hires?review=requests');
      }
    });

    it('P11-T10 AC-8 no other inbox item changes: every template but the session’s, the calendar’s and the join request’s opens nowhere', () => {
      const ADDRESSED: string[] = [
        NotificationTemplate.COACHING_SESSION_FINALIZED, NotificationTemplate.CALENDAR_INVITATION,
        NotificationTemplate.CALENDAR_BLOCK_PLACED, NotificationTemplate.CALENDAR_ENTRY_CHANGED,
        NotificationTemplate.JOIN_REQUEST_RECEIVED,
        // P18.96-T3: a transfer waits on All Members; an accepted invite is on New hires.
        NotificationTemplate.TRANSFER_REQUEST_RECEIVED, NotificationTemplate.MEMBER_INVITE_ACCEPTED,
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

describe('P18.96-T3 the notices of joining by invite and of a transfer (ADR-0170)', () => {
  it('P18.96-T3 AC-4 an accepted invite tells the leader who joined, and opens New hires', () => {
    expect(describeNotification(NotificationTemplate.MEMBER_INVITE_ACCEPTED, { joinerName: 'Hendra Wijaya' })).toEqual({
      title: 'Hendra Wijaya accepted your invite and joined your unit', detail: 'They are in your unit now, with the join date you gave.',
    });
    expect(describeNotification(NotificationTemplate.MEMBER_INVITE_ACCEPTED, {}).title).toBe('Somebody accepted your invite and joined your unit');
    expect(inboxAddress(NotificationTemplate.MEMBER_INVITE_ACCEPTED, {})).toBe('/new-hires');
  });

  it('P18.96-T3 AC-3 a transfer request names who asked and who would move, and opens All Members on Pending', () => {
    expect(describeNotification(NotificationTemplate.TRANSFER_REQUEST_RECEIVED, { requesterName: 'Agus Prasetyo', memberName: 'Lina Marlina' }))
      .toEqual({ title: 'Agus Prasetyo asked to move Lina Marlina into their unit', detail: 'Approve or decline it on All Members, under Pending.' });
    expect(describeNotification(NotificationTemplate.TRANSFER_REQUEST_RECEIVED, {}).title).toBe('A leader asked to move a member into their unit');
    expect(inboxAddress(NotificationTemplate.TRANSFER_REQUEST_RECEIVED, {})).toBe('/people/members?tab=pending');
  });

  it('P18.96-T3 AC-3 a decision reads by whom it is for: whoever asked, the member who moved, the leader they left', () => {
    const base = { memberName: 'Lina Marlina', toLeaderName: 'Agus Prasetyo' };
    expect(describeNotification(NotificationTemplate.TRANSFER_REQUEST_DECIDED, { ...base, decision: 'approved', audience: 'requester' }).title)
      .toBe('Your request to move Lina Marlina was approved');
    expect(describeNotification(NotificationTemplate.TRANSFER_REQUEST_DECIDED, { ...base, decision: 'declined', audience: 'requester', reason: 'Not now.' }))
      .toEqual({ title: 'Your request to move Lina Marlina was declined', detail: 'Not now.' });
    expect(describeNotification(NotificationTemplate.TRANSFER_REQUEST_DECIDED, { ...base, decision: 'declined', audience: 'requester' }).detail)
      .toBe('They stay where they are.');
    expect(describeNotification(NotificationTemplate.TRANSFER_REQUEST_DECIDED, { ...base, decision: 'approved', audience: 'member' }).title)
      .toBe('You now report to Agus Prasetyo');
    expect(describeNotification(NotificationTemplate.TRANSFER_REQUEST_DECIDED, { ...base, decision: 'approved', audience: 'from_leader' }).title)
      .toBe('Lina Marlina moved to Agus Prasetyo’s unit');
    expect(describeNotification(NotificationTemplate.TRANSFER_REQUEST_DECIDED, { audience: 'member' }).title).toBe('You now report to another leader');
    expect(inboxAddress(NotificationTemplate.TRANSFER_REQUEST_DECIDED, base)).toBeNull();
    for (const id of [NotificationTemplate.MEMBER_INVITE_ACCEPTED, NotificationTemplate.TRANSFER_REQUEST_RECEIVED, NotificationTemplate.TRANSFER_REQUEST_DECIDED]) {
      expect([id, TEMPLATE_CHANNELS[id]]).toEqual([id, ['in_app', 'email']]);
    }
  });
});

/**
 * **P18.98-T5 AC-4 — the inbox in the reader's language** (ADR-0179 §7): every row composed when it is read, in the
 * reader's language, so a notice stored before the phase reads in it too. A name and a reason in the payload are shown
 * as typed; the words around them, and the fallbacks for a payload that holds none, are ours.
 */
describe('P18.98-T5 AC-4 the inbox in the reader’s language', () => {
  const ID = readerIn('id');
  const say = (templateId: string, payload: Record<string, unknown> = {}) => describeNotification(templateId, payload, ID);

  it('AC-4 writes every in-app template in Indonesian, with the payload’s names as typed', () => {
    expect(say(NotificationTemplate.JOIN_REQUEST_RECEIVED, { askerName: 'Rina' })).toEqual({
      title: 'Rina meminta bergabung ke unit Anda',
      detail: 'Setujui atau tolak lewat Tinjau permintaan di New hires.',
    });
    expect(say(NotificationTemplate.JOIN_REQUEST_APPROVED)).toEqual({
      title: 'Anda sudah bergabung', detail: 'Permintaan Anda disetujui. Sekarang Anda memiliki leader.',
    });
    expect(say(NotificationTemplate.MEMBER_TAGGED_BY_LEADER, { via: 'leader-code', joinerName: 'Budi' })).toEqual({
      title: 'Budi bergabung ke unit Anda dengan kode leader Anda',
      detail: 'Kode leader tidak memerlukan persetujuan, jadi dia sudah ada di unit Anda.',
    });
    expect(say(NotificationTemplate.MEMBER_TAGGED_BY_LEADER)).toEqual({
      title: 'Seorang leader menambahkan Anda ke unitnya',
      detail: 'Anda tidak perlu meminta — dia memilih Anda dari daftar anggota tanpa tim.',
    });
    expect(say(NotificationTemplate.MEMBER_INVITE_ACCEPTED, { joinerName: 'Dewi' })).toEqual({
      title: 'Dewi menerima undangan Anda dan bergabung ke unit Anda',
      detail: 'Dia sudah ada di unit Anda, dengan tanggal bergabung yang Anda berikan.',
    });
    expect(say(NotificationTemplate.TRANSFER_REQUEST_RECEIVED, { requesterName: 'Agus', memberName: 'Sari' })).toEqual({
      title: 'Agus meminta Sari dipindahkan ke unitnya',
      detail: 'Setujui atau tolak di All Members, pada tab Pending.',
    });
    expect(say(NotificationTemplate.MEMBER_REMOVED).title).toBe('Anda dikeluarkan dari unit Anda');
    expect(say(NotificationTemplate.ROLE_CHANGED)).toEqual({
      title: 'Peran Anda berubah', detail: 'Leader Anda mengubah peran Anda. Anda tetap melapor kepadanya.',
    });
    expect(say(NotificationTemplate.ADMIN_ACCESS_CHANGED, { granted: true })).toEqual({
      title: 'Sekarang Anda dapat mengelola KPM ini', detail: 'Owner memberi Anda akses KPM Admin.',
    });
    expect(say(NotificationTemplate.ADMIN_ACCESS_CHANGED, { granted: false }).title).toBe('Akses admin Anda dicabut');
    expect(say(NotificationTemplate.LEADER_LIMIT_REQUEST_APPROVED, { subjectName: 'Sari' }).title)
      .toBe('AgencyBoost menyetujui permintaan Anda untuk Sari');
    expect(say(NotificationTemplate.LEADER_LIMIT_REQUEST_DECLINED).detail).toBe('Tidak ada yang berubah pada dirinya.');
    expect(say(NotificationTemplate.GOAL_SET_BY_LEADER, { byName: 'Agus' })).toEqual({
      title: 'Agus mengatur goal Anda',
      detail: 'Buka Goal settings untuk melihatnya — Anda dapat mengubahnya, ini rencana Anda.',
    });
    expect(say(NotificationTemplate.COACHING_SESSION_FINALIZED).title).toBe('Sesi coaching telah difinalkan');
    expect(say(NotificationTemplate.CALENDAR_INVITATION).title).toBe('Anda mendapat undangan baru');
    expect(say(NotificationTemplate.CALENDAR_BLOCK_PLACED).title).toBe('Ada waktu yang diblok di kalender Anda');
    expect(say(NotificationTemplate.CALENDAR_ENTRY_CHANGED, { change: 'cancelled' }).title).toBe('Entri di kalender Anda dibatalkan');
    expect(say(NotificationTemplate.CALENDAR_ENTRY_CHANGED, { change: 'moved' }).title).toBe('Entri di kalender Anda dipindahkan');
    expect(say(NotificationTemplate.IMPERSONATION_ELEVATED).title).toBe('Sesi dukungan itu kini dapat mengubah data');
    expect(say('something.new')).toEqual({ title: 'Ada sesuatu yang terjadi', detail: null });
  });

  it('AC-4 shows a typed reason as typed, in either language, and translates only the sentence for none', () => {
    expect(say(NotificationTemplate.JOIN_REQUEST_DECLINED, { reason: 'Tim sudah penuh' })).toEqual({
      title: 'Permintaan Anda ditolak', detail: 'Tim sudah penuh',
    });
    expect(describeNotification(NotificationTemplate.JOIN_REQUEST_DECLINED, { reason: 'Team is full' }, ID).detail)
      .toBe('Team is full');
    expect(say(NotificationTemplate.JOIN_REQUEST_DECLINED).detail)
      .toBe('Anda dapat mencari leader lain dan mengajukan permintaan lagi.');
  });

  it('AC-4 translates the names it falls back on, and nothing it was given', () => {
    expect(say(NotificationTemplate.JOIN_REQUEST_RECEIVED).title).toBe('Seseorang meminta bergabung ke unit Anda');
    expect(say(NotificationTemplate.TRANSFER_REQUEST_RECEIVED).title).toBe('Seorang leader meminta seorang anggota dipindahkan ke unitnya');
    expect(say(NotificationTemplate.GOAL_SET_BY_LEADER).title).toBe('Leader Anda mengatur goal Anda');
    expect(say(NotificationTemplate.EVENT_REMINDER).title).toBe('Sebuah event akan segera berlangsung');
    expect(say(NotificationTemplate.LEADER_LIMIT_REQUEST_APPROVED).title).toBe('AgencyBoost menyetujui permintaan Anda untuk leader baru');
  });

  it('AC-4 a transfer’s decision reads by whom it is for, in Indonesian', () => {
    const decided = { memberName: 'Sari', toLeaderName: 'Agus' };
    expect(say(NotificationTemplate.TRANSFER_REQUEST_DECIDED, { ...decided, audience: 'member' })).toEqual({
      title: 'Sekarang Anda melapor ke Agus',
      detail: 'KPM Anda memindahkan Anda ke unitnya. Riwayat Anda tetap bersama Anda.',
    });
    expect(say(NotificationTemplate.TRANSFER_REQUEST_DECIDED, { ...decided, audience: 'from_leader' }).title)
      .toBe('Sari pindah ke unit Agus');
    expect(say(NotificationTemplate.TRANSFER_REQUEST_DECIDED, { ...decided, decision: 'approved' }).title)
      .toBe('Permintaan Anda untuk memindahkan Sari disetujui');
    expect(say(NotificationTemplate.TRANSFER_REQUEST_DECIDED, { ...decided, decision: 'declined' })).toEqual({
      title: 'Permintaan Anda untuk memindahkan Sari ditolak', detail: 'Dia tetap di unitnya sekarang.',
    });
  });

  it('AC-4 a support or setup session says so in Indonesian, the reason as typed', () => {
    expect(say(NotificationTemplate.IMPERSONATION_STARTED, { purpose: 'setup', isSubject: true })).toEqual({
      title: 'Seseorang dari AgencyBoost sedang menyiapkan KPM Anda sebagai Anda',
      detail: 'Sesi penyiapan telah dimulai. Dia hanya dapat mengubah pengaturan KPM, mengimpor anggota, dan mengunggah file produksi.',
    });
    expect(say(NotificationTemplate.IMPERSONATION_STARTED, { purpose: 'setup', reason: 'Impor roster' }).detail)
      .toBe('Impor roster Dia hanya dapat mengubah pengaturan KPM, mengimpor anggota, dan mengunggah file produksi.');
    expect(say(NotificationTemplate.IMPERSONATION_STARTED, { isSubject: true })).toEqual({
      title: 'Seseorang dari AgencyBoost sedang melihat layar Anda',
      detail: 'Sesi dukungan telah dimulai. Dia hanya dapat melihat, kecuali orang kedua menyetujui sebaliknya.',
    });
    expect(say(NotificationTemplate.IMPERSONATION_STARTED)).toEqual({
      title: 'Sesi dukungan dimulai di KPM Anda', detail: 'Seseorang dari AgencyBoost sedang membantu seorang anggota.',
    });
  });

  it('AC-4 writes an event’s time in the reader’s figures: Indonesian, English for an English reader, as the product wrote it for nobody’s choice', () => {
    const kickoff = { title: 'Kickoff 2026', startsAt: '2026-11-09T02:00:00.000Z', timezone: 'Asia/Jakarta', location: 'Kantor KPM' };
    expect(say(NotificationTemplate.EVENT_REMINDER, kickoff)).toEqual({
      title: 'Kickoff 2026 akan segera berlangsung', detail: '9 Nov 2026, 09.00 · Kantor KPM',
    });
    expect(describeNotification(NotificationTemplate.EVENT_REMINDER, kickoff, readerIn('en')).detail)
      .toBe('9 Nov 2026, 09:00 · Kantor KPM');
    // A reader who has chosen nothing, until the default is live: English words, the figures as before.
    expect(describeNotification(NotificationTemplate.EVENT_REMINDER, kickoff)).toEqual({
      title: 'Kickoff 2026 is coming up', detail: '9 Nov 2026, 09.00 · Kantor KPM',
    });
    expect(say(NotificationTemplate.EVENT_REMINDER, { title: 'Leader Forum' }).detail).toBe('Periksa waktu dan tempatnya.');
  });

  it('AC-4 every in-app template reads differently in the two languages', () => {
    for (const templateId of IN_APP_TEMPLATES) {
      const en = describeNotification(templateId, {}, readerIn('en'));
      const id = describeNotification(templateId, {}, ID);
      expect({ templateId, same: en.title === id.title }).toEqual({ templateId, same: false });
    }
  });
});
