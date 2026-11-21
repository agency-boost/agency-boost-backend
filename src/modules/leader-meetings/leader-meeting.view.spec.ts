import { Types } from 'mongoose';
import { carriedCopy, carriedItems, firstAgenda, startingAgenda } from './leader-meeting-agenda';
import type { LeaderMeetingActionItem } from './leader-meeting.schema';
import {
  actionItemsInOrder, cardOf, firstNameOf, meetingState, newestFirst, nextForumOf, type MeetingCard,
} from './leader-meeting.view';
import { english, indonesian } from '../../../test/i18n';
import { readerIn } from '@/common/i18n/reader';
import { LEADER_MEETINGS_MESSAGES as SAY } from './leader-meetings.messages';

let n = 0;
const newId = () => `id-${(n += 1)}`;
const row = (over: Partial<LeaderMeetingActionItem>): LeaderMeetingActionItem => ({
  itemId: 'i', lineageId: 'l', text: 't', picMembershipId: null, dueOn: null, status: 'todo', fromNumber: null, order: 0, version: 3,
  ...over,
});

describe('the forum’s rules, pure (P19.22-T8; ADR-0276)', () => {
  it('P19.22-T8 AC-1 Akan datang through its date, Selesai the day after', () => {
    expect(meetingState('2026-09-14', '2026-09-14')).toBe('upcoming');
    expect(meetingState('2026-09-13', '2026-09-14')).toBe('completed');
  });

  it('P19.22-T8 AC-1 a card: days to go, the agenda count and Action items x/y selesai', () => {
    const card = cardOf({
      _id: new Types.ObjectId('66f0000000000000000000b1'), number: 14, date: '2026-09-22', time: '14:00',
      agendaItems: [{ itemId: 'a', text: 'x', picMembershipId: null, picAll: false, done: false, version: 1 }],
      actionItems: [row({ status: 'done' }), row({ status: 'doing' }), row({ status: 'todo' })],
    } as never, '2026-09-14');
    expect(card).toEqual({
      id: '66f0000000000000000000b1', number: 14, date: '2026-09-22', time: '14:00', state: 'upcoming', daysUntil: 8,
      agendaCount: 1, actionProgress: { done: 1, total: 3 },
    });
  });

  it('P19.22-T8 AC-1 newest first by date, time, number; the next forum is the nearest upcoming', () => {
    const c = (id: string, date: string, time: string | null, number: number, state: MeetingCard['state']): MeetingCard => ({
      id, number, date, time, state, daysUntil: 0, agendaCount: 0, actionProgress: { done: 0, total: 0 },
    });
    const cards = [c('a', '2026-09-01', '14:00', 1, 'completed'), c('b', '2026-09-22', '09:00', 3, 'upcoming'),
      c('d', '2026-09-22', '14:00', 2, 'upcoming'), c('e', '2026-10-06', null, 4, 'upcoming')];
    expect(newestFirst(cards).map((x) => x.id)).toEqual(['e', 'd', 'b', 'a']);
    expect(nextForumOf(cards)?.id).toBe('b');
    expect(nextForumOf([cards[0]])).toBeNull();
  });

  it('P19.22-T8 AC-4 the action items in their order, two at one place kept as stored', () => {
    expect(actionItemsInOrder([row({ itemId: 'b', order: 1 }), row({ itemId: 'a', order: 0 }), row({ itemId: 'c', order: 1 })])
      .map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('P19.22-T8 AC-2 a first name is the first word', () => {
    expect(firstNameOf('  Agus Salim ')).toBe('Agus');
  });

  it('P19.22-T8 AC-3 the first agenda: the mockup’s three lines in the maker’s language, Update action items for Semua', () => {
    const id = firstAgenda(newId, readerIn('id'));
    expect(id.map((i) => [i.text, i.picAll, i.done, i.version])).toEqual([
      [indonesian(SAY.reviewNumbers), false, false, 1], [indonesian(SAY.updateActionItems), true, false, 1], [indonesian(SAY.agreeNewItems), false, false, 1],
    ]);
    expect(firstAgenda(newId).map((i) => i.text)).toEqual([english(SAY.reviewNumbers), english(SAY.updateActionItems), english(SAY.agreeNewItems)]);
  });

  it('P19.22-T8 AC-3 a next agenda copies the previous lines and PICs, unticked, new ids; an empty previous agenda stays empty', () => {
    const next = startingAgenda([{ itemId: 'x', text: 'Review', picMembershipId: 'm-agus', picAll: false, done: true, version: 4 }], newId);
    expect(next).toEqual([{ itemId: expect.stringMatching(/^id-/), text: 'Review', picMembershipId: 'm-agus', picAll: false, done: false, version: 1 }]);
    expect(startingAgenda([], newId)).toEqual([]);
  });

  it('P19.22-T8 AC-4 OD-417 carried: the items not Selesai, in order, same lineage, dari forum #n of where the lineage began', () => {
    const items = carriedItems({
      number: 13,
      actionItems: [row({ itemId: 'b', lineageId: 'L2', order: 1, status: 'doing', fromNumber: 12 }), row({ itemId: 'a', lineageId: 'L1', order: 0 }),
        row({ itemId: 'c', lineageId: 'L3', order: 2, status: 'done' })],
    }, newId);
    expect(items.map((i) => [i.lineageId, i.status, i.fromNumber, i.order, i.version])).toEqual([
      ['L1', 'todo', 13, 0, 1], ['L2', 'doing', 12, 1, 1],
    ]);
    expect(items.every((i) => i.itemId.startsWith('id-'))).toBe(true);
    expect(carriedItems(null, newId)).toEqual([]);
    expect(carriedCopy(row({ fromNumber: null, picMembershipId: 'm', dueOn: '2026-10-01' }), 7, 'new', 5))
      .toMatchObject({ itemId: 'new', fromNumber: 7, picMembershipId: 'm', dueOn: '2026-10-01', order: 5, version: 1 });
  });
});
