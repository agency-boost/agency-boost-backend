import type { RequestContext } from '@/common/context/request-context';
import type { TrainingProgressView } from '@/modules/training/training-progress.view';
import {
  LISTED, seedTreeRecords, startComplianceHarness, stopComplianceHarness, type ComplianceHarness, type ComplianceWho,
} from '../../../../test/compliance-office';
import type { ComplianceView } from './compliance.service';

/**
 * **Exit tests 1 and 4: every chip and every status equals what the screen that owns the fact says** (P18.6-T1 AC-4
 * to AC-7, AC-12; invariant §8). For one office, per category, against the owning surface's own read:
 *
 * - **training** — the Owner's and a coach's *Training* tab (`GET /training/progress?for=`) and the learner's own,
 *   module by module, after each kind of write (*Done*, *In progress*, back to *Not started*);
 * - **goals** — the Overview's headcount less its `membersWithoutGoal`, less the members the tree places nowhere;
 * - **activity** — the Overview's `loggedThisWeek.logged`, less the members the tree places nowhere;
 * - **activation** — the leader's *Your New Hires* roster and each hire's detail (`GET /new-hires/:membershipId`).
 *
 * The one unplaced member, Oscar, has a goal set, logged this week, every module done and a graduated activation:
 * the Overview counts him and the tree does not, which is the difference each test names.
 */
