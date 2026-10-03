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
