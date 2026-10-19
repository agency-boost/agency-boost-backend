import { COACHING } from '@/domain/constants';
import {
  carryForward, coalesceKeyOf, FINALIZE_RULES, finalizeRefusal, finalizeSentence, latestFinalized, leadActionsOf,
  leadActionText, reopenableUntil, reopenWindowOpen, reviewedItems, type SessionLead,
} from './coaching-session.rules';

const lead = (over: Partial<SessionLead> & { id: string }): SessionLead => ({
  name: `Lead ${over.id}`, nextActionDate: null, nextActionNote: null, thisMonth: false, registeredAt: 0, ...over,
});

const FINALIZED_AT = new Date('2026-09-10T04:00:00Z');

/**
 * **The session's rules** (P11-T5; `functional/coaching.md`, *The session*), pure: what *Start* copies and
 * carries, *From leads (automatic)*, the five finalize checks in the prototype's order, the reopen window,
 * the finalized version that counts, and the key a session's goal notice coalesces under.
 */
describe('the coaching session’s rules (P11-T5)', () => {
  describe('the finalized version that counts (ADR-0079)', () => {
    const base = {
      version: 3, lastWeekItems: [], actionItems: [{ itemId: 'a', text: 'Now', dueDate: '2026-09-12', carriedFromItemId: null }],
      tips: [], leadActions: [], finalizedAt: FINALIZED_AT, finalizedByMembershipId: 'coach', corrections: [],
    };

    it('P11-T5 AC-6 a finalized session counts as it stands', () => {
      expect(latestFinalized({ ...base, status: 'finalized' })).toMatchObject({
        version: 3, actionItems: [{ text: 'Now' }], finalizedByMembershipId: 'coach',
      });
    });

    it('P11-T5 AC-6 one under correction counts as the newest state its reopens kept whole', () => {
      const kept = (version: number) => ({
        version, lastWeekItems: [], actionItems: [{ itemId: 'k', text: `v${version}`, dueDate: null, carriedFromItemId: null }],
        tips: [], leadActions: [], finalizedAt: FINALIZED_AT, finalizedByMembershipId: 'coach',
        at: FINALIZED_AT, byMembershipId: 'coach', reason: 'why',
      });
      const shown = latestFinalized({ ...base, status: 'reopened', corrections: [kept(3), kept(5)] });
      expect(shown?.version).toBe(5);
      expect(shown?.actionItems[0].text).toBe('v5');
    });

    it('P11-T5 AC-1 a draft never finalized has none: it is no coachee’s last week', () => {
      expect(latestFinalized({ ...base, status: 'draft', finalizedAt: null, finalizedByMembershipId: null })).toBeNull();
    });
  });

  describe('From leads (automatic) (Overall.html:11041-11059)', () => {
    it('P11-T8 AC-9 lists every dated lead, closed ones included, nearest first, then by registration and id', () => {
      const actions = leadActionsOf([
        lead({ id: 'b', nextActionDate: '2026-09-20', registeredAt: 2 }),
        lead({ id: 'undated' }),
        lead({ id: 'a', nextActionDate: '2026-09-20', registeredAt: 1, nextActionNote: '  Bring the SPAJ.  ' }),
        lead({ id: 'c', nextActionDate: '2026-09-15', registeredAt: 9 }),
      ]);
      expect(actions).toEqual([
        { leadId: 'c', leadName: 'Lead c', dueDate: '2026-09-15', text: 'Follow up with Lead c' },
        { leadId: 'a', leadName: 'Lead a', dueDate: '2026-09-20', text: 'Bring the SPAJ.' },
        { leadId: 'b', leadName: 'Lead b', dueDate: '2026-09-20', text: 'Follow up with Lead b' },
      ]);
    });

    it('P11-T8 AC-9 a blank note reads the prototype’s *Follow up with {name}*', () => {
      expect(leadActionText({ name: 'Pak Hendro', nextActionNote: '   ' })).toBe('Follow up with Pak Hendro');
      expect(leadActionText({ name: 'Pak Hendro', nextActionNote: null })).toBe('Follow up with Pak Hendro');
    });
  });

  describe('Start: last week, and what carries forward (AC-1, ADR-0081)', () => {
    const version = {
      actionItems: [
        { itemId: 'typed-1', text: 'Book two presentations', dueDate: '2026-09-12', carriedFromItemId: null },
      ],
      leadActions: [
        { leadId: 'L-dated', leadName: 'Pak Dated', dueDate: '2026-09-11', text: 'Call him' },
        { leadId: 'L-undated', leadName: 'Ibu Undated', dueDate: '2026-09-13', text: 'Send the brochure' },
      ],
    };

    it('P11-T5 AC-2 copies every action item of last week — typed, then from leads — each with its date and tag, none ticked', () => {
      expect(reviewedItems(version)).toEqual([
        { itemId: 'typed-1', text: 'Book two presentations', dueDate: '2026-09-12', leadId: null, leadName: null, done: false },
        { itemId: 'lead-L-dated', text: 'Call him', dueDate: '2026-09-11', leadId: 'L-dated', leadName: 'Pak Dated', done: false },
        { itemId: 'lead-L-undated', text: 'Send the brochure', dueDate: '2026-09-13', leadId: 'L-undated', leadName: 'Ibu Undated', done: false },
      ]);
    });

    it('P11-T5 AC-1 carries every item not done with its date cleared, except one whose lead has a date now; and every tip', () => {
      let n = 0;
      const items = reviewedItems(version);
      items.push({ itemId: 'done-1', text: 'Already done', dueDate: null, leadId: null, leadName: null, done: true });
      const carried = carryForward(
        items,
        [{ tipId: 't1', text: 'Slow down on the opening line.', carriedFromTipId: null }],
        [lead({ id: 'L-dated', nextActionDate: '2026-09-18' }), lead({ id: 'L-undated' })],
        () => `new-${(n += 1)}`,
      );

      expect(carried.actionItems).toEqual([
        { itemId: 'new-1', text: 'Book two presentations', dueDate: null, carriedFromItemId: 'typed-1' },
        // Its lead lost its date, so *From leads* no longer lists it: it carries like a typed one.
        { itemId: 'new-2', text: 'Send the brochure', dueDate: null, carriedFromItemId: 'lead-L-undated' },
      ]);
      expect(carried.tips).toEqual([{ tipId: 'new-3', text: 'Slow down on the opening line.', carriedFromTipId: 't1' }]);
    });

    it('P11-T5 AC-1 a lead item whose lead is gone carries forward too', () => {
      const carried = carryForward(reviewedItems(version), [], [], () => 'x');
      expect(carried.actionItems.map((i) => i.carriedFromItemId)).toEqual(['typed-1', 'lead-L-dated', 'lead-L-undated']);
    });
  });

  describe('finalize: the prototype’s five checks, in its order (AC-4, Overall.html:11110-11117)', () => {
    const ok = {
      leadActions: [],
      actionItems: [{ text: 'Book two presentations', dueDate: '2026-09-20' }],
      tips: [{ text: 'Slow down.' }],
      leads: [] as SessionLead[],
    };

    it('P11-T5 AC-4 names its five rules', () => {
      expect(FINALIZE_RULES).toEqual([
        'NO_ACTION_ITEM', 'EMPTY_TIP', 'EMPTY_ACTION_ITEM', 'UNDATED_ACTION_ITEM', 'LEAD_THIS_MONTH_UNDATED',
      ]);
    });

    it('P11-T5 AC-4 passes a session that meets all five', () => {
      expect(finalizeRefusal(ok)).toBeNull();
    });

    it('P11-T5 AC-4 NO_ACTION_ITEM: neither a lead-derived item nor a typed one', () => {
      expect(finalizeRefusal({ ...ok, actionItems: [], tips: [{ text: '' }] })).toEqual({ rule: 'NO_ACTION_ITEM' });
      // A lead-derived item alone is enough.
      expect(finalizeRefusal({ ...ok, actionItems: [], leadActions: [{}] })).toBeNull();
    });

    it('P11-T5 AC-4 EMPTY_TIP before the items, a blank of spaces included', () => {
      expect(finalizeRefusal({ ...ok, tips: [{ text: '   ' }], actionItems: [{ text: '', dueDate: null }] }))
        .toEqual({ rule: 'EMPTY_TIP' });
    });

    it('P11-T5 AC-4 EMPTY_ACTION_ITEM before an undated one', () => {
      expect(finalizeRefusal({ ...ok, actionItems: [{ text: 'x', dueDate: null }, { text: ' ', dueDate: '2026-09-20' }] }))
        .toEqual({ rule: 'EMPTY_ACTION_ITEM' });
    });

    it('P11-T5 AC-4 UNDATED_ACTION_ITEM', () => {
      expect(finalizeRefusal({ ...ok, actionItems: [{ text: 'x', dueDate: null }] })).toEqual({ rule: 'UNDATED_ACTION_ITEM' });
    });

    it('P11-T5 AC-4 LEAD_THIS_MONTH_UNDATED names the first such lead in the order they were registered', () => {
      const leads = [
        lead({ id: 'z', name: 'Pak Later', thisMonth: true, registeredAt: 5 }),
        lead({ id: 'b', name: 'Ibu Tie B', thisMonth: true, registeredAt: 2 }),
        lead({ id: 'a', name: 'Ibu Tie A', thisMonth: true, registeredAt: 2 }),
        lead({ id: 'dated', thisMonth: true, nextActionDate: '2026-09-20', registeredAt: 1 }),
        lead({ id: 'not-promised', registeredAt: 0 }),
      ];
      expect(finalizeRefusal({ ...ok, leads })).toEqual({ rule: 'LEAD_THIS_MONTH_UNDATED', leadId: 'a', leadName: 'Ibu Tie A' });
      expect(finalizeRefusal({ ...ok, leads: [leads[2], leads[1]] })).toMatchObject({ leadId: 'a' });
    });

    it('P11-T5 AC-4 carries the prototype’s sentence for each rule', () => {
      expect(FINALIZE_RULES.map((rule) => finalizeSentence({ rule, leadName: 'Pak Fauzan Akbar' }))).toEqual([
        'Add at least one action item before finalizing.',
        'Fill in or remove the empty coaching tip before finalizing.',
        'Fill in or remove the empty action item before finalizing.',
        'Every action item needs a date before finalizing.',
        'Pak Fauzan Akbar is tagged "this month" but has no next action date set — add one before finalizing.',
      ]);
    });
  });

  describe('the reopen window (ADR-0079)', () => {
    it('P11-T5 AC-6 runs COACHING_REOPEN_WINDOW_DAYS from the session’s date, inclusive, across a month end', () => {
      expect(COACHING.REOPEN_WINDOW_DAYS).toBe(7);
      expect(reopenableUntil('2026-09-28')).toBe('2026-10-05');
      expect(reopenWindowOpen('2026-09-28', '2026-09-28')).toBe(true);
      expect(reopenWindowOpen('2026-09-28', '2026-10-05')).toBe(true);
      expect(reopenWindowOpen('2026-09-28', '2026-10-06')).toBe(false);
    });
  });

  describe('one notice per session (P11-T8)', () => {
    it('P11-T8 AC-4 keys the notice by the session and its round: how many times it was reopened', () => {
      expect(coalesceKeyOf({ _id: 'abc', corrections: [] })).toBe('abc:0');
      expect(coalesceKeyOf({ _id: 'abc', corrections: [{}, {}] })).toBe('abc:2');
    });
  });
});
