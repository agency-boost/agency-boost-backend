import { ownOpenLeadsFilter } from './own-open-leads';

/**
 * **P19.9-T1 AC-5 — `OWN_OPEN_LEADS`** (§A.17; ADR-0232, answering OD-283): every open lead the reader owns, any type and
 * any stage — what `/leads` opens on. `home.tenancy.spec.ts` holds the tile to the list's own total on real rows.
 */
describe('P19.9-T1 OWN_OPEN_LEADS (§A.17)', () => {
  it('P19.9-T1 AC-5 is the owner and no outcome, and nothing else: no type, no stage, no other owner', () => {
    expect(ownOpenLeadsFilter('m-rina')).toEqual({ ownerMembershipId: 'm-rina', outcome: null });
    // Neither of the two counts it once added: a lead of no type and a recruit on the terminal stage are open leads.
    expect(Object.keys(ownOpenLeadsFilter('m-rina')).sort()).toEqual(['outcome', 'ownerMembershipId']);
  });
});
