/**
 * The capability catalog (P5-T8, ADR-0025, ADR-0036).
 *
 * Four ordered stages, five cumulative milestones, and four skill grids — the instrument a leader
 * assesses somebody against. The prototype hardcodes all of it and **shares one object between
 * every person on the screen**.
 *
 * **Every item carries an id.** Two of the prototype's four grids have none at all: a tick is bound
 * to the label text, so renaming *"Approach & appointment setting"* orphans every record that used
 * it. That is the defect ADR-0025 exists to resolve, not a detail of it.
 */

export interface CapabilityMilestone {
  readonly code: string;
  readonly label: string;
}

export interface CapabilityStage {
  readonly code: string;
  readonly label: string;
  /**
   * What a leader must have ticked to be at this stage, cumulatively.
   *
   * **Named milestones, never a count and never an array index.** The prototype works the stage out
   * from the position of the stage in its own array, so reordering the ladder silently moves
   * everybody's stage (P5-T8 AC-6).
   */
  readonly requiredMilestoneCodes: readonly string[];
  /**
   * How senior this stage is. **Not its position on screen.**
   *
   * Separate from `displayOrder` on purpose: an office reordering the ladder for readability must
   * not change who is at which stage.
   */
  readonly stageOrder: number;
}

export interface CapabilityGridItem {
  readonly code: string;
  readonly label: string;
}

export interface CapabilityGrid {
  readonly code: string;
  readonly label: string;
  /** Grids 3 and 4 render N/A for somebody with no downline — the prototype disables them. */
  readonly requiresDownline: boolean;
  readonly items: readonly CapabilityGridItem[];
}

/** The five, in the prototype's own wording (`Unit_Section_Coaching.html:1718-1721`). */
export const SEED_CAPABILITY_MILESTONES: readonly CapabilityMilestone[] = [
  { code: 'SELLS_INDEPENDENTLY', label: 'Sells policies independently' },
  { code: 'SELLS_OUTSIDE_NETWORK', label: 'Sells outside direct network' },
  { code: 'RECRUITS_QUALITY', label: 'Recruits quality agents' },
  { code: 'DEVELOPS_TO_INDEPENDENT', label: 'Develops downline agent to Independent Producer' },
  { code: 'DEVELOPS_TO_PRODUCTIVE', label: 'Develops downline leader to Productive Team Builder' },
];

/** Strictly cumulative: each stage requires everything the one below it does, and one more. */
export const SEED_CAPABILITY_STAGES: readonly CapabilityStage[] = [
  {
    code: 'COMPETENT_PRODUCER',
    label: 'Competent Producer',
    requiredMilestoneCodes: ['SELLS_INDEPENDENTLY'],
    stageOrder: 1,
  },
  {
    code: 'INDEPENDENT_PRODUCER',
    label: 'Independent Producer',
    requiredMilestoneCodes: ['SELLS_INDEPENDENTLY', 'SELLS_OUTSIDE_NETWORK'],
    stageOrder: 2,
  },
  {
    code: 'PRODUCTIVE_TEAM_BUILDER',
    label: 'Productive Team Builder',
    requiredMilestoneCodes: [
      'SELLS_INDEPENDENTLY', 'SELLS_OUTSIDE_NETWORK', 'RECRUITS_QUALITY',
      'DEVELOPS_TO_INDEPENDENT',
    ],
    stageOrder: 3,
  },
  {
    code: 'TRANSFORMATIVE_TEAM_BUILDER',
    label: 'Transformative Team Builder',
    requiredMilestoneCodes: [
      'SELLS_INDEPENDENTLY', 'SELLS_OUTSIDE_NETWORK', 'RECRUITS_QUALITY',
      'DEVELOPS_TO_INDEPENDENT', 'DEVELOPS_TO_PRODUCTIVE',
    ],
    stageOrder: 4,
  },
];

/**
 * The four grids, 7 · 6 · 7 · 7, in the prototype's own wording.
 *
 * **The last two are given codes here for the first time** (AC-2). The prototype keys them by label
 * alone, so every tick on them is bound to a string somebody may edit. They are minted the same way
 * as the first two — the point is that no grid is special.
 */
