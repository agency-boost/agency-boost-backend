import { personLeadCounts } from './lead-counts';
import { ownOpenLeads } from './own-open-leads';

/** **P19.8-T2 AC-10 — `OWN_OPEN_LEADS`** (§A.17; OD-283): the reader's own open Sales and Recruit leads. */
describe('P19.8-T2 OWN_OPEN_LEADS (§A.17)', () => {
  const office = { month: '2026-11', terminalRecruitmentCodes: ['JOINED'] };

  it('P19.8-T2 AC-10 OD-283 adds OPEN_SALES_LEADS and RECRUITMENT_PIPELINE_NOW over one owner, and nothing else', () => {
    const counts = personLeadCounts([
      { type: 'sales', outcome: null, statusCode: 'FOLLOW_UP' },
      { type: 'sales', outcome: null, statusCode: null, commitments: [{ month: '2026-11' }] },
      { type: 'recruitment', outcome: null, statusCode: 'INVITED' },
      // Won, lost, on the office's terminal recruitment stage, or of no type: none is an open lead.
      { type: 'sales', outcome: 'won', statusCode: 'PAID_AND_ISSUED' },
      { type: 'recruitment', outcome: 'lost', statusCode: 'INVITED' },
      { type: 'recruitment', outcome: null, statusCode: 'JOINED' },
      { type: null, outcome: null, statusCode: null },
    ], office);
    expect(ownOpenLeads(counts)).toBe(3);
    expect(ownOpenLeads(counts)).toBe(counts.salesOpen + counts.recruitOpen);
  });

  it('P19.8-T2 AC-10 a reader with no lead, or no row at all, has 0', () => {
    expect(ownOpenLeads(personLeadCounts([], office))).toBe(0);
    expect(ownOpenLeads(undefined)).toBe(0);
  });
});
