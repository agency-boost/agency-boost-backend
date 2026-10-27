import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { endOfMonth } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE, type CampaignPosterColor } from '@/domain/constants';
import { addMonths, monthRangeWords } from '@/domain/metrics/campaign-window';
import { up as campaignKinds } from '@/migrations/0027-campaign-kinds';
import { seedObjectId } from './coaching-fixture';

/**
 * **Campaigns, as their chasers live them** (Phase 18.5, P18.5-T7 AC-11, P18.5-T8, P18.5-T9; the phase file's *Seed*):
 * 0417's seasonal and structural campaigns — running, upcoming and ended — and the chases across the coaching cast,
 * beside the two campaigns Phase 5 seeded. Every window counts from the run's month in Jakarta, in whole office months.
 * **No member, activity day, goal or production month is added**: every row is a campaign or a chase, which nothing
 * reviewed before this phase reads. The requirements' figures are **the office's own until the client gives theirs**
 * (OD-152 → option 3, ADR-0142): where a walk needs a figure to land on one side of a target — Rina's ✓ on the
 * sprint, one member over MDRT, Rina met and Budi not on the persistency push — the target is set from the office's
 * own file at seed time and printed.
 *
 * | Code | Kind and window (run in October: M = October) | Requirement | On the run's day |
 * |---|---|---|---|
 * | `APE_SPRINT` | seasonal; M−2 to M (the month before last is the office's empty one) | APE ≥ Rp X; New Hire ≥ Rina's + 1 | Running; Rina's dialog: APE ✓, New Hire *Not uploaded yet* |
 * | `NEW_HIRE_BLITZ` | seasonal; M | New Hire ≥ 3 | Running |
 * | `APE_CHALLENGE_NEXT` | seasonal; the next calendar quarter | APE ≥ Rp 300 jt | Upcoming, chaseable |
 * | `PERSISTENCY_PUSH` | seasonal; last month, locked from the 8th | persistency ≥ Rina's — or the first of APE, New Hire, new active agents and touches on which she is above Budi; the title says which | Ended; **final** on the first read: Rina qualified, Budi not met |
 * | `YEAR_END_DRIVE` | Phase 5's, its dates snapped to whole months, M−1 to M+1 | APE ≥ Rp 500 jt | Running |
 * | `RECRUIT_SPRINT` | Phase 5's | Recruitment success rate ≥ 0.3 | Ended |
 * | `PROMOTION_AGENT_AAB` | structural promotion; rolling 12 months; `AGENT` | APE ≥ Rp 1.200 jt; New active agents ≥ 3 | Never final |
 * | `PROMOTION_AAB_AB` | structural promotion; rolling 12 months; `AAB` | Active agents in unit ≥ 5; New Hire ≥ 6 | An agent sees it with the chase disabled |
 * | `MDRT_QUALIFICATION` | structural ongoing; calendar year | APE ≥ Rp Z for the year | One chaser over Z |
 * | `ARCHIVED_DRIVE` | archived | — | On no agent's list |
 * | 0555's `GADING_PUSH` | seasonal; M | APE ≥ Rp 50 jt | Isolation |
 *
 * Chases: Rina `APE_SPRINT`, `MDRT_QUALIFICATION` and `PERSISTENCY_PUSH`; Agus MDRT; Dimas MDRT and `APE_SPRINT`; Sari
 * `PROMOTION_AAB_AB`; Budi `PERSISTENCY_PUSH`, made while it ran (an ended chase is on no list, so his Summary is empty).
 *
 * **Derived ids, written once until `--reset`**: a campaign is written per code when the office has none of that code,
 * a chase per member and code when none is there — so a re-run writes nothing and a walk's own chases are kept.
 * Phase 5's two campaigns get the card's fields through migration `0027-campaign-kinds`, as every deployment does.
 */

export interface CampaignsFixtureDeps {
  clock: Clock;
  office0417: { kpmId: string; cast: Record<'rina' | 'budi' | 'agus' | 'dimas' | 'sari', string> };
  office0555: { kpmId: string };
}

export interface CampaignsFixture {
  /** Campaigns and chases this run wrote; 0 on a re-run. */
  written: number;
  /** The targets set from the office's own file, in sen (APE) or as they are. */
  targets: { sprintApe: number; sprintHires: number; mdrtApe: number; persistency: { metricKey: string; value: number; title: string } };
  guide: string;
}

