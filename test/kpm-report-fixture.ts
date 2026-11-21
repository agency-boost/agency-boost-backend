import {
  inReportOrder, reportGroups, type KpmReportModel, type ReportPerson, type ReportRole,
} from '@/modules/kpm-report/kpm-report.model';
import type { OverviewTreeRow } from '@/modules/reporting/overview-tree';

/**
 * **A KPM report's model, by hand** (P19.24-T1): the template's office in small — *BSD City Branch*, two informal groups
 * and *Tanpa group*, three AB groups, AAB units — so the layout and the builder are tested without a database. Every
 * figure is invented and says nothing about the demo seed; `kpm-report.demo.int.spec.ts` reads the seed itself.
 */
let seq = 0;
const id = () => `66f00000000000000000${String(++seq).padStart(4, '0')}`;

export function person(name: string, role: ReportRole, over: Partial<ReportPerson> = {}): ReportPerson {
  return {
    membershipId: id(),
    name,
    role,
    groupName: null,
    abId: null,
    unitHeadId: null,
    usage: { ever: true, recent14: true, days: 2, powerUser: false, usedInMonth: true },
    coaching: { status: 'recent', days: 5 },
    compliance: { goals: true, activity: true, leads: false, activation: null, events: true, campaigns: false },
    nps: true,
    activeAgent: false,
    potensi: false,
    goalMinor: 120_000_000_00,
    ytdMinor: 60_000_000_00,
    activities: 12,
    leads: { sales: 3, recruit: 1 },
    qualIssues: 2,
    attendance: {},
    ...over,
  };
}

/** The tree as `overviewTree` draws it: AB (depth 0), each AAB (1) with their agents (2), then the AB's own agents (1). */
function treeOf(spec: { group: string | null; abs: { ab: ReportPerson; aabs: { aab: ReportPerson; agents: ReportPerson[] }[]; agents: ReportPerson[] }[] }[]) {
  const rows: OverviewTreeRow[] = [];
  const groups = spec.map((g, gi) => {
    const groupId = g.group === null ? null : `g${gi}`;
    const memberIds: string[] = [];
    for (const { ab, aabs, agents } of g.abs) {
      const push = (p: ReportPerson, depth: 0 | 1 | 2, role: 'ab' | 'aab' | 'agent') => {
        memberIds.push(p.membershipId);
        rows.push({ membershipId: p.membershipId, role, groupId, abMembershipId: ab.membershipId, depth, leaderIds: [] });
      };
      push(ab, 0, 'ab');
      for (const { aab, agents: under } of aabs) {
        push(aab, 1, 'aab');
        for (const a of under) push(a, 2, 'agent');
      }
      for (const a of agents) push(a, 1, 'agent');
    }
    return { groupId, name: g.group, memberIds };
  });
  return { groups, rows };
}

export const AGUS = person('AGUS PRASETYO', 'ab', { usage: { ever: true, recent14: true, days: 0, powerUser: true, usedInMonth: true }, activeAgent: true });
export const SARI = person('SARI PUSPITA', 'aab', { usage: { ever: true, recent14: true, days: 1, powerUser: true, usedInMonth: true } });
export const RINA = person('RINA WIJAYA', 'agent', { activeAgent: true });
export const BUDI = person('BUDI SANTOSO', 'agent', {
  usage: { ever: true, recent14: false, days: 31, powerUser: false, usedInMonth: false },
  coaching: { status: 'never', days: null }, compliance: { goals: false, activity: false, leads: false, activation: false, events: false, campaigns: false },
  nps: false, potensi: true, goalMinor: null, ytdMinor: null, activities: 0, qualIssues: 9,
});
export const PUTRI = person('PUTRI ANGGRAINI', 'agent', {
  usage: { ever: false, recent14: false, days: null, powerUser: false, usedInMonth: false }, coaching: { status: 'never', days: null }, nps: false,
});
export const INDAH = person('INDAH PERMATASARI', 'agent', { coaching: { status: 'lapsed', days: 22 }, potensi: true });
export const YOSEF = person('YOSEF TAMBUNAN', 'ab', { coaching: { status: 'never', days: null } });
export const WINDA = person('WINDA ANGGRAENI', 'aab');
export const JIHAN = person('JIHAN MARDIYAH', 'agent', { potensi: true });
export const ARINI = person('ARINI KUSUMA', 'agent', { usage: { ever: true, recent14: true, days: 2, powerUser: true, usedInMonth: true } });
export const SATRIA = person('SATRIA NUGRAHA', 'ab', { activeAgent: true });
export const OSCAR = person('OSCAR LUMBANTOBING', 'agent');

