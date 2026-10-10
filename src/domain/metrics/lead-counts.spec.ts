import { personLeadCounts, personLeadCountsAt, type DatedLead } from './lead-counts';

const END_OF_SEP = new Date('2026-09-30T17:00:00Z');
const before = new Date('2026-09-10T03:00:00Z');
const after = new Date('2026-10-03T03:00:00Z');
const lead = (over: Partial<DatedLead>): DatedLead => ({
  type: 'recruitment', outcome: null, statusCode: null, commitments: [], registeredAt: new Date('2026-08-01T03:00:00Z'),
  outcomeAt: null, transitions: [], ...over,
});
const office = { month: '2026-09', terminalRecruitmentCodes: ['NEW_ACTIVE_AGENT'], at: END_OF_SEP };

describe('a person’s lead counts as they stood at the end of a month (D-period)', () => {
  it('P18-T2 AC-3 a lead registered after the month ended was not there', () => {
    expect(personLeadCountsAt([lead({ registeredAt: after })], office).recruitOpen).toBe(0);
    expect(personLeadCountsAt([lead({ registeredAt: null })], office).recruitOpen).toBe(1);
  });

  it('P18-T2 AC-3 a lead closed after the month ended was open in it; one closed in it, or with no stamp, was not', () => {
    expect(personLeadCountsAt([lead({ outcome: 'won', outcomeAt: after })], office).recruitOpen).toBe(1);
    expect(personLeadCountsAt([lead({ outcome: 'lost', outcomeAt: before })], office).recruitOpen).toBe(0);
    expect(personLeadCountsAt([lead({ outcome: 'won', outcomeAt: null })], office).recruitOpen).toBe(0);
  });

  it('P18-T2 AC-3 the stage is the last move by then: moved to the terminal stage after the month, it was running in it', () => {
    const moved = lead({
      statusCode: 'NEW_ACTIVE_AGENT',
      transitions: [{ toStatusCode: 'AAJI_LICENSED', at: before }, { toStatusCode: 'NEW_ACTIVE_AGENT', at: after }],
    });
    expect(personLeadCountsAt([moved], office).recruitOpen).toBe(1);
    const terminalThen = lead({ statusCode: 'NEW_ACTIVE_AGENT', transitions: [{ toStatusCode: 'NEW_ACTIVE_AGENT', at: before }] });
    expect(personLeadCountsAt([terminalThen], office).recruitOpen).toBe(0);
    // No move by then: no stage then. No history at all: the stage it holds.
    expect(personLeadCountsAt([lead({ statusCode: 'NEW_ACTIVE_AGENT', transitions: [{ toStatusCode: 'X', at: after }] })], office).recruitOpen).toBe(1);
    expect(personLeadCountsAt([lead({ statusCode: 'NEW_ACTIVE_AGENT', transitions: null })], office).recruitOpen).toBe(0);
  });

  it('P18-T2 AC-3 promised means promised for that month', () => {
    const sales = lead({ type: 'sales', commitments: [{ month: '2026-09' }] });
    expect(personLeadCountsAt([sales, lead({ commitments: [{ month: '2026-10' }] })], office))
      .toEqual({ salesOpen: 1, salesClosing: 1, recruitOpen: 1, recruitNominated: 0 });
  });

  it('P18-T2 AC-3 with nothing moved since, it agrees with the counts now', () => {
    const leads = [lead({ type: 'sales', commitments: [{ month: '2026-09' }] }), lead({ statusCode: 'AAJI_LICENSED' })];
    expect(personLeadCountsAt(leads, office)).toEqual(personLeadCounts(leads, office));
  });
});
