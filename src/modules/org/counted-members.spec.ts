import {
  COUNTED_MEMBER, countedMembers, isCountedMember, isCountedOffice, KELUAR, MENUNGGU, NOT_A_TEST_ACCOUNT,
} from './counted-members';

/**
 * **The counted member, pinned** (P19.26-T1 AC-1; ADR-0284 §1; `metrics-and-definitions.md`, *Anggota (counted
 * member)*). Every count of members on the console reads this one rule; a change to it must fail here first.
 */
describe('the counted member (UI-204, 21 Nov)', () => {
  it('is an Aktif membership, not erased, never a test account', () => {
    expect(COUNTED_MEMBER).toEqual({ status: 'active', deletedAt: null, testAccount: { $ne: true } });
  });

  it('keeps Menunggu and Keluar as separate named counts, test accounts never in either', () => {
    expect(MENUNGGU).toEqual({ status: 'pending', deletedAt: null, ...NOT_A_TEST_ACCOUNT });
    expect(KELUAR).toEqual({ status: 'removed', deletedAt: null, ...NOT_A_TEST_ACCOUNT });
  });

  it('narrows a filter, replacing any status, erasure or test-account clause it named', () => {
    expect(countedMembers({ kpmId: 'k1', status: 'removed', testAccount: true, deletedAt: new Date(0) }))
      .toEqual({ kpmId: 'k1', status: 'active', deletedAt: null, testAccount: { $ne: true } });
    expect(countedMembers()).toEqual(COUNTED_MEMBER);
  });

  it.each([
    [{ status: 'active' }, true],
    [{ status: 'active', testAccount: false, deletedAt: null }, true],
    [{ status: 'active', testAccount: null }, true],
    [{ status: 'pending' }, false],
    [{ status: 'removed' }, false],
    [{ status: 'active', testAccount: true }, false],
    [{ status: 'active', deletedAt: new Date('2026-11-01T00:00:00Z') }, false],
  ])('as a predicate, %o is counted: %s', (row, counted) => {
    expect(isCountedMember(row)).toBe(counted);
  });

  it.each([
    [{ status: 'active' }, true],
    [{ status: 'suspended', deletedAt: null }, true],
    [{ status: 'archived' }, false],
    [{ status: 'active', deletedAt: '2026-11-01T00:00:00Z' }, false],
  ])('counts the members of a KPM %o: %s', (kpm, counted) => {
    expect(isCountedOffice(kpm)).toBe(counted);
  });
});