/** The office: *Top Producers 2026* (Agus), *New Agent Mentoring Circle* (Satria), *Tanpa group* (Yosef). */
export function reportModel(over: Partial<KpmReportModel> = {}): KpmReportModel {
  const tree = treeOf([
    { group: 'New Agent Mentoring Circle', abs: [{ ab: SATRIA, aabs: [], agents: [OSCAR] }] },
    { group: 'Top Producers 2026', abs: [{ ab: AGUS, aabs: [{ aab: SARI, agents: [BUDI, PUTRI, RINA] }], agents: [INDAH] }] },
    { group: null, abs: [{ ab: YOSEF, aabs: [{ aab: WINDA, agents: [JIHAN] }], agents: [ARINI] }] },
  ]);
  const byId = new Map([AGUS, SARI, RINA, BUDI, PUTRI, INDAH, YOSEF, WINDA, JIHAN, ARINI, SATRIA, OSCAR].map((p) => [p.membershipId, p]));
  const groups = reportGroups(tree.groups, tree.rows, (pid) => byId.get(pid)!);
  for (const g of groups) {
    for (const ab of g.abGroups) {
      for (const unit of ab.units) for (const p of unit.people) Object.assign(p, { unitHeadId: unit.headId, abId: ab.ab?.membershipId ?? null, groupName: g.name });
    }
  }
  const people = inReportOrder(groups);
  for (const p of people) p.attendance = { ev1: p === BUDI ? 'absent' : p === PUTRI ? null : 'attended', ev2: p === PUTRI ? null : 'waiting' };
  const line = (ab: ReportPerson, groupName: string | null, apeMinor: number, apePct: number) => ({
    abId: ab.membershipId, label: ab.name, groupName, apeMinor, apePct,
    activeAgents: { value: 1, target: 2 }, rekrutYtd: { value: 1, target: 2 },
  });
  return {
    office: { kpmId: '66f0000000000000000000a1', name: 'BSD City Branch', company: 'Prudential', code: '0417', ownerName: 'Wilson Tanoto' },
    month: '2026-10',
    asOf: '2026-10-31',
    comparedWith: '2026-09-30',
    madeOn: '2026-11-20',
    groups,
    people,
    members: { total: people.length, leaders: people.filter((p) => p.role !== 'agent').length, agents: people.filter((p) => p.role === 'agent').length },
    newMembers: 2,
    funnel: {
      everUsed: { count: 11, pct: 92, previousCount: 9, previousPct: 75 },
      used14: { count: 9, pct: 75, previousCount: 8, previousPct: 67 },
      powerUsers: { count: 3, pct: 25, previousCount: 3, previousPct: 25 },
    },
    performance: {
      held: true,
      rows: [line(SATRIA, 'New Agent Mentoring Circle', 52_300_000_00, 58), line(AGUS, 'Top Producers 2026', 241_200_000_00, 80), line(YOSEF, null, 135_000_000_00, 119)],
      total: { abId: null, label: 'Total KPM', groupName: null, apeMinor: 428_500_000_00, apePct: 87, activeAgents: { value: 3, target: 6 }, rekrutYtd: { value: 3, target: 6 } },
      aboveTarget: 1,
    },
    activity: { total: 144, previousTotal: 128, leadsSales: 36, leadsRecruit: 12, previousLeads: 40, withoutActivity: 2, previousWithout: 1 },
    activeAgents: {
      held: true, count: 3, target: 6, previousCount: 2, potensi: 3, previousPotensi: 4,
      recruitsMonth: 1, previousRecruitsMonth: 0, recruitsMonthTarget: 2, recruitsYtd: 3, recruitsYtdTarget: 6,
      recruits: [{ name: 'JIHAN MARDIYAH', recruiter: { name: 'WINDA ANGGRAENI', role: 'aab' }, joinDate: '2026-08-12' }],
    },
    compliance: [
      { key: 'goals', done: 10, of: 12 }, { key: 'activity', done: 8, of: 12 }, { key: 'leads', done: 4, of: 12 },
      { key: 'activation', done: 0, of: 2 }, { key: 'events', done: 9, of: 11 }, { key: 'campaigns', done: 5, of: 12 },
      { key: 'coaching', done: 8, of: 12 }, { key: 'nps', done: 10, of: 12 },
    ],
    npsPeriod: '2026-Q3',
    appendix: {
      demographics: {
        manpower: 12, complete: 7, incomplete: 5, completePct: 58,
        role: [{ key: 'AB', count: 3, label: 'AB' }, { key: 'AAB', count: 2, label: 'AAB' }, { key: 'AGENT', count: 7, label: 'Agent' }],
        workStatus: [{ key: 'full_time', count: 6 }, { key: 'part_time', count: 3 }, { key: 'unset', count: 3 }],
        tenureBand: [{ key: '0', count: 5, from: null, to: 3 }, { key: '3', count: 4, from: 3, to: 7 }, { key: 'unset', count: 3 }],
        ageBand: [{ key: 'gen_z', count: 2, from: 18, to: 29 }, { key: 'gen_y', count: 7, from: 30, to: 45 }, { key: 'unset', count: 3 }],
        gender: [{ key: 'male', count: 6 }, { key: 'female', count: 6 }],
        missing: new Map([[BUDI.membershipId, ['dateOfBirth', 'workStatus']], [PUTRI.membershipId, ['joinDate']]]),
      },
      mapa: {
        headline: { ape: { value: 428_500_000_00, target: 600_000_000_00 }, activeAgent: { value: 3, target: 6 }, rekrut: { value: 1, target: 2 } },
        rows: [
          { key: 'ape', unit: 'idr_minor', ytdLastYear: 1_630_000_000_00, ytd: 2_195_000_000_00, sameMonthLastYear: 158_000_000_00, thisMonth: 428_500_000_00, target: 600_000_000_00 },
          { key: 'manpower', unit: 'count', ytdLastYear: 33, ytd: 30, sameMonthLastYear: 33, thisMonth: 30, target: null },
          { key: 'new_agent_3m', unit: 'percentage', ytdLastYear: 30, ytd: 36, sameMonthLastYear: 29, thisMonth: 25, target: null },
        ],
      },
      nps: {
        period: '2026-Q3', sent: 10, invited: 12, leaders: 4, agents: 6,
        lines: [
          { text: 'Keseluruhan KPM', score: 62, change: 5, shares: { promoterPct: 69, passivePct: 24, detractorPct: 7 }, reasons: [] },
          { text: 'Visi jelas & menginspirasi', score: 35, change: -2, shares: { promoterPct: 53, passivePct: 29, detractorPct: 18 }, reasons: [{ text: 'Visi hanya slogan, belum diturunkan oleh leader.', who: 'agent' }] },
        ],
      },
      quant: {
        fromMonth: '2026-01', periodEnd: '2026-06',
        metrics: [
          { code: 'A1', value: 1.2, median: 1, previous: 1, status: 'above', percent: false },
          { code: 'B1', value: 36, median: 31, previous: 30, status: 'below', percent: true },
        ],
      },
      qual: {
        period: '2026-06', respondents: 9, invited: 12,
        blocks: [{ title: 'A. Penjualan', respondents: 9, rows: [{ label: 'Penjadwalan janji temu', issuePct: 57, previousPct: 59 }] }],
        people: new Map([[BUDI.membershipId, { answered: true, issues: 9 }], [PUTRI.membershipId, { answered: false, issues: null }]]),
      },
      informal: {
        groups: [{ name: 'Top Producers 2026', rows: [{ abId: AGUS.membershipId, label: 'AGUS PRASETYO', people: 6, maa: { value: 2, target: 4 }, usagePct: 80, oneOnOne: { value: 1.5, target: 8 }, rekrut: { value: 1, target: 3 } }] }],
      },
      events: {
        summaryPct: 64,
        list: [
          { id: 'ev1', title: 'Closing Clinic', startsOn: '2026-10-21', attended: 7, audience: 11, pct: 64, nps: 20, answers: 6 },
          { id: 'ev2', title: 'PRULink briefing', startsOn: '2026-10-07', attended: null, audience: null, pct: null, nps: null, answers: 0 },
        ],
      },
    },
    ...over,
  };
}