describe('the compliance tree against the surfaces that own each fact (P18.6-T1, exit tests 1 and 4)', () => {
  let h: ComplianceHarness;
  const read = (ctx: RequestContext, query: { category?: 'training' | 'goals' | 'activity' | 'activation'; item?: string }) =>
    h.compliance.read(ctx, query);
  const rows = (view: ComplianceView) => view.tree.flatMap((s) => s.units.flatMap((u) => u.rows));
  const cellOf = (view: ComplianceView, who: ComplianceWho) => rows(view).find((r) => r.membershipId === h.id(who))!.cell;
  const chip = (view: ComplianceView, category: string) => view.summary.find((c) => c.category === category)!;
  /** A module's status as a *Training* tab draws it. */
  const statusIn = (view: TrainingProgressView, code: string) => view.categories
    .flatMap((c) => c.skills.flatMap((s) => s.modules)).find((m) => m.code === code)!.status;

  beforeAll(async () => {
    h = await startComplianceHarness();
    await seedTreeRecords(h);
  }, 180_000);

  afterAll(() => stopComplianceHarness(h));

  it('P18.6-T1 AC-12 the tree leaves exactly the unplaced out of the Overview’s members', async () => {
    const owner = h.ctx('OWNER');
    const overview = await h.wired.kpmOverview.read(owner);
    const view = await read(owner, {});
    expect(overview.composition.total).toBe(17);
    expect(view.people).toBe(overview.composition.total - 1);
    expect(rows(view).map((r) => r.membershipId)).not.toContain(h.id('ORPHAN'));
  });

  describe('P18.6-T1 AC-4 — training, against the Training tab', () => {
    it('P18.6-T1 AC-4 every listed member’s status on every offered module equals the Owner’s read of their Training tab', async () => {
      const owner = h.ctx('OWNER');
      const tabs = new Map<ComplianceWho, TrainingProgressView>();
      for (const who of LISTED) tabs.set(who, await h.wired.trainingProgress.progress(owner, h.id(who)));
      for (const code of h.sales) {
        const view = await read(owner, { category: 'training', item: code });
        for (const who of LISTED) {
          expect([code, who, cellOf(view, who).status]).toEqual([code, who, statusIn(tabs.get(who)!, code)]);
        }
      }
      // The chip: every offered module done, as the tab's `allOfferedDone` says.
      const view = await read(owner, {});
      expect(chip(view, 'training').count).toBe(LISTED.filter((who) => tabs.get(who)!.allOfferedDone).length);
    });

    it('P18.6-T1 AC-4 exit test 4: after each kind of write, the tree, the learner’s own read and the coach’s tab agree', async () => {
      const owner = h.ctx('OWNER');
      const learner = h.ctx('NINA');
      const coach = h.ctx('SARI');
      const code = 'CLOSING_TECHNIQUES';
      for (const status of ['in_progress', 'done', 'not_started'] as const) {
        await h.wired.trainingProgress.setStatus(learner, code, status);
        const tree = cellOf(await read(owner, { category: 'training', item: code }), 'NINA').status;
        const own = statusIn(await h.wired.trainingProgress.progress(learner), code);
        const coached = statusIn(await h.wired.trainingProgress.progress(coach, h.id('NINA')), code);
        expect({ status, tree, own, coached }).toEqual({ status, tree: status, own: status, coached: status });
      }
    });
  });

  describe('P18.6-T1 AC-5 — goals, against the Overview', () => {
    it('P18.6-T1 AC-5 the chip is the Overview’s headcount less its members without a goal, less the unplaced', async () => {
      const owner = h.ctx('OWNER');
      const overview = await h.wired.kpmOverview.read(owner);
      const goals = chip(await read(owner, { category: 'goals' }), 'goals');
      const set = overview.composition.total - overview.production.ytd.membersWithoutGoal;
      // Oscar, unplaced, has a goal set: the Overview counts him, the tree does not.
      expect(goals).toEqual({ category: 'goals', count: set - 1, of: overview.composition.total - 1 });
      expect(goals.count).toBe(3);
    });

    it('P18.6-T1 AC-5 the Overview’s figure did not move when it was re-pointed at the one predicate (OD-160)', async () => {
      // Sari's goal targets nothing, so it is no goal, as it was before: the Overview counts her without one.
      const overview = await h.wired.kpmOverview.read(h.ctx('OWNER'));
      expect(overview.production.ytd.membersWithoutGoal).toBe(17 - 4);
    });
  });

  describe('P18.6-T1 AC-6 — activity, against the Overview', () => {
    it('P18.6-T1 AC-6 the chip is the Overview’s logged this week, less the unplaced; each row the same predicate', async () => {
      const owner = h.ctx('OWNER');
      const overview = await h.wired.kpmOverview.read(owner);
      const view = await read(owner, { category: 'activity' });
      // Oscar, unplaced, logged on the 12th.
      expect(chip(view, 'activity')).toEqual({
        category: 'activity', count: overview.engagement.loggedThisWeek.logged - 1, of: overview.composition.total - 1,
      });
      // The Overview's not-logged list counts the rest of the office as silent: the tree's *Missed*, with Oscar placed nowhere.
      const notLogged = await h.wired.kpmOverview.notLogged(owner);
      expect(rows(view).filter((r) => r.cell.status === 'missed')).toHaveLength(notLogged.total);
    });
  });

  describe('P18.6-T1 AC-7 — activation, against the roster and the detail', () => {
    it('P18.6-T1 AC-7 each hire’s status equals their detail’s, read by a leader who coaches them', async () => {
      const owner = h.ctx('OWNER');
      const view = await read(owner, { category: 'activation' });
      const coachOf: Partial<Record<ComplianceWho, ComplianceWho>> = {
        RINA: 'SARI', BUDI: 'SARI', DODI: 'NINA', TARI: 'LUKAS', PEER_AGENT: 'PEER_AAB',
      };
      /*
       * Exit review 3: what the tree must draw for what the detail says, written out — OD-159's table, not the function
       * under test. `state` and `overdue` are the detail's own fields.
       */
      const DRAWN: Record<string, string> = {
        'graduated|false': 'completed',
        'open|false': 'in_progress',
        'open|true': 'overdue',
        'expired|false': 'overdue',
      };
      const seen = new Set<string>();
      for (const [who, coach] of Object.entries(coachOf) as [ComplianceWho, ComplianceWho][]) {
        const detail = await h.wired.newHires.detail(h.ctx(coach), h.id(who));
        const key = `${detail.state}|${detail.overdue}`;
        seen.add(key);
        expect([who, cellOf(view, who)]).toEqual([who, {
          status: DRAWN[key],
          done: detail.state === 'graduated',
          on: detail.graduatedAt === null ? null : h.clock.localDateFor('Asia/Jakarta', new Date(detail.graduatedAt)),
          endedOn: detail.state === 'expired' ? detail.endsOn : null,
        }]);
      }
      // Every row of the table is exercised by the fixture: graduated, open, open and overdue, expired.
      expect([...seen].sort()).toEqual(Object.keys(DRAWN).sort());
      // Everybody else has none: the detail says so, and the tree draws *—*.
      for (const who of LISTED.filter((w) => !(w in coachOf))) {
        expect([who, cellOf(view, who).status]).toEqual([who, null]);
      }
    });

    it('P18.6-T1 AC-7 every hire on a leader’s roster reads Overdue in the tree exactly when the roster’s day is red', async () => {
      const view = await read(h.ctx('OWNER'), { category: 'activation' });
      const roster = await h.wired.newHires.roster(h.ctx('AGUS'));
      const hires = roster.groups.flatMap((g) => g.hires);
      expect(hires.map((r) => r.hire.membershipId).sort()).toEqual([h.id('BUDI'), h.id('RINA')].sort());
      for (const row of hires) {
        const cell = rows(view).find((r) => r.membershipId === row.hire.membershipId)!.cell;
        expect([row.hire.name, cell.status]).toEqual([row.hire.name, row.overdue ? 'overdue' : 'in_progress']);
      }
    });
  });
});
