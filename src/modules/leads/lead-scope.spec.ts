import { scopedOwners } from './lead.service';

/**
 * **P19.9-T1 AC-3 — `scope` over the owners a list reaches** (ADR-0232; OD-286 by its default): it narrows and never
 * widens. The tenancy spec reads it on real rows; this pins each branch, the whole office's `null` included.
 */
describe('P19.9-T1 scopedOwners', () => {
  const reach = ['m-agus', 'm-sari', 'm-rina'];

  it('P19.9-T1 AC-3 absent is the reach as it was', () => {
    expect(scopedOwners(reach, undefined, 'm-agus')).toBe(reach);
    expect(scopedOwners(null, undefined, 'm-agus')).toBeNull();
  });

  it('P19.9-T1 AC-2 own is the reader alone, and only where the reach holds them', () => {
    expect(scopedOwners(reach, 'own', 'm-agus')).toEqual(['m-agus']);
    // `owner=` naming somebody else: the reach is them, and the reader's own is nobody.
    expect(scopedOwners(['m-rina'], 'own', 'm-agus')).toEqual([]);
    expect(scopedOwners(null, 'own', 'm-agus')).toEqual(['m-agus']);
  });

  it('P19.9-T1 AC-3 OD-286 team is everybody else the reach holds; the whole office stays the office, the list leaving the reader out', () => {
    expect(scopedOwners(reach, 'team', 'm-agus')).toEqual(['m-sari', 'm-rina']);
    expect(scopedOwners(['m-agus'], 'team', 'm-agus')).toEqual([]);
    expect(scopedOwners(null, 'team', 'm-agus')).toBeNull();
  });
});