export const SEED_CAPABILITY_GRIDS: readonly CapabilityGrid[] = [
  {
    code: 'PERSONAL_SELLING',
    label: 'Personal selling',
    requiresDownline: false,
    items: [
      { code: 'LEADS_GEN', label: 'Leads generation consistency' },
      { code: 'APPROACH', label: 'Approach & appointment setting' },
      { code: 'FACT_FINDING', label: 'Fact finding & needs ID' },
      { code: 'PRODUCT_ADVISORY', label: 'Product advisory & knowledge' },
      { code: 'PRESENTATION', label: 'Presentation' },
      { code: 'OBJECTION_HANDLING', label: 'Objection handling & closing' },
      { code: 'AFTER_SALES', label: 'After-sales service' },
    ],
  },
  {
    code: 'RECRUITMENT',
    label: 'Recruitment',
    requiresDownline: false,
    items: [
      { code: 'CANDIDATE_LEADS_GEN', label: 'Candidate leads generation' },
      { code: 'FILTERING', label: 'Filtering potential candidates' },
      { code: 'RECRUIT_APPROACH', label: 'Approaching' },
      { code: 'PROFILING', label: 'Profiling (motivation / hot button)' },
      { code: 'PITCHING', label: 'Pitching the business opportunity' },
      { code: 'RECRUIT_CLOSING', label: 'Closing recruitment & FLC accompaniment' },
    ],
  },
  {
    code: 'DEVELOPING_DOWNLINE_AGENT',
    label: 'Developing downline agent',
    requiresDownline: true,
    items: [
      { code: 'AGENT_VISIBILITY', label: "Visibility into each agent's progress & goals" },
      { code: 'AGENT_TRACKING', label: 'Consistent activity tracking & 1-on-1 check-ins' },
      { code: 'AGENT_SKILL_GAPS', label: "Identifying agents' selling skill gaps" },
      { code: 'AGENT_SALES_COACHING', label: 'Delivering effective sales coaching to agents' },
      { code: 'AGENT_MINDSET', label: 'Reinforcing agent mindset & motivation' },
      { code: 'AGENT_ACTIVATION', label: 'Structured 90-day activation (incl. Join Field Work)' },
      { code: 'AGENT_REACTIVATION', label: 'Reactivating unproductive agents' },
    ],
  },
  {
    code: 'DEVELOPING_DOWNLINE_LEADER',
    label: 'Developing downline leader',
    requiresDownline: true,
    items: [
      { code: 'LEADER_VISIBILITY', label: "Visibility into each leader's & their team's progress" },
      { code: 'LEADER_TIME', label: 'Allocating time for team building' },
      { code: 'LEADER_SKILL_GAPS', label: "Identifying downline leaders' recruitment skill gaps" },
      { code: 'LEADER_RECRUIT_COACHING', label: 'Delivering effective recruitment coaching to leaders' },
      { code: 'LEADER_JFW', label: 'Accompanying leaders on recruitment Join Field Work' },
      { code: 'LEADER_CHECK_INS', label: "Consistent 1-on-1 check-ins across the leader's team" },
      { code: 'LEADER_COACH_THE_COACH', label: "Coaching-the-coach: improving leaders' coaching effectiveness" },
    ],
  },
];

/**
 * Which stage somebody is at, from what has been ticked (P5-T8 AC-6).
 *
 * **The highest stage whose milestones are all ticked**, found by `stageOrder` — never by position
 * in a list. The prototype walks its own array and keeps the last index that matched, so an office
 * reordering the ladder for readability would silently move everybody's stage.
 *
 * `null` means not yet at the first stage, which is a real answer and not an error: the prototype
 * renders it as *"Not yet at Competent Producer"*.
 */
export function capabilityStageFor(
  stages: readonly CapabilityStage[],
  ticked: readonly string[],
): CapabilityStage | null {
  const has = new Set(ticked);
  return [...stages]
    .sort((a, b) => a.stageOrder - b.stageOrder)
    .reduce<CapabilityStage | null>(
      (reached, stage) =>
        (stage.requiredMilestoneCodes.every((code) => has.has(code)) ? stage : reached),
      null,
    );
}