const JT = 1_000_000 * 100;
const TZ = DEFAULT_TENANT_TIMEZONE;

interface SeedCampaign {
  code: string;
  title: string;
  description: string;
  kind: 'seasonal' | 'structural';
  subtype: 'promotion' | 'ongoing' | null;
  window: 'campaign_dates' | 'calendar_year' | 'rolling_12m';
  from: string;
  to: string | null;
  appliesToOrgLevelCodes: string[];
  poster: { emoji: string; color: CampaignPosterColor };
  blurb: string;
  reward: string;
  requirements: { metricKey: string; comparator: string; value: number; unit: string }[];
  status?: 'archived';
}

export async function seedCampaignsFixture(deps: CampaignsFixtureDeps): Promise<CampaignsFixture> {
  const db = mongoose.connection.db as mongoose.mongo.Db;
  const { clock } = deps;
  const now = clock.now();
  const kpmId = deps.office0417.kpmId;
  const cast = deps.office0417.cast;
  const today = clock.localDateFor(TZ);
  const M = today.slice(0, 7);
  /** 00:00 on the month's 1st, Jakarta. */
  const startOf = (month: string) => clock.startOfLocalDay(TZ, `${month}-01`);
  /** The month's last instant, Jakarta — 23:59:59.999 on its last day (`endsAt` is inclusive). */
  const endOf = (month: string) => new Date(clock.endOfLocalDay(TZ, endOfMonth(`${month}-01`)).getTime() - 1);
  let written = 0;

  // ---- Phase 5's two campaigns, given the card's fields as a deployment gives them (migration 0027).
  await campaignKinds(db, now);
  // `YEAR_END_DRIVE` snapped to whole office months (D-windows), while it is still the seed's own.
  await db.collection('campaigns').updateOne(
    { kpmId, code: 'YEAR_END_DRIVE', version: 1, createdBy: null, deletedAt: null, startsAt: { $ne: startOf(addMonths(M, -1)) } },
    { $set: { startsAt: startOf(addMonths(M, -1)), endsAt: endOf(addMonths(M, 1)), updatedAt: now } },
  );

  // ---- The office's own file, which three targets are set from (OD-152 → option 3).
  const months = await db.collection('monthlyAgentData').find({
    kpmId, deletedAt: null, membershipId: { $in: Object.values(cast) }, month: { $gte: `${M.slice(0, 4)}-01`, $lte: M },
  }).toArray();
  const cell = (who: string, month: string, field: string): number | null => {
    const row = months.find((r) => r.membershipId === who && r.month === month);
    return (row?.[field] as { value?: number | null } | undefined)?.value ?? null;
  };
  const sum = (who: string, from: string, to: string, field: string) => {
    let total = 0;
    for (let m = from; m <= to; m = addMonths(m, 1)) total += cell(who, m, field) ?? 0;
    return total;
  };
  const sprintFrom = addMonths(M, -2);
  const rinaSprintApe = sum(cast.rina, sprintFrom, M, 'apeMonthly');
  const sprintApe = Math.max(JT, Math.floor((0.8 * rinaSprintApe) / JT) * JT);
  const sprintHires = sum(cast.rina, sprintFrom, M, 'recruitmentMonthly') + 1;
  const ytd = (who: string) => {
    const held = months.filter((r) => r.membershipId === who && (r.apeYtd as { value?: number | null })?.value != null)
      .sort((a, b) => String(b.month).localeCompare(String(a.month)));
    return held.length > 0 ? (held[0].apeYtd as { value: number }).value : 0;
  };
  const topYtd = Math.max(ytd(cast.rina), ytd(cast.agus), ytd(cast.dimas));
  const mdrtApe = topYtd > 0 ? Math.floor(topYtd / JT) * JT : 2_400 * JT;
  /*
   * **The push's requirement, from last month's file** — persistency first, as the prototype's *Mid-Year Persistency
   * Push* asks (`Overall.html:7961`); then APE, New Hire, new active agents, and the goal's touches logged that month —
   * the first on which Rina's figure is above Budi's, at Rina's figure, so she is met and he is not. The prototype's
   * *90%* if none separates them, and the guide says what the run chose.
   */
  const last = addMonths(M, -1);
  const touches = async (who: string) => {
    const days = await db.collection('activityLogs').find({
      kpmId, membershipId: who, deletedAt: null, localDate: { $gte: `${last}-01`, $lte: endOfMonth(`${last}-01`) },
    }).toArray();
    return days.flatMap((d) => (d.entries ?? []) as { activityTypeCode: string; count: number }[])
      .filter((e) => ['LEADS_CONTACTED', 'SELL_PRESENTATION', 'SELL_SUBMISSION'].includes(e.activityTypeCode))
      .reduce((t, e) => t + e.count, 0);
  };
  const candidates: { metricKey: string; unit: string; title: string; rina: number | null; budi: number | null }[] = [
    { metricKey: 'ROLLING_PERSISTENCY', unit: 'percentage', title: 'Persistency Push', rina: cell(cast.rina, last, 'persistencyMonthly'), budi: cell(cast.budi, last, 'persistencyMonthly') },
    { metricKey: 'APE_ACHIEVED', unit: 'idr_minor', title: 'APE Push', rina: cell(cast.rina, last, 'apeMonthly'), budi: cell(cast.budi, last, 'apeMonthly') },
    { metricKey: 'NEW_HIRES', unit: 'count', title: 'New Hire Push', rina: cell(cast.rina, last, 'recruitmentMonthly'), budi: cell(cast.budi, last, 'recruitmentMonthly') },
    { metricKey: 'NEW_ACTIVE_AGENTS', unit: 'count', title: 'New Agent Push', rina: cell(cast.rina, last, 'newActiveAgentsMonthly'), budi: cell(cast.budi, last, 'newActiveAgentsMonthly') },
    { metricKey: 'CASCADE_ACTIVITY_TOUCHES', unit: 'count', title: 'Touches Push', rina: await touches(cast.rina), budi: await touches(cast.budi) },
  ];
  const chosen = candidates.find((c) => c.rina !== null && c.rina > 0 && (c.budi === null || c.rina > c.budi));
  const persistency = chosen
    ? { metricKey: chosen.metricKey, value: chosen.rina as number, unit: chosen.unit, title: chosen.title }
    : { metricKey: 'ROLLING_PERSISTENCY', value: 90, unit: 'percentage', title: 'Persistency Push' };

  // ---- The campaigns.
  const quarterStart = addMonths(`${M.slice(0, 4)}-01`, Math.floor((Number(M.slice(5)) - 1) / 3) * 3 + 3);
  const quarter = `Q${Math.floor((Number(quarterStart.slice(5)) - 1) / 3) + 1} ${quarterStart.slice(0, 4)}`;
  const shortMonth = (month: string) => monthRangeWords(month, month).split(' ')[0];
  const ape = (value: number) => ({ metricKey: 'APE_ACHIEVED', comparator: 'gte', value, unit: 'idr_minor' });
  const count = (metricKey: string, value: number) => ({ metricKey, comparator: 'gte', value, unit: 'count' });
  const seasonal = { kind: 'seasonal' as const, subtype: null, window: 'campaign_dates' as const, appliesToOrgLevelCodes: [] };
  const CAMPAIGNS0417: SeedCampaign[] = [
    {
      ...seasonal, code: 'APE_SPRINT', title: `${shortMonth(sprintFrom)}–${shortMonth(M)} APE Sprint`, from: sprintFrom, to: M,
      description: 'Ranked by APE booked over the three months. Everybody who clears the APE target with at least the '
        + 'new hires asked for earns the cash bonus.',
      poster: { emoji: '🚀', color: 'amber' }, blurb: 'Push for APE this quarter — top 10 unit-wide win a trip.',
      reward: 'Top 10 unit-wide: a two-night trip · Every qualifier: a cash bonus',
      requirements: [ape(sprintApe), count('NEW_HIRES', sprintHires)],
    },
    {
      ...seasonal, code: 'NEW_HIRE_BLITZ', title: 'New Hire Blitz', from: M, to: M,
      description: 'A one-month recruitment blitz: three confirmed, licensed hires within the month earn a cash bonus.',
      poster: { emoji: '🧲', color: 'navy-soft' }, blurb: 'Recruit fast — three confirmed hires this month unlocks a cash bonus.',
      reward: 'A cash bonus per qualifying agent', requirements: [count('NEW_HIRES', 3)],
    },
    {
      ...seasonal, code: 'APE_CHALLENGE_NEXT', title: `${quarter} APE Challenge`, from: quarterStart, to: addMonths(quarterStart, 2),
      description: 'Next quarter’s APE challenge. Tiered rewards are published before it starts.',
      poster: { emoji: '📊', color: 'navy' }, blurb: `Next quarter’s APE push — starts ${monthRangeWords(quarterStart, quarterStart)}.`,
      reward: 'To be announced — tiered rewards published before it starts', requirements: [ape(300 * JT)],
    },
    {
      ...seasonal, code: 'PERSISTENCY_PUSH', title: persistency.title, from: last, to: last,
      description: 'A one-month campaign. It has ended; its results are final once the month locks.',
      poster: { emoji: '📉', color: 'muted' }, blurb: 'Closed out at month end — results posted at the branch.',
      reward: 'A cash bonus',
      requirements: [{ metricKey: persistency.metricKey, comparator: 'gte', value: persistency.value, unit: persistency.unit }],
    },
    {
      code: 'PROMOTION_AGENT_AAB', title: 'Promotion: Agent → AAB', kind: 'structural', subtype: 'promotion', window: 'rolling_12m',
      from: `${M.slice(0, 4)}-01`, to: null, appliesToOrgLevelCodes: ['AGENT'],
      description: 'Standing promotion criteria, evaluated over the last twelve months on file, for review as an AAB.',
      poster: { emoji: '🎖️', color: 'navy' }, blurb: 'Standing criteria to move up to AAB.',
      reward: 'Review for promotion to AAB', requirements: [ape(1_200 * JT), count('NEW_ACTIVE_AGENTS', 3)],
    },
    {
      code: 'PROMOTION_AAB_AB', title: 'Promotion: AAB → AB', kind: 'structural', subtype: 'promotion', window: 'rolling_12m',
      from: `${M.slice(0, 4)}-01`, to: null, appliesToOrgLevelCodes: ['AAB'],
      description: 'Standing promotion criteria, evaluated over the last twelve months on file, for review as an AB.',
      poster: { emoji: '🏅', color: 'navy' }, blurb: 'Standing criteria to move up to AB.',
      reward: 'Review for promotion to AB', requirements: [count('MAA_COUNT_IN_UNIT', 5), count('NEW_HIRES', 6)],
    },
    {
      code: 'MDRT_QUALIFICATION', title: 'MDRT Qualification', kind: 'structural', subtype: 'ongoing', window: 'calendar_year',
      from: `${M.slice(0, 4)}-01`, to: null, appliesToOrgLevelCodes: [],
      description: 'The annual production benchmark for Million Dollar Round Table membership, read as APE for the calendar '
        + 'year until the file carries first-year commission.',
      poster: { emoji: '🏆', color: 'gold' }, blurb: 'Standing production benchmark for Million Dollar Round Table membership.',
      reward: 'MDRT membership — global recognition and the annual meeting', requirements: [ape(mdrtApe)],
    },
    {
      ...seasonal, code: 'ARCHIVED_DRIVE', title: 'Archived drive', from: addMonths(M, -4), to: addMonths(M, -4), status: 'archived',
      description: '', poster: { emoji: '🎯', color: 'navy' }, blurb: '', reward: '', requirements: [ape(100 * JT)],
    },
  ];
  const CAMPAIGNS0555: SeedCampaign[] = [{
    ...seasonal, code: 'GADING_PUSH', title: 'Gading Push', from: M, to: M,
    description: 'The branch’s own month of APE.', poster: { emoji: '🚀', color: 'success' }, blurb: 'A month of APE for the branch.',
    reward: 'Branch dinner', requirements: [ape(50 * JT)],
  }];

  const writeCampaigns = async (office: string, list: readonly SeedCampaign[]) => {
    for (const c of list) {
      if (await db.collection('campaigns').findOne({ kpmId: office, code: c.code, deletedAt: null })) continue;
      await db.collection('campaigns').insertOne({
        _id: new mongoose.Types.ObjectId(seedObjectId('campaigns-fixture', office, c.code)),
        kpmId: office, code: c.code, title: c.title, description: c.description,
        startsAt: startOf(c.from), endsAt: c.to === null ? null : endOf(c.to),
        kind: c.kind, subtype: c.subtype, window: c.window, appliesToOrgLevelCodes: c.appliesToOrgLevelCodes,
        poster: c.poster, blurb: c.blurb, reward: c.reward, requirements: c.requirements,
        version: 1, status: c.status ?? 'active', archivedAt: c.status ? now : null, deletedAt: null,
        createdBy: null, updatedBy: null, createdAt: now, updatedAt: now,
      });
      written += 1;
    }
  };
  await writeCampaigns(kpmId, CAMPAIGNS0417);
  await writeCampaigns(deps.office0555.kpmId, CAMPAIGNS0555);

  // ---- The chases.
  const CHASES: readonly [keyof typeof cast, string][] = [
    ['rina', 'APE_SPRINT'], ['rina', 'MDRT_QUALIFICATION'], ['rina', 'PERSISTENCY_PUSH'],
    ['agus', 'MDRT_QUALIFICATION'], ['dimas', 'MDRT_QUALIFICATION'], ['dimas', 'APE_SPRINT'],
    ['sari', 'PROMOTION_AAB_AB'], ['budi', 'PERSISTENCY_PUSH'],
  ];
  for (const [who, code] of CHASES) {
    const membershipId = cast[who];
    if (await db.collection('campaignChases').findOne({ kpmId, membershipId, campaignCode: code, deletedAt: null })) continue;
    const chasedAt = code === 'PERSISTENCY_PUSH' ? startOf(last) : startOf(M);
    await db.collection('campaignChases').insertOne({
      _id: new mongoose.Types.ObjectId(seedObjectId('campaigns-fixture', 'chase', kpmId, membershipId, code)),
      kpmId, membershipId, campaignCode: code, chasing: true, chasedAt, unchasedAt: null, closedBy: null,
      deletedAt: null, createdAt: chasedAt, updatedAt: chasedAt,
    });
    written += 1;
  }

  const rp = (sen: number) => `Rp ${new Intl.NumberFormat('id-ID').format(Math.round(sen / 100))}`;
  const pTarget = persistency.metricKey === 'APE_ACHIEVED' ? `APE ≥ ${rp(persistency.value)}`
    : persistency.metricKey === 'ROLLING_PERSISTENCY' ? `persistency ≥ ${persistency.value}%`
      : `${persistency.title.replace(' Push', '')} ≥ ${persistency.value}`;
  const guide = `
  CAMPAIGNS at /campaigns, /summary and /unit/dashboard  (from src/seed/campaigns-fixture.ts)
    rina@kpm0417.test            /campaigns: both tabs, every section; ⭐ on her three; APE Sprint's dialog
                                 APE ✓ (target ${rp(sprintApe)}) and New Hire "Not uploaded yet" (the month
                                 before last is the office's empty one); ${persistency.title} ended, chase
                                 disabled, final (${pTarget}): qualified; Promotion: AAB → AB not open to
                                 her role. /summary's card: APE Sprint and MDRT — the ended one dropped
    budi@kpm0417.test            /summary: "You're not chasing any campaigns yet…" (his one chase ended);
                                 not met on ${persistency.title}
    sari@kpm0417.test            /unit/dashboard: Rina ✓, Budi —, Budi's chips "Not currently chasing any
                                 campaigns."; /coaching/{Rina}/summary two chips; /coaching/{Budi}/summary
                                 the empty sentence
    agus@kpm0417.test            The roster: his own ✓, Dimas ✓, Rina ✓, the rest —; the header tooltip
                                 names MDRT's requirement (APE ≥ ${rp(mdrtApe)} for the year)
    owner@ · admin@kpm0417.test  Settings › Campaigns: the new fields; the field view's /campaigns
    agent@kpm0555.test           Only Gading Push; a 0417 address is not found
    The targets above are the office's own until the client gives theirs (ADR-0142).
`;

  return { written, targets: { sprintApe, sprintHires, mdrtApe, persistency: { metricKey: persistency.metricKey, value: persistency.value, title: persistency.title } }, guide };
}
