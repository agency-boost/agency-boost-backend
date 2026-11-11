import { partitionAgencies } from '@/modules/reporting/agency-partition';
import {
  absNotInInformalGroup, directGroup, downline, informalGroup, placeView, viewChosen, viewsOffered, type ViewMember,
} from './unit-view';

/**
 * Wilson's office, as the client's message of 11 November 2026 draws the problem (item 5): *"28 AAB"* counted the ABs
 * below him. W is the root AB.
 *
 * ```
 * W (ab)
 * ├─ A1 (agent)
 * ├─ S (aab) ─┬─ S1 (agent)
 * │           ├─ S2 (aab) ── S21 (agent)
 * │           └─ S3 (ab) ── S31 (agent)        an AB under an AAB
 * ├─ L (agent, leads) ── L1 (agent)
 * ├─ G (ab) ─┬─ G1 (agent)                     Agus: an AB below Wilson
 * │          ├─ G2 (aab) ── G21 (agent)
 * │          └─ H (ab) ── H1 (agent)           an AB below an AB
 * ├─ Y (ab)                                    an AB who leads nobody
 * └─ Q (ab, left) ── Q1 (agent)                a leaver: stops nothing
 * R (ab, a second root) ── R1 (agent)
 * N (agent, no leader)
 * ```
 */
const m = (id: string, role: string, path: string[], active = true): ViewMember => ({
  membershipId: id, role, ancestorIds: path, leaderId: path.length > 0 ? path[path.length - 1] : null, active,
});
const W = m('W', 'ab', []);
const OFFICE: ViewMember[] = [
  W,
  m('A1', 'agent', ['W']),
  m('S', 'aab', ['W']),
  m('S1', 'agent', ['W', 'S']),
  m('S2', 'aab', ['W', 'S']),
  m('S21', 'agent', ['W', 'S', 'S2']),
  m('S3', 'ab', ['W', 'S']),
  m('S31', 'agent', ['W', 'S', 'S3']),
  m('L', 'agent', ['W']),
  m('L1', 'agent', ['W', 'L']),
  m('G', 'ab', ['W']),
  m('G1', 'agent', ['W', 'G']),
  m('G2', 'aab', ['W', 'G']),
  m('G21', 'agent', ['W', 'G', 'G2']),
  m('H', 'ab', ['W', 'G']),
  m('H1', 'agent', ['W', 'G', 'H']),
  m('Y', 'ab', ['W']),
  m('R', 'ab', []),
  m('R1', 'agent', ['R']),
  m('N', 'agent', []),
];
const LEAVER = m('Q', 'ab', ['W'], false);
const UNDER_LEAVER = m('Q1', 'agent', ['W', 'Q']);
/** Wilson's coachees: his downline on the current edges, every link active — never the leaver's agent. */
const WILSON_DOWNLINE = OFFICE.filter((x) => x.ancestorIds.includes('W'));
const sorted = (ids: readonly string[]) => [...ids].sort();
const WILSON_DIRECT = ['W', 'A1', 'S', 'S1', 'S2', 'S21', 'L', 'L1'];

