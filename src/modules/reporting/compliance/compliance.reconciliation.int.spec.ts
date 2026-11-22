import type { RequestContext } from '@/common/context/request-context';
import type { NewHireDetailView } from '@/modules/activation/activation-progress.view';
import type { TrainingProgressView } from '@/modules/training/training-progress.view';
import {
  LISTED, seedTreeRecords, startComplianceHarness, stopComplianceHarness, type ComplianceHarness, type ComplianceWho,
} from '../../../../test/compliance-office';
import type { ComplianceView } from './compliance.service';

/**
 * **Exit tests 1 and 4: every chip and every status equals what the screen that owns the fact says** (P18.3-T1 AC-4
 * to AC-7, AC-12; invariant §8). For one office, per category, against the owning surface's own read:
 *
 * - **training** — the Owner's and a coach's *Training* tab (`GET /training/progress?for=`) and the learner's own,
 *   module by module, after each kind of write (*Done*, *In progress*, back to *Not started*);
 * - **goals** — the members who saved a goal for the year above zero, over the Overview's people (P19.19);
 * - **activity** — the Overview's people whose latest day logged is within the last 7 days (P19.19: its usage's days);
 * - **activation** — the leader's *Your New Hires* roster and each hire's detail (`GET /new-hires/:membershipId`).
 *
 * The one unplaced member, Oscar, has a goal set, logged this week, every module done and a graduated activation. *Since
 * P19.19 (ADR-0272 §6)* the cards count him, as the Overview does: he sits under *Tanpa group*.
 */
describe('the compliance tree against the surfaces that own each fact (P18.3-T1, exit tests 1 and 4)', () => {
  let h: ComplianceHarness;
  const read = (ctx: RequestContext, query: { category?: 'training' | 'goals' | 'activity' | 'activation'; item?: string }) =>
    h.compliance.read(ctx, query);
  /** *Since P19.19-T3 (ADR-0272 §6):* the opened card's cells, keyed by membership — the Overview's tree draws the rows. */
  const rows = (view: ComplianceView) => view.selected!.cells.map(({ membershipId, ...cell }) => ({ membershipId, cell }));
  const cellOf = (view: ComplianceView, who: ComplianceWho) => rows(view).find((r) => r.membershipId === h.id(who))!.cell;
  const chip = (view: ComplianceView, category: string) => {
    const { count, of } = view.cards.find((c) => c.category === category)!;
    return { category, count, of };
  };
  /** A module's status as a *Training* tab draws it. */
  const statusIn = (view: TrainingProgressView, code: string) => view.categories
    .flatMap((c) => c.skills.flatMap((s) => s.modules)).find((m) => m.code === code)!.status;

  beforeAll(async () => {
    h = await startComplianceHarness();
    await seedTreeRecords(h);
  }, 180_000);

  afterAll(() => stopComplianceHarness(h));

  it('P19.19-T3 AC-2 the cards count exactly the Overview’s people, Oscar under Tanpa group included', async () => {
    const owner = h.ctx('OWNER');
    const overview = await h.wired.kpmOverview.read(owner);
    const view = await read(owner, { category: 'goals' });
    expect(overview.usage.total.of).toBe(17);
    expect(view.selected!.cells.map((c) => c.membershipId)).toEqual(overview.people.map((p) => p.membershipId));
    expect(chip(view, 'goals').of).toBe(overview.usage.total.of);
  });

  describe('P18.3-T1 AC-4 — training, against the Training tab', () => {
    it('P18.3-T1 AC-4 every listed member’s status on every offered module equals the Owner’s read of their Training tab', async () => {
      const owner = h.ctx('OWNER');
      const tabs = new Map<ComplianceWho, TrainingProgressView>();
      for (const who of LISTED) tabs.set(who, await h.wired.trainingProgress.progress(owner, h.id(who)));
      for (const code of h.sales) {
        const view = await read(owner, { category: 'training', item: code });
        for (const who of LISTED) {
          expect([code, who, cellOf(view, who).status]).toEqual([code, who, statusIn(tabs.get(who)!, code)]);
        }
      }
      // The chip (P19.3-T3 AC-9, UI-093): the members done on the module shown, as each one's tab says it.
      for (const code of h.sales) {
        const view = await read(owner, { category: 'training', item: code });
        // Oscar, under *Tanpa group* since P19.19, has every module done: the card counts him with the listed.
        expect([code, chip(view, 'training').count]).toEqual([code, LISTED.filter((who) => statusIn(tabs.get(who)!, code) === 'done').length + 1]);
      }
    });

    it('P18.3-T1 AC-4 exit test 4: after each kind of write, the tree, the learner’s own read and the coach’s tab agree', async () => {
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

  describe('P18.3-T1 AC-5 — goals', () => {
    it('P18.3-T1 AC-5, P19.19-T3 AC-2 the card: Indah, Dimas, Rina and Oscar hold a goal; Sari’s targets nothing (OD-160)', async () => {
      const goals = chip(await read(h.ctx('OWNER'), { category: 'goals' }), 'goals');
      expect(goals).toEqual({ category: 'goals', count: 4, of: 17 });
    });
  });

  describe('P18.3-T1 AC-6 — activity, against the Overview', () => {
    it('P18.3-T1 AC-6, P19.19-T4 AC-3 the card is the Overview’s people whose latest day logged is within 7 days; each row the same', async () => {
      const owner = h.ctx('OWNER');
      const overview = await h.wired.kpmOverview.read(owner);
      const view = await read(owner, { category: 'activity' });
      const week = overview.people.filter((p) => p.usage.days !== null && p.usage.days < 7).map((p) => p.membershipId);
      expect(chip(view, 'activity')).toEqual({ category: 'activity', count: week.length, of: 17 });
      expect(rows(view).filter((r) => r.cell.status === 'logged').map((r) => r.membershipId).sort()).toEqual([...week].sort());
    });
  });

  describe('P18.3-T1 AC-7 — activation, against the roster and the detail', () => {
    it('P18.3-T1 AC-7 each hire’s status equals their detail’s, read by a leader who coaches them', async () => {
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
        // Inside the first year, so the full view (P19.9-T3 AC-5).
        const detail = await h.wired.newHires.detail(h.ctx(coach), h.id(who)) as NewHireDetailView;
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

    it('P18.3-T1 AC-7 every hire on a leader’s roster reads Overdue in the tree exactly when the roster’s checklist is', async () => {
      const view = await read(h.ctx('OWNER'), { category: 'activation' });
      const roster = await h.wired.newHires.roster(h.ctx('AGUS'));
      // P18.8-T6: the roster lists the year's new hires by 3M result, each with their checklist's state and overdue.
      const hires = [...roster.sections.inProgress, ...roster.sections.activated, ...roster.sections.notActivated]
        .filter((r) => r.checklist !== null);
      expect(hires.map((r) => r.hire.membershipId)).toEqual(expect.arrayContaining([h.id('BUDI'), h.id('RINA')]));
      const DRAWN: Record<string, string> = {
        'graduated|false': 'completed', 'open|false': 'in_progress', 'open|true': 'overdue', 'expired|false': 'overdue',
      };
      for (const row of hires) {
        const cell = rows(view).find((r) => r.membershipId === row.hire.membershipId)!.cell;
        expect([row.hire.name, cell.status]).toEqual([row.hire.name, DRAWN[`${row.checklist!.state}|${row.checklist!.overdue}`]]);
      }
    });
  });
});
