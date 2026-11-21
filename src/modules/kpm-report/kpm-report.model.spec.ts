import { KPM_REPORT } from '@/domain/constants';
import type { OverviewTreeRow } from '@/modules/reporting/overview-tree';
import { person } from '../../../test/kpm-report-fixture';
import {
  kehadiranMark, deltaOf, deltaText, deltaTone, inReportOrder, pctOf, printedName, reportGroups, toneOf, type ReportPerson,
} from './kpm-report.model';
import { REPORT_ACTIONS, WEEK_ACTIONS, monthLong, periodLabel } from './kpm-report.words';

/** **P19.24-T1 AC-2 — §11's rules as functions** (ADR-0280 §4): the scale, the arrows, the order, the marks. */
describe('P19.24-T1 the KPM report’s rules', () => {
  it('P19.24-T1 AC-2 one colour scale: green from 80%, yellow 50–79%, red below 50% (the console’s)', () => {
    expect([100, 80, 79, 50, 49, 0].map(toneOf)).toEqual(['green', 'green', 'yellow', 'yellow', 'red', 'red']);
    expect(toneOf(null)).toBeNull();
  });

  it('P19.24-T1 AC-2 a share is a whole percentage, half up, and none over nobody', () => {
    expect(pctOf(1, 8)).toBe(13);
    expect(pctOf(2, 3)).toBe(67);
    expect(pctOf(0, 0)).toBeNull();
  });

  it('P19.24-T1 AC-2 ▲ / ▼ vs last month: a count’s difference, a share’s in points, nothing when a side is missing', () => {
    expect(deltaText(deltaOf(10, 8), 'Sep')).toBe('▲ 2 vs Sep');
    expect(deltaText(deltaOf(7, 8), 'Sep')).toBe('▼ 1 vs Sep');
    expect(deltaText(deltaOf(59, 53, 'points'), 'Sep')).toBe('▲ 6 poin vs Sep');
    expect(deltaText(deltaOf(5, 5), 'Sep')).toBe('= 0 vs Sep');
    expect(deltaText(deltaOf(null, 5), 'Sep')).toBeNull();
    // The colour says whether the change is good: fewer people without activity is good.
    expect(deltaTone(deltaOf(3, 1))).toBe('up');
    expect(deltaTone(deltaOf(3, 1), false)).toBe('down');
    expect(deltaTone(deltaOf(1, 1))).toBeNull();
  });

  it('P19.24-T1 AC-2 prints a name in CAPITALS', () => {
    expect(printedName(' Agus Prasetyo ')).toBe('AGUS PRASETYO');
  });

  it('P19.24-T1 AC-2 orders informal group → AB group → AB unit → each AAB unit → person, nobody added or dropped', () => {
    const [ab, aab1, a1, a2, aab2, b1, direct] = [
      person('AB', 'ab'), person('AAB ONE', 'aab'), person('A1', 'agent'), person('A2', 'agent'), person('AAB TWO', 'aab'),
      person('B1', 'agent'), person('DIRECT', 'agent'),
    ];
    const row = (p: ReportPerson, depth: 0 | 1 | 2): OverviewTreeRow => ({
      membershipId: p.membershipId, role: p.role, groupId: 'g', abMembershipId: ab.membershipId, depth, leaderIds: [],
    });
    // `overviewTree`'s order: the AB, each AAB with their agents, then the AB's own agents.
    const rows = [row(ab, 0), row(aab1, 1), row(a1, 2), row(a2, 2), row(aab2, 1), row(b1, 2), row(direct, 1)];
    const all = new Map([ab, aab1, a1, a2, aab2, b1, direct].map((p) => [p.membershipId, p]));
    const groups = reportGroups([{ groupId: 'g', name: 'Top', memberIds: rows.map((r) => r.membershipId) }], rows, (id) => all.get(id)!);
    const units = groups[0].abGroups[0].units;
    expect(units.map((u) => [u.role, u.people.map((p) => p.name)])).toEqual([
      ['ab', ['AB', 'DIRECT']],
      ['aab', ['AAB ONE', 'A1', 'A2']],
      ['aab', ['AAB TWO', 'B1']],
    ]);
    expect(inReportOrder(groups)).toHaveLength(rows.length);
  });

  it('P19.24-T1 AC-2 places somebody under no AB in a block of their own', () => {
    const lone = person('LONE', 'agent');
    const groups = reportGroups(
      [{ groupId: null, name: null, memberIds: [lone.membershipId] }],
      [{ membershipId: lone.membershipId, role: 'agent', groupId: null, abMembershipId: null, depth: 0, leaderIds: [] }],
      () => lone,
    );
    expect(groups[0].abGroups).toEqual([{ ab: null, units: [{ headId: lone.membershipId, role: 'ab', people: [lone] }] }]);
  });

  it('P19.24-T1 AC-2 HADIR only when Kehadiran marks it so; absent, not recorded yet, or not expected', () => {
    expect(['1', '0', '?', '.', undefined].map(kehadiranMark)).toEqual(['attended', 'absent', 'waiting', null, null]);
  });

  it('P19.24-T1 AC-2 the actions read each person’s own facts, and none is about training', () => {
    expect(REPORT_ACTIONS.map((a) => a.label).join(' ')).not.toMatch(/training|pelatihan/i);
    const fine = person('FINE', 'agent', { compliance: { goals: true, activity: true, leads: true, activation: null, events: true, campaigns: true }, qualIssues: 0 });
    expect(REPORT_ACTIONS.filter((a) => a.applies(fine))).toEqual([]);
    const many = person('MANY', 'agent', { qualIssues: KPM_REPORT.QUAL_MANY_ISSUES });
    expect(REPORT_ACTIONS.find((a) => a.key === 'qual')!.applies(many)).toBe(true);
    expect(WEEK_ACTIONS).toHaveLength(3);
  });

  it('P19.24-T1 AC-2 writes the month in full and a survey’s period as its tab does', () => {
    expect(monthLong('2026-10')).toBe('Oktober 2026');
    expect(periodLabel('2026-Q3')).toBe('Q3 2026');
    expect(periodLabel('2026-06')).toBe('Juni 2026');
  });
});
