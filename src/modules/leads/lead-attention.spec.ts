import { leadFlags } from './lead-attention';
import { byNextAction } from './lead-readings';

const TODAY = '2026-09-14';
const open = (over: Record<string, unknown> = {}) => ({ outcome: null, nextActionDate: '2026-09-20', remarks: 'Hobi golf', ...over });

/** The one definition of a lead's attention flags (P7-T4), read by the Leads screen and the Summary (P10-T6). */
describe('leadFlags', () => {
  it('flags nothing on a lead with a date ahead and something written', () => {
    expect(leadFlags(open(), TODAY)).toEqual([]);
  });

  it('flags a date before the office’s today, and not today itself', () => {
    expect(leadFlags(open({ nextActionDate: '2026-09-13' }), TODAY)).toEqual(['overdue']);
    expect(leadFlags(open({ nextActionDate: TODAY }), TODAY)).toEqual([]);
  });

  it('no date is its own flag, never also overdue — and no remarks is another', () => {
    expect(leadFlags(open({ nextActionDate: null, remarks: null }), TODAY)).toEqual(['no-next-action', 'no-remarks']);
  });

  it('a closed lead asks for nothing, whatever its dates say', () => {
    expect(leadFlags(open({ outcome: 'won', nextActionDate: null, remarks: null }), TODAY)).toEqual([]);
  });
});

describe('byNextAction — nearest first, undated last (P10-T6)', () => {
  const row = (id: string, nextActionDate: string | null, registeredAt = 0) => ({ id, nextActionDate, registeredAt });

  it('orders by date, the latest-running first, and puts no date after every date', () => {
    const rows = [row('a', null), row('b', '2026-09-20'), row('c', '2026-09-01'), row('d', null)];
    expect(rows.sort(byNextAction).map((r) => r.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('P19.11-T5 AC-3 the Summary’s order: the most overdue on top, then today and later, then the undated — waiting longest first', () => {
    const rows = [
      row('undated-new', null, 9), row('later', '2026-09-30'), row('today', '2026-09-14'),
      row('undated-old', null, 1), row('overdue', '2026-08-20'),
    ];
    expect(rows.sort(byNextAction).map((r) => r.id)).toEqual(['overdue', 'today', 'later', 'undated-old', 'undated-new']);
  });

  it('keeps registration order between equals, then the id — two reads never shuffle', () => {
    const rows = [row('z', '2026-09-20', 2), row('y', '2026-09-20', 1), row('b', null, 5), row('a', null, 5)];
    expect(rows.sort(byNextAction).map((r) => r.id)).toEqual(['y', 'z', 'a', 'b']);
  });
});
