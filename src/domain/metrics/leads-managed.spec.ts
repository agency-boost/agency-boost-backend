import { leadFlags } from '@/modules/leads/lead-attention';
import { leadsManaged } from './leads-managed';

const TODAY = '2026-11-20';

describe('MANAGED_LEADS_RATE — a member’s Leads Mgmt (P19.19-T3 AC-2; OD-395)', () => {
  it('P19.19-T3 AC-2 every open lead with a next action today or later is managed', () => {
    expect(leadsManaged(['2026-11-20', '2026-12-01'], TODAY)).toBe(true);
  });

  it('P19.19-T3 AC-2 one lead with no next action, or an overdue one, is not', () => {
    expect(leadsManaged(['2026-12-01', null], TODAY)).toBe(false);
    expect(leadsManaged(['2026-12-01', '2026-11-19'], TODAY)).toBe(false);
    expect(leadsManaged([''], TODAY)).toBe(false);
  });

  it('P19.19-T3 AC-2 a member with no open lead has nothing managed: not done', () => {
    expect(leadsManaged([], TODAY)).toBe(false);
  });

  it.each([
    ['2026-11-20'], ['2026-11-21'], ['2026-11-19'], [null],
  ])('P19.19-T3 AC-2 agrees with leadFlags’ two flags for a lead whose next action is %s', (day) => {
    const flagged = leadFlags({ outcome: null, nextActionDate: day, remarks: 'x' }, TODAY)
      .some((f) => f === 'no-next-action' || f === 'overdue');
    expect(leadsManaged([day], TODAY)).toBe(!flagged);
  });
});
