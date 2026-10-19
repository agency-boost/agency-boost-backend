import { busyView, comparedView, entryView, namedIn, standingOf, type Reader, type StoredEntry } from './calendar-view';

const J = 'Asia/Jakarta';
const entry = (over: Partial<StoredEntry> = {}): StoredEntry => ({
  _id: 'e1', organiserMembershipId: 'sari', type: 'client', title: 'Client visit — Kusuma', notes: 'Kusuma residence',
  startsAt: new Date('2026-09-16T03:00:00Z'), endsAt: new Date('2026-09-16T04:00:00Z'), startsOn: null, endsOn: null,
  attendees: [
    { membershipId: 'rina', placed: false, answer: 'accepted', answeredAt: null, addedAt: new Date() },
    { membershipId: 'indah', placed: true, answer: null, answeredAt: null, addedAt: new Date() },
  ],
  version: 3,
  ...over,
});
const reader = (membershipId: string, coaches: string[] = []): Reader => ({
  membershipId, coaches: new Set(coaches), names: new Map([['sari', 'Sari Puspita'], ['rina', 'Rina Wijaya']]), timezone: J,
});

/**
 * **What each reader is answered of an entry** (`functional/calendar.md`, *Who reads what*, *An entry*,
 * *A busy block*) — the pure rule the routes serve, so the shapes the HTTP specs read are this.
 */
describe('calendar-view', () => {
  it('P12-T1 AC-3 where the reader stands: organiser, invitee, placed, or not on it', () => {
    expect(['sari', 'rina', 'indah', 'agus'].map((id) => standingOf(entry(), id))).toEqual(['organiser', 'invitee', 'placed', null]);
  });

  it('P12-T4 AC-5 the answers are the organiser’s alone; an invitee reads their own as myAnswer', () => {
    const organiser = entryView(entry(), reader('sari'), 'organiser');
    expect(organiser.invitees).toEqual([
      { membershipId: 'rina', name: 'Rina Wijaya', placed: false, answer: 'accepted', readerCoaches: false },
      { membershipId: 'indah', name: '', placed: true, readerCoaches: false },
    ]);
    expect(organiser.myAnswer).toBeNull();
    const invitee = entryView(entry(), reader('rina'), 'invitee');
    expect(invitee.invitees.every((i) => !('answer' in i))).toBe(true);
    expect(invitee.myAnswer).toBe('accepted');
    // A reader answered as an invitee who is not on it has no answer of their own.
    expect(entryView(entry(), reader('agus'), 'invitee').myAnswer).toBeNull();
  });

  it('P12-T6 AC-1 readerCoaches only on a 1:1 coaching entry, for the invitees the reader coaches', () => {
    expect(entryView(entry({ type: 'coaching' }), reader('agus', ['rina']), 'ancestor').invitees.map((i) => i.readerCoaches)).toEqual([true, false]);
    expect(entryView(entry(), reader('agus', ['rina']), 'ancestor').invitees.map((i) => i.readerCoaches)).toEqual([false, false]);
  });

  it('P12-T5 AC-4 a compared member’s own entry is whole; one they only attend is whole only in the reader’s own right', () => {
    expect(comparedView(entry(), 'sari', reader('agus'))).toMatchObject({ readerIs: 'ancestor', notes: 'Kusuma residence' });
    const attended = entry({ organiserMembershipId: 'owner' });
    expect(comparedView(attended, 'rina', reader('agus'))).toEqual(busyView(attended, J));
    expect(comparedView(attended, 'rina', reader('agus', ['owner']))).toMatchObject({ readerIs: 'ancestor' });
    expect(comparedView(attended, 'rina', reader('indah'))).toMatchObject({ readerIs: 'placed' });
  });

  describe('P13.1-T8 Hide my personal activities (ADR-0110)', () => {
    const hiding = new Set(['sari']);

    it('P13.1-T8 AC-3 a member who hides is answered to an ancestor as busy blocks, their time and nothing else', () => {
      expect(comparedView(entry(), 'sari', reader('agus'), hiding)).toEqual(busyView(entry(), J));
      // A trip hidden is a busy trip: its two dates kept.
      const trip = entry({ type: 'travel', startsOn: '2026-09-16', endsOn: '2026-09-17' });
      expect(comparedView(trip, 'sari', reader('agus'), hiding)).toEqual(busyView(trip, J));
    });

    it('P13.1-T8 AC-3 a reader on the entry still reads it in full: an invitee, the placed member, its organiser', () => {
      expect(comparedView(entry(), 'sari', reader('rina'), hiding)).toMatchObject({ readerIs: 'invitee', title: 'Client visit — Kusuma' });
      expect(comparedView(entry(), 'sari', reader('indah'), hiding)).toMatchObject({ readerIs: 'placed', notes: 'Kusuma residence' });
      expect(comparedView(entry(), 'rina', reader('sari'), hiding)).toMatchObject({ readerIs: 'organiser' });
    });

    it('P13.1-T8 AC-3 what a hiding member organised is busy in another member’s pane too, though the reader coaches them', () => {
      // Rina is on Sari's entry; Agus, comparing Rina, coaches Sari — and Sari hides.
      expect(comparedView(entry(), 'rina', reader('agus', ['sari']), hiding)).toEqual(busyView(entry(), J));
      expect(comparedView(entry(), 'rina', reader('agus', ['sari']))).toMatchObject({ readerIs: 'ancestor' });
    });

    it('P13.1-T8 AC-3 a leader’s entry on the member’s calendar is not the member’s to hide: it is read as before', () => {
      const block = entry({ organiserMembershipId: 'agus', attendees: [{ membershipId: 'sari', placed: true, answer: null, answeredAt: null, addedAt: new Date() }] });
      expect(comparedView(block, 'sari', reader('agus'), hiding)).toMatchObject({ readerIs: 'organiser' });
      // The leader above who coaches the block's organiser reads it in full, as without the setting.
      expect(comparedView(block, 'sari', reader('owner', ['agus', 'sari']), hiding)).toMatchObject({ readerIs: 'ancestor' });
    });

    it('P13.1-T8 AC-3 off — nobody hiding — changes nothing', () => {
      expect(comparedView(entry(), 'sari', reader('agus'), new Set())).toEqual(comparedView(entry(), 'sari', reader('agus')));
    });
  });

  it('P12-T5 AC-4 a busy block is its time and nothing else', () => {
    expect(busyView(entry(), J)).toEqual({
      busy: true, allDay: false, date: '2026-09-16', start: '10:00', end: '11:00', startsOn: null, endsOn: null,
      startsAt: '2026-09-16T03:00:00.000Z', endsAt: '2026-09-16T04:00:00.000Z',
    });
  });

  it('names every membership an entry holds, for one read', () => {
    expect(namedIn([entry(), entry({ organiserMembershipId: 'owner', attendees: [] })])).toEqual(['sari', 'rina', 'indah', 'owner']);
  });
});
