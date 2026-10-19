import {
  LEAD_SORT_KEYS, isInMemorySort, ladderRanks, leadOrder, typeOrder, type Orderable,
} from './lead-order';

/** Two ladders as the published config lists them, in the dropdown's order. */
const RANKS = ladderRanks([
  { pipeline: 'sales', statuses: [{ code: 'NOT_YET_APPROACHED' }, { code: 'FOLLOW_UP' }] },
  { pipeline: 'recruitment', statuses: [{ code: 'NOT_APPROACHED' }, { code: 'MEETING_SCHEDULED' }] },
]);

const row = (
  id: string, type: Orderable['type'], statusCode: string | null, registered: string | null,
): Orderable => ({
  _id: id, name: null, type, statusCode, dateRegistered: registered ? new Date(registered) : null,
});

const named = (id: string, name: string | null): Orderable => ({ ...row(id, null, null, null), name });

const ids = (rows: Orderable[]) => rows.map((r) => r._id);

/**
 * The order of the prototype's *Lead name*, *Type* and *Status* columns (P10.1-T4 AC-3). The
 * service applies it over a real office in `lead.tenancy.spec.ts`; these are the edges no seeded
 * office reaches.
 */
describe('leadOrder', () => {
  it('answers the five keys, the prototype’s four and the next-action date', () => {
    expect([...LEAD_SORT_KEYS].sort())
      .toEqual(['dateRegistered', 'name', 'nextActionDate', 'status', 'type']);
  });

  it('orders name, type and status itself, and leaves registration and next action to the database', () => {
    expect(LEAD_SORT_KEYS.filter(isInMemorySort)).toEqual(['name', 'type', 'status']);
    expect(isInMemorySort(undefined)).toBe(false);
  });

  it('ranks a stage by its place in the ladder it is given, per pipeline', () => {
    expect([...RANKS]).toEqual([
      ['sales:NOT_YET_APPROACHED', 0], ['sales:FOLLOW_UP', 1],
      ['recruitment:NOT_APPROACHED', 0], ['recruitment:MEETING_SCHEDULED', 1],
    ]);
  });

  it('sorts names without regard to case or accents, as the prototype’s lowercase `localeCompare`', () => {
    // A byte order gives Adi, Fikri, Zed, budi, Émile: every capital before every lowercase, and
    // É after Z.
    const rows = [named('1', 'Zed'), named('2', 'budi'), named('3', 'Émile'), named('4', 'Adi'), named('5', 'Fikri')];

    expect(rows.sort(leadOrder('name', 'asc', RANKS)).map((r) => r.name))
      .toEqual(['Adi', 'budi', 'Émile', 'Fikri', 'Zed']);
    expect(rows.sort(leadOrder('name', 'desc', RANKS)).map((r) => r.name))
      .toEqual(['Zed', 'Fikri', 'Émile', 'budi', 'Adi']);
  });

  it('breaks a tie on name by the id alone, in the sort’s direction', () => {
    // *Budi* and *budi* are one name to this order, and so are *Andé* and *Ande*.
    const rows = [named('b', 'budi'), named('c', 'Ande'), named('a', 'Budi'), named('d', 'Andé')];

    expect(ids(rows.sort(leadOrder('name', 'asc', RANKS)))).toEqual(['c', 'd', 'a', 'b']);
    expect(ids(rows.sort(leadOrder('name', 'desc', RANKS)))).toEqual(['b', 'a', 'd', 'c']);
  });

  it('puts a lead with no name first, ascending, whichever side it is on', () => {
    const byName = leadOrder('name', 'asc', RANKS);

    expect(byName(named('b', null), named('a', 'Adi'))).toBeLessThan(0);
    expect(byName(named('a', 'Adi'), named('b', null))).toBeGreaterThan(0);
  });

  it('orders type blank, Sales, Recruitment (`Overall.html:5434-5436`)', () => {
    expect([typeOrder(null), typeOrder('sales'), typeOrder('recruitment')]).toEqual([0, 1, 2]);
  });

  it('counts a stage its own ladder does not hold as blank, as the prototype’s -1 does', () => {
    // FOLLOW_UP is a sales code. On a recruitment lead it matches nothing — ranks are per ladder.
    const rows = [
      row('b', 'sales', 'NOT_YET_APPROACHED', '2026-09-01'),
      row('a', 'recruitment', 'FOLLOW_UP', '2026-09-01'),
    ];

    expect(ids(rows.sort(leadOrder('status', 'asc', RANKS)))).toEqual(['a', 'b']);
  });

  it('puts a lead with no registration date first among equals, ascending', () => {
    const rows = [row('b', 'sales', null, '2026-09-01'), row('a', 'sales', null, null)];

    expect(ids(rows.sort(leadOrder('type', 'asc', RANKS)))).toEqual(['a', 'b']);
  });

  it('breaks the last tie on the id, so equal leads never swap between two reads', () => {
    const rows = [
      row('66f000000000000000000002', 'sales', 'FOLLOW_UP', '2026-09-01'),
      row('66f000000000000000000001', 'sales', 'FOLLOW_UP', '2026-09-01'),
    ];

    expect(ids(rows.sort(leadOrder('status', 'asc', RANKS))))
      .toEqual(['66f000000000000000000001', '66f000000000000000000002']);
  });

  it('sorts descending when no direction is given, as the database sorts do', () => {
    const rows = [row('a', null, null, '2026-09-01'), row('b', 'recruitment', null, '2026-09-01')];

    expect(ids(rows.sort(leadOrder('type', undefined, RANKS)))).toEqual(['b', 'a']);
  });
});