describe('the Unit Dashboard’s three views (P19.12-T6; ADR-0249; metrics §The views)', () => {
  describe('DIRECT_GROUP — Grup langsung', () => {
    it('P19.12-T6 AC-1 Wilson’s direct group leaves out every AB below him and their people, and keeps the nested AABs', () => {
      expect(directGroup('W', WILSON_DOWNLINE)).toEqual(WILSON_DIRECT);
      // G (Agus), H below him, Y, and S3 under an AAB: none, nor anybody of theirs.
      for (const id of ['G', 'G1', 'G2', 'G21', 'H', 'H1', 'Y', 'S3', 'S31']) {
        expect(directGroup('W', WILSON_DOWNLINE)).not.toContain(id);
      }
    });

    it('P19.12-T6 AC-1 an AB’s direct group stops at the next AB down, and an AAB’s at an AB under them', () => {
      expect(directGroup('G', OFFICE)).toEqual(['G', 'G1', 'G2', 'G21']);
      expect(directGroup('S', OFFICE)).toEqual(['S', 'S1', 'S2', 'S21']);
    });

    it('P19.12-T6 AC-1 an Agent who leads has their people; somebody who leads nobody is only themselves', () => {
      expect(directGroup('L', OFFICE)).toEqual(['L', 'L1']);
      expect(directGroup('Y', OFFICE)).toEqual(['Y']);
      expect(directGroup('A1', OFFICE)).toEqual(['A1']);
    });

    it('P19.12-T6 AC-1 a leaver stops no descent: their people stay in the group above, as partitionAgencies places them', () => {
      expect(directGroup('W', [...OFFICE, LEAVER, UNDER_LEAVER])).toEqual([...WILSON_DIRECT, 'Q', 'Q1']);
    });

    it('P19.12-T6 AC-1 for every active AB it is the agency partitionAgencies computes — one definition', () => {
      const everybody = [...OFFICE, LEAVER, UNDER_LEAVER];
      const partition = partitionAgencies(everybody.map((x) => ({
        membershipId: x.membershipId, orgLevelCode: x.role.toUpperCase(), role: x.role as 'ab' | 'aab' | 'agent',
        leaderId: x.leaderId, ancestorIds: x.ancestorIds, active: x.active !== false,
      })));
      const heads = everybody.filter((x) => x.role === 'ab' && x.active !== false).map((x) => x.membershipId);
      expect(sorted(partition.agencies.map((a) => a.headId))).toEqual(sorted(heads));
      for (const agency of partition.agencies) {
        expect({ head: agency.headId, ids: sorted(directGroup(agency.headId, everybody)) })
          .toEqual({ head: agency.headId, ids: sorted(agency.memberIds) });
      }
    });
  });

  describe('DOWNLINE — Semua downline', () => {
    it('P19.12-T6 AC-1 a leader’s is everybody below them on live links — the coachees — never the leaver’s agent', () => {
      expect(downline('W', [...OFFICE, LEAVER, UNDER_LEAVER], false)).toEqual(['W', ...WILSON_DOWNLINE.map((x) => x.membershipId)]);
    });

    it('P19.12-T6 AC-1 office-wide it is every active member: a second root, and somebody with no leader', () => {
      const ids = downline('W', [...OFFICE, LEAVER], true);
      expect(ids).toEqual(expect.arrayContaining(['R', 'R1', 'N']));
      expect(ids).not.toContain('Q');
      expect(ids).toHaveLength(OFFICE.length);
    });
  });

  describe('INFORMAL_GROUP — Grup informal', () => {
    it('P19.12-T6 AC-2 a tagged AB brings their own direct group — never the AB below them, who is tagged on their own', () => {
      expect(informalGroup('W', WILSON_DOWNLINE, new Set(['G']))).toEqual([...WILSON_DIRECT, 'G', 'G1', 'G2', 'G21']);
      expect(informalGroup('W', WILSON_DOWNLINE, new Set(['G', 'H']))).toEqual([
        ...WILSON_DIRECT, 'G', 'G1', 'G2', 'G21', 'H', 'H1',
      ]);
      // H tagged, G not: H's people come, G's do not.
      expect(informalGroup('W', WILSON_DOWNLINE, new Set(['H']))).toEqual([...WILSON_DIRECT, 'H', 'H1']);
    });

    it('P19.12-T6 AC-2 a tagged non-AB brings themselves alone; one already in the direct group changes nothing', () => {
      expect(informalGroup('W', WILSON_DOWNLINE, new Set(['A1']))).toEqual(WILSON_DIRECT);
      expect(informalGroup('W', WILSON_DOWNLINE, new Set(['G1']))).toEqual([...WILSON_DIRECT, 'G1']);
    });

    it('P19.12-T6 AC-2 a tag never widens reach (P3-T9 AC-1): a tagged person outside the downline is nobody’s', () => {
      // R and R1 are another root's: a tag on them, by Wilson's group, reaches neither.
      expect(informalGroup('W', WILSON_DOWNLINE, new Set(['R', 'R1', 'N']))).toEqual(WILSON_DIRECT);
      // A leaver tagged brings nobody: the tag is on a membership that leads nobody now.
      const withLeaver = [...WILSON_DOWNLINE, LEAVER];
      expect(informalGroup('W', withLeaver, new Set(['Q']))).toEqual(directGroup('W', withLeaver));
    });

    it('P19.12-T6 AC-2 DIRECT ⊆ INFORMAL ⊆ DOWNLINE, whatever is tagged', () => {
      const tags = [[], ['G'], ['H'], ['G', 'H', 'Y', 'S3'], ['G1', 'R'], ['A1', 'S31']];
      for (const office of [false, true]) {
        const pool = office ? OFFICE : WILSON_DOWNLINE;
        const all = new Set(downline('W', pool, office));
        for (const t of tags) {
          const direct = directGroup('W', pool);
          const informal = new Set(informalGroup('W', pool, new Set(t)));
          expect(direct.every((id) => informal.has(id))).toBe(true);
          expect([...informal].every((id) => all.has(id))).toBe(true);
        }
      }
    });
  });

  describe('ABS_NOT_IN_INFORMAL_GROUP — “n AB di bawah Anda belum masuk grup”', () => {
    it('P19.12-T6 AC-4 counts the active ABs in the downline but the head, tagged into no live group of theirs', () => {
      expect(absNotInInformalGroup('W', WILSON_DOWNLINE, new Set())).toEqual(['S3', 'G', 'H', 'Y']);
      expect(absNotInInformalGroup('W', WILSON_DOWNLINE, new Set(['G']))).toEqual(['S3', 'H', 'Y']);
      // A tagged agent is no AB; a leaver AB is nobody's to tag.
      expect(absNotInInformalGroup('W', [...WILSON_DOWNLINE, LEAVER], new Set(['G1']))).toHaveLength(4);
      // Office-wide, the other root counts too.
      expect(absNotInInformalGroup('W', OFFICE, new Set(['G', 'H', 'Y', 'S3']))).toEqual(['R']);
    });
  });

  describe('the views offered, and the default (the client’s item 7)', () => {
    it('P19.12-T6 AC-2 a leader with an AB below: all three, Grup langsung first chosen', () => {
      expect(viewsOffered({ reader: 'leader', leadsSomebody: true, ownsLiveGroup: false, abBelow: 4 }))
        .toEqual({ offered: ['direct', 'informal', 'downline'], default: 'direct' });
    });

    it('P19.12-T6 AC-2 an AAB with no AB below: Grup langsung alone — Semua downline would be the same people', () => {
      expect(viewsOffered({ reader: 'leader', leadsSomebody: true, ownsLiveGroup: false, abBelow: 0 }))
        .toEqual({ offered: ['direct'], default: 'direct' });
      // Owning a group offers Grup informal.
      expect(viewsOffered({ reader: 'leader', leadsSomebody: true, ownsLiveGroup: true, abBelow: 0 }))
        .toEqual({ offered: ['direct', 'informal'], default: 'direct' });
    });

    it('P19.12-T6 AC-2 the Owner’s own dashboard: Semua downline, always offered, first chosen', () => {
      expect(viewsOffered({ reader: 'owner', leadsSomebody: true, ownsLiveGroup: true, abBelow: 4 }))
        .toEqual({ offered: ['direct', 'informal', 'downline'], default: 'downline' });
      expect(viewsOffered({ reader: 'owner', leadsSomebody: false, ownsLiveGroup: false, abBelow: 0 }))
        .toEqual({ offered: ['downline'], default: 'downline' });
    });

    it('P19.12-T6 AC-2 an Admin: Grup langsung while they lead somebody, else Semua downline', () => {
      expect(viewsOffered({ reader: 'admin', leadsSomebody: true, ownsLiveGroup: false, abBelow: 2 }))
        .toEqual({ offered: ['direct', 'informal', 'downline'], default: 'direct' });
      expect(viewsOffered({ reader: 'admin', leadsSomebody: false, ownsLiveGroup: false, abBelow: 2 }))
        .toEqual({ offered: ['informal', 'downline'], default: 'downline' });
    });

    it('P19.12-T6 AC-2 a head who leads nobody is offered nothing, and the default stands over an empty unit', () => {
      expect(viewsOffered({ reader: 'leader', leadsSomebody: false, ownsLiveGroup: false, abBelow: 0 }))
        .toEqual({ offered: [], default: 'direct' });
      // A default not offered gives way to the first that is.
      expect(viewsOffered({ reader: 'leader', leadsSomebody: false, ownsLiveGroup: true, abBelow: 0 }))
        .toEqual({ offered: ['informal'], default: 'informal' });
    });

    it('P19.12-T6 AC-2 a view asked for is answered while offered; any other falls back to the default', () => {
      const views = viewsOffered({ reader: 'leader', leadsSomebody: true, ownsLiveGroup: false, abBelow: 0 });
      expect(viewChosen(undefined, views)).toBe('direct');
      expect(viewChosen('downline', views)).toBe('direct');
      expect(viewChosen('direct', views)).toBe('direct');
      const all = viewsOffered({ reader: 'leader', leadsSomebody: true, ownsLiveGroup: false, abBelow: 1 });
      expect(viewChosen('informal', all)).toBe('informal');
    });
  });

  describe('placing a view’s people on the roster', () => {
    it('P19.12-T6 AC-2 a tagged AB under an untagged one hangs from the head, as a unit of their own', () => {
      const ids = informalGroup('W', WILSON_DOWNLINE, new Set(['H']));
      const placed = placeView('W', WILSON_DOWNLINE, ids, { unled: false });
      expect(placed.parentOf.get('H')).toBe('W');
      expect(placed.parentOf.get('H1')).toBe('H');
      expect([...placed.attached]).toEqual(['H']);
      expect(placed.depth.get('H')).toBe(1);
      expect(placed.depth.get('H1')).toBe(2);
      expect(placed.depth.get('S21')).toBe(3);
    });

    it('P19.12-T6 AC-2 office-wide: a second root is a unit; somebody with no leader who leads nobody is under Belum punya leader', () => {
      const ids = downline('W', OFFICE, true);
      const placed = placeView('W', OFFICE, ids, { unled: true });
      expect(placed.parentOf.get('R')).toBe('W');
      expect(placed.attached.has('R')).toBe(true);
      expect(placed.parentOf.get('R1')).toBe('R');
      expect(placed.parentOf.get('N')).toBeNull();
      expect(placed.depth.get('N')).toBe(1);
      // Without the office-wide list, nobody is unled: N hangs from the head.
      expect(placeView('W', OFFICE, ids, { unled: false }).parentOf.get('N')).toBe('W');
    });

    it('P19.12-T6 AC-1 in Grup langsung and a leader’s Semua downline nobody is hung from the head', () => {
      for (const ids of [directGroup('W', WILSON_DOWNLINE), downline('W', WILSON_DOWNLINE, false)]) {
        expect(placeView('W', WILSON_DOWNLINE, ids, { unled: false }).attached.size).toBe(0);
      }
    });
  });
});
