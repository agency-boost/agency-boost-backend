import { activityPeriodOf, closingsIn, mondayOf, rosterScopes } from './unit-figures';

/** The UI V1 rules of the Unit Dashboard (Phase 18.99 T4), pure. */
describe('the Unit Dashboard’s UI V1 figures', () => {
  describe('UI-001 the Activities period', () => {
    it('UI-001 a week runs Monday to Sunday, whichever day names it', () => {
      for (const day of ['2026-10-26', '2026-10-28', '2026-11-01']) expect(mondayOf(day)).toBe('2026-10-26');
      expect(mondayOf('2026-11-02')).toBe('2026-11-02');
      // Across a month and a year.
      expect(mondayOf('2027-01-01')).toBe('2026-12-28');
    });

    it('UI-001 the current week: 26 Okt – 1 Nov 2026, › going nowhere, ‹ to the week before', () => {
      expect(activityPeriodOf('week', '2026-10-30', '2026-10-30')).toEqual({
        span: 'week', from: '2026-10-26', to: '2026-11-01', current: true, previous: '2026-10-25', next: null,
      });
    });

    it('UI-001 a past week: › to the week after, which may be the current one', () => {
      expect(activityPeriodOf('week', '2026-10-21', '2026-10-30')).toEqual({
        span: 'week', from: '2026-10-19', to: '2026-10-25', current: false, previous: '2026-10-18', next: '2026-10-26',
      });
    });

    it('UI-001 a month is its calendar month; the current one has no ›, a past one goes to its next', () => {
      expect(activityPeriodOf('month', '2026-10-30', '2026-10-30')).toEqual({
        span: 'month', from: '2026-10-01', to: '2026-10-31', current: true, previous: '2026-09-30', next: null,
      });
      expect(activityPeriodOf('month', '2026-02-10', '2026-10-30')).toEqual({
        span: 'month', from: '2026-02-01', to: '2026-02-28', current: false, previous: '2026-01-31', next: '2026-03-01',
      });
    });
  });

  describe('UI-028 Closing (O-4): a sales lead that reached Paid and issued in the period', () => {
    const window = { from: '2026-10-01', to: '2026-10-30' };

    it('UI-028 counts the closings inside the window, on the office’s calendar', () => {
      const at = (iso: string) => ({ at: new Date(iso) });
      expect(closingsIn([
        at('2026-10-15T03:00:00Z'),
        // 00:30 on 1 October in Jakarta — inside, though 30 September in UTC.
        at('2026-09-30T17:30:00Z'),
        // 23:30 on 30 September in Jakarta — outside.
        at('2026-09-30T16:30:00Z'),
        // 1 November in Jakarta — after the window.
        at('2026-10-31T18:00:00Z'),
      ], window, 'Asia/Jakarta')).toBe(2);
    });

    it('UI-028 is 0 with no closings', () => {
      expect(closingsIn([], window, 'Asia/Jakarta')).toBe(0);
    });
  });

  describe('UI-001 the roster’s scopes: Unit and Group (D-16)', () => {
    const names: Record<string, string> = {
      ab: 'Agus', indah: 'Indah', dimas: 'Dimas', sari: 'Sari', rina: 'Rina', nina: 'Nina', dodi: 'Dodi', dewi: 'Dewi',
      lukas: 'Lukas', tari: 'Tari',
    };
    const members = [
      { membershipId: 'indah', leaderId: 'ab', role: 'agent' },
      { membershipId: 'sari', leaderId: 'ab', role: 'aab' },
      { membershipId: 'dimas', leaderId: 'ab', role: 'agent' },
      { membershipId: 'rina', leaderId: 'sari', role: 'agent' },
      { membershipId: 'nina', leaderId: 'sari', role: 'aab' },
      { membershipId: 'dodi', leaderId: 'nina', role: 'agent' },
      { membershipId: 'dewi', leaderId: 'ab', role: 'aab' },
      { membershipId: 'lukas', leaderId: 'ab', role: 'agent' },
      { membershipId: 'tari', leaderId: 'lukas', role: 'agent' },
    ];

    it('UI-001 the Unit is the head and their direct agents who lead nobody, A to Z', () => {
      expect(rosterScopes('ab', members, (id) => names[id]).unit).toEqual(['ab', 'dimas', 'indah']);
    });

    it('UI-001 the Group is the Unit, then each unit below — its head, its members, the units nested in it — A to Z', () => {
      expect(rosterScopes('ab', members, (id) => names[id]).group).toEqual([
        'ab', 'dimas', 'indah',
        'dewi',
        'lukas', 'tari',
        'sari', 'rina', 'nina', 'dodi',
      ]);
    });

    it('UI-001 a head who leads nobody is a Unit and a Group of one', () => {
      expect(rosterScopes('ab', [], () => '')).toEqual({ unit: ['ab'], group: ['ab'] });
    });

    it('UI-001 two people of one name are ordered by id, whichever came first: the same order on every read', () => {
      const twins = ['m-3', 'm-1', 'm-2'].map((membershipId) => ({ membershipId, leaderId: 'ab', role: 'agent' }));
      const order = rosterScopes('ab', twins, () => 'Budi Santoso');
      expect(order.unit).toEqual(['ab', 'm-1', 'm-2', 'm-3']);
      expect(rosterScopes('ab', [...twins].reverse(), () => 'Budi Santoso')).toEqual(order);
    });
  });
});
