import { partitionAgencies, type PlacedMembership } from './agency-partition';

/** Build the office from `who → leader` pairs, root first, each on a rung. */
function office(rows: [id: string, rung: string, leader: string | null, active?: boolean][]): PlacedMembership[] {
  const byId = new Map<string, PlacedMembership>();
  for (const [id, rung, leader, active = true] of rows) {
    const above = leader === null ? [] : [...byId.get(leader)!.ancestorIds, leader];
    byId.set(id, { membershipId: id, orgLevelCode: rung, leaderId: leader, ancestorIds: above, active });
  }
  return [...byId.values()];
}

describe('AB agencies (D-units)', () => {
  /*
   * owner (AB) ─┬─ admin (AB)
   *             ├─ agus (AB) ─┬─ indah (AGENT)
   *             │             ├─ sari (AAB) ─┬─ rina (AGENT)
   *             │             │              └─ nina (AAB) ── dodi (AGENT)       a unit nested in a unit
   *             │             ├─ dewi (AAB, leads nobody)
   *             │             ├─ lukas (AGENT) ── tari (AGENT)                   an agent who leads
   *             │             └─ budi (AB, two levels down) ── yoga (AGENT)      an AB under an AB under an AB
   *             ├─ left (AGENT, removed)
   *             └─ putu (AGENT)
   * orphan (AGENT, no leader)
   */
  const rows = office([
    ['owner', 'AB', null], ['admin', 'AB', 'owner'], ['agus', 'AB', 'owner'], ['indah', 'AGENT', 'agus'],
    ['sari', 'AAB', 'agus'], ['rina', 'AGENT', 'sari'], ['nina', 'AAB', 'sari'], ['dodi', 'AGENT', 'nina'],
    ['dewi', 'AAB', 'agus'], ['lukas', 'AGENT', 'agus'], ['tari', 'AGENT', 'lukas'], ['budi', 'AB', 'agus'],
    ['yoga', 'AGENT', 'budi'], ['left', 'AGENT', 'owner', false], ['putu', 'AGENT', 'owner'], ['orphan', 'AGENT', null],
  ]);
  const { agencies, unplacedIds } = partitionAgencies(rows);
  const of = (head: string) => agencies.find((a) => a.headId === head)!;

  it('P18-T2 AC-2 one agency per AB, an AB two levels down its own, the rows partitioning everybody placed', () => {
    expect(agencies.map((a) => a.headId).sort()).toEqual(['admin', 'agus', 'budi', 'owner']);
    expect(of('budi').memberIds).toEqual(['budi', 'yoga']);
    expect(of('agus').memberIds).not.toContain('yoga');
    const placed = agencies.flatMap((a) => a.memberIds);
    expect(new Set(placed).size).toBe(placed.length);
    expect([...placed, ...unplacedIds].sort()).toEqual(rows.map((r) => r.membershipId).sort());
  });

  it('P18-T2 AC-2 inside an agency: (Direct) is the AB and those in no AAB’s unit; a unit per AAB who leads, nested ones their own', () => {
    expect(of('agus').directIds).toEqual(['agus', 'indah', 'dewi', 'lukas', 'tari']);
    expect(of('agus').units).toEqual([
      { headId: 'sari', memberIds: ['sari', 'rina'] },
      { headId: 'nina', memberIds: ['nina', 'dodi'] },
    ]);
    expect(of('admin')).toEqual({ headId: 'admin', directIds: ['admin'], units: [], memberIds: ['admin'] });
  });

  it('P18-T2 AC-2 a leaver is placed by the edges they left with and heads nothing; somebody under no AB is unplaced', () => {
    expect(of('owner').directIds).toEqual(['owner', 'left', 'putu']);
    expect(unplacedIds).toEqual(['orphan']);
    // A unit head who has left heads no unit, and their people fall to the agency's (Direct) row.
    const gone = partitionAgencies(office([['ab', 'AB', null], ['aab', 'AAB', 'ab', false], ['agent', 'AGENT', 'aab']]));
    expect(gone.agencies[0]).toMatchObject({ directIds: ['ab', 'aab', 'agent'], units: [] });
  });

  it('P18-T2 AC-2 a unit’s member read before its head still lands in the head’s unit, the head first', () => {
    const rowsOut = office([['ab', 'AB', null], ['aab', 'AAB', 'ab'], ['agent', 'AGENT', 'aab']]);
    const reversed = partitionAgencies([rowsOut[0], rowsOut[2], rowsOut[1]]);
    expect(reversed.agencies[0].units).toEqual([{ headId: 'aab', memberIds: ['aab', 'agent'] }]);
  });
});
