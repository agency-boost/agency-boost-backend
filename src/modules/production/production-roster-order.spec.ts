import type { HierarchyRole } from '@/modules/org/membership.schema';
import { orgTreeOrder, type TreeMember } from './production-roster-order';

let seq = 0;
const m = (id: string, name: string, role: HierarchyRole | null, leaderId: string | null = null): TreeMember =>
  ({ membershipId: id, name, role, leaderId, agentSeq: ++seq });
const names = (rows: TreeMember[]) => rows.map((r) => r.name);

/**
 * P13.1-T7 AC-2 — the month table's rows, and the template's, in the order the org tree reads.
 */
describe('orgTreeOrder (P13.1-T7)', () => {
  beforeEach(() => { seq = 0; });

  /**
   * The prototype's own forest (`KPM_Owner.html:2095-2124`), joined in an order unrelated to it.
   * Its walk (`:4662-4677`) gives Hendra's tree, Wilson's, Budi's and Fajar's, in the order the array
   * was typed; within a level ours is by name, so the ABs and the agents under one leader sort, and
   * the shape of the walk is the prototype's.
   */
  const FOREST = (): TreeMember[] => [
    m('reza', 'Reza Firmansyah', 'agent', 'putri'),
    m('wilson', 'Wilson Tanoto', 'ab'),
    m('dedy', 'Dedy Pranata', 'agent', 'hendra'),
    m('ika', 'Ika Wirawan', 'aab', 'hendra'),
    m('andi', 'Andi Kurniawan', 'agent', 'wilson'),
    m('agus3', 'Agus Prasetyo', 'agent', 'ika'),
    m('hendra', 'Hendra Wibowo', 'ab'),
    m('budi', 'Budi Santoso', 'ab'),
    m('yoga', 'Yoga Pratama', 'aab', 'hendra'),
    m('putri2', 'Putri Ramadhani', 'aab', 'wilson'),
    m('lestari', 'Ayu Lestari', 'agent', 'putri2'),
    m('nita', 'Nita Kurniasih', 'agent', 'ika'),
    m('rina2', 'Rina Agustina', 'agent', 'hendra'),
    m('sinta', 'Sinta Halim', 'agent', 'hendra'),
    m('wawan', 'Wawan Setiadi', 'agent', 'yoga'),
    m('joko2', 'Joko Susilo', 'agent', 'putri2'),
    m('dewi', 'Dewi Anggraini', 'aab', 'budi'),
    m('made2', 'Made Wirawan', 'agent', 'dewi'),
    m('fajar', 'Fajar Nugroho', 'ab'),
    m('putri', 'Putri Lestari', 'aab', 'fajar'),
    m('agus2', 'Agus Setiawan', 'aab', 'fajar'),
  ];

  it('AC-2: walks the prototype’s forest — each AB, its AABs each with their agents, then its own agents', () => {
    expect(names(orgTreeOrder(FOREST()))).toEqual([
      'Budi Santoso',
      'Dewi Anggraini', 'Made Wirawan',
      'Fajar Nugroho',
      'Agus Setiawan',
      'Putri Lestari', 'Reza Firmansyah',
      'Hendra Wibowo',
      'Ika Wirawan', 'Agus Prasetyo', 'Nita Kurniasih',
      'Yoga Pratama', 'Wawan Setiadi',
      'Dedy Pranata', 'Rina Agustina', 'Sinta Halim',
      'Wilson Tanoto',
      'Putri Ramadhani', 'Ayu Lestari', 'Joko Susilo',
      'Andi Kurniawan',
    ]);
  });

  it('AC-2: is the same order whatever order the members arrive in', () => {
    const once = names(orgTreeOrder(FOREST()));
    expect(names(orgTreeOrder([...FOREST()].reverse()))).toEqual(once);
  });

  it('AC-2: puts an agent’s AAB-led siblings first even when the agent’s name comes first', () => {
    const rows = orgTreeOrder([
      m('ab', 'Zainal', 'ab'),
      m('a1', 'Ani', 'agent', 'ab'),
      m('aab', 'Yusuf', 'aab', 'ab'),
      m('a2', 'Bambang', 'agent', 'aab'),
    ]);
    expect(names(rows)).toEqual(['Zainal', 'Yusuf', 'Bambang', 'Ani']);
  });

  it('AC-2: follows the same walk at every depth — an AB under an AB comes first, with all of theirs', () => {
    const rows = orgTreeOrder([
      m('owner', 'Owner', 'ab'),
      m('agent', 'Ada', 'agent', 'owner'),
      m('aab', 'Bima', 'aab', 'owner'),
      m('sub', 'Citra', 'ab', 'owner'),
      m('subaab', 'Dian', 'aab', 'sub'),
      m('subagent', 'Eka', 'agent', 'subaab'),
      m('deep', 'Fani', 'agent', 'subagent'),
    ]);
    expect(names(rows)).toEqual(['Owner', 'Citra', 'Dian', 'Eka', 'Fani', 'Bima', 'Ada']);
  });

  it('AC-2: puts anybody with no leader here last, by name, each with whoever is under them', () => {
    const rows = orgTreeOrder([
      m('loose-agent', 'Andi', 'agent'),
      m('orphan-aab', 'Bayu', 'aab'),
      m('orphans-agent', 'Cici', 'agent', 'orphan-aab'),
      m('top', 'Zaki', 'ab'),
      m('unknown-rung', 'Ani', null),
    ]);
    expect(names(rows)).toEqual(['Zaki', 'Andi', 'Ani', 'Bayu', 'Cici']);
  });

  it('AC-2: treats a leader who is not in the list as no leader — they are pending, removed or another office’s', () => {
    const rows = orgTreeOrder([
      m('a', 'Budi', 'agent', 'gone'),
      m('top', 'Wati', 'ab'),
      m('b', 'Ayu', 'agent', 'top'),
    ]);
    expect(names(rows)).toEqual(['Wati', 'Ayu', 'Budi']);
  });

  it('AC-2: sorts names without regard to case or accents, and breaks a tie on the office’s sequence', () => {
    const rows = orgTreeOrder([
      m('top', 'Top', 'ab'),
      m('x2', 'rina', 'agent', 'top'),
      m('x1', 'Rina', 'agent', 'top'),
      m('e', 'Éka', 'agent', 'top'),
      m('d', 'dewi', 'agent', 'top'),
    ]);
    // `x2` was made first, so it holds the lower sequence and wins the tie on name.
    expect(rows.map((r) => r.membershipId)).toEqual(['top', 'd', 'e', 'x2', 'x1']);
  });

  it('AC-2: falls back to the id when name and sequence both tie, so no two reads disagree', () => {
    const twin = (id: string): TreeMember => ({ membershipId: id, name: 'Rina', role: 'agent', leaderId: null, agentSeq: 7 });
    expect(orgTreeOrder([twin('m-b'), twin('m-a')]).map((r) => r.membershipId)).toEqual(['m-a', 'm-b']);
  });

  it('AC-2: lists everybody once, even a leader edge that loops — which nothing writes, and nothing drops', () => {
    const rows = orgTreeOrder([
      m('top', 'Top', 'ab'),
      m('a', 'Ani', 'agent', 'b'),
      m('b', 'Bea', 'agent', 'a'),
      m('self', 'Cak', 'agent', 'self'),
    ]);
    expect(names(rows)).toEqual(['Top', 'Cak', 'Ani', 'Bea']);
  });

  it('AC-2: reads a rung it does not know, or none, as an agent’s, rather than sorting it nowhere', () => {
    const rows = orgTreeOrder([
      m('top', 'Top', 'ab'),
      m('odd', 'Ani', 'mentor' as HierarchyRole, 'top'),
      m('aab', 'Zul', 'aab', 'top'),
      m('agent', 'Budi', 'agent', 'top'),
      m('none', 'Asih', null, 'top'),
    ]);
    expect(names(rows)).toEqual(['Top', 'Zul', 'Ani', 'Asih', 'Budi']);
  });

  it('keeps every field it was given, and is empty for nobody', () => {
    const rows = orgTreeOrder([{ ...m('top', 'Top', 'ab'), agentCode: 'PRU-1' }]);
    expect(rows[0]).toMatchObject({ membershipId: 'top', agentCode: 'PRU-1' });
    expect(orgTreeOrder([])).toEqual([]);
  });
});
