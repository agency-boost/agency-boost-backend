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

/**
 * The five, in the prototype's own wording (`Unit_Section_Coaching.html:1718-1721`) — **written in Bahasa Indonesia
 * since P18.98-T7** (OD-238, option 1; ADR-0179 §5), as the grids are. The four stages keep their English names: they
 * are the ladder's titles, as the role ladder's *Agency Builder* is (the approved glossary's §A.5), and a milestone
 * names them as they are. The English is `SEEDED_CAPABILITY_LABELS_BEFORE_OD_238`'s.
 */
export const SEED_CAPABILITY_MILESTONES: readonly CapabilityMilestone[] = [
  { code: 'SELLS_INDEPENDENTLY', label: 'Menjual polis secara mandiri' },
  { code: 'SELLS_OUTSIDE_NETWORK', label: 'Menjual di luar jaringan langsung' },
  { code: 'RECRUITS_QUALITY', label: 'Merekrut agen berkualitas' },
  { code: 'DEVELOPS_TO_INDEPENDENT', label: 'Membina agen downline hingga menjadi Independent Producer' },
  { code: 'DEVELOPS_TO_PRODUCTIVE', label: 'Membina leader downline hingga menjadi Productive Team Builder' },
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
    label: 'Penjualan pribadi',
    requiresDownline: false,
    items: [
      { code: 'LEADS_GEN', label: 'Konsistensi pencarian leads' },
      { code: 'APPROACH', label: 'Pendekatan & set appointment' },
      { code: 'FACT_FINDING', label: 'Penggalian fakta & identifikasi kebutuhan' },
      { code: 'PRODUCT_ADVISORY', label: 'Pengetahuan & saran produk' },
      { code: 'PRESENTATION', label: 'Presentasi' },
      { code: 'OBJECTION_HANDLING', label: 'Penanganan keberatan & closing' },
      { code: 'AFTER_SALES', label: 'Layanan purnajual' },
    ],
  },
  {
    code: 'RECRUITMENT',
    label: 'Recruitment',
    requiresDownline: false,
    items: [
      { code: 'CANDIDATE_LEADS_GEN', label: 'Pencarian leads kandidat' },
      { code: 'FILTERING', label: 'Penyaringan calon kandidat' },
      { code: 'RECRUIT_APPROACH', label: 'Pendekatan' },
      { code: 'PROFILING', label: 'Pemetaan profil (motivasi / pemicu utama)' },
      { code: 'PITCHING', label: 'Pitch peluang bisnis' },
      { code: 'RECRUIT_CLOSING', label: 'Closing recruitment & pendampingan FLC' },
    ],
  },
  {
    code: 'DEVELOPING_DOWNLINE_AGENT',
    label: 'Membina agen downline',
    requiresDownline: true,
    items: [
      { code: 'AGENT_VISIBILITY', label: 'Visibilitas atas progres & goal setiap agen' },
      { code: 'AGENT_TRACKING', label: 'Pemantauan aktivitas & check-in 1-on-1 yang konsisten' },
      { code: 'AGENT_SKILL_GAPS', label: 'Identifikasi kesenjangan keterampilan menjual agen' },
      { code: 'AGENT_SALES_COACHING', label: 'Memberikan coaching penjualan yang efektif kepada agen' },
      { code: 'AGENT_MINDSET', label: 'Memperkuat pola pikir & motivasi agen' },
      { code: 'AGENT_ACTIVATION', label: '90-day activation yang terstruktur (termasuk Join Field Work)' },
      { code: 'AGENT_REACTIVATION', label: 'Mengaktifkan kembali agen yang tidak produktif' },
    ],
  },
  {
    code: 'DEVELOPING_DOWNLINE_LEADER',
    label: 'Membina leader downline',
    requiresDownline: true,
    items: [
      { code: 'LEADER_VISIBILITY', label: 'Visibilitas atas progres setiap leader & timnya' },
      { code: 'LEADER_TIME', label: 'Mengalokasikan waktu untuk membangun tim' },
      { code: 'LEADER_SKILL_GAPS', label: 'Identifikasi kesenjangan keterampilan recruitment leader downline' },
      { code: 'LEADER_RECRUIT_COACHING', label: 'Memberikan coaching recruitment yang efektif kepada leader' },
      { code: 'LEADER_JFW', label: 'Mendampingi leader dalam Join Field Work recruitment' },
      { code: 'LEADER_CHECK_INS', label: 'Check-in 1-on-1 yang konsisten di seluruh tim leader' },
      { code: 'LEADER_COACH_THE_COACH', label: 'Coaching the coach: meningkatkan efektivitas coaching para leader' },
    ],
  },
];

/**
 * **The words the seed gave before P18.98-T7** (OD-238, option 1), per code — the prototype's English
 * (`Unit_Section_Coaching.html:1718-1721` and its four grids). Kept only so migration `0046` can recognise the Template
 * company's Default template where it still holds them, and for the specs. No office and no template is given them
 * any more. The four stages' names and the *Recruitment* grid are kept English, so they are not here.
 */
export const SEEDED_CAPABILITY_LABELS_BEFORE_OD_238: {
  readonly milestones: Readonly<Record<string, string>>;
  readonly grids: Readonly<Record<string, string>>;
  readonly items: Readonly<Record<string, string>>;
} = {
  milestones: {
    SELLS_INDEPENDENTLY: 'Sells policies independently',
    SELLS_OUTSIDE_NETWORK: 'Sells outside direct network',
    RECRUITS_QUALITY: 'Recruits quality agents',
    DEVELOPS_TO_INDEPENDENT: 'Develops downline agent to Independent Producer',
    DEVELOPS_TO_PRODUCTIVE: 'Develops downline leader to Productive Team Builder',
  },
  grids: {
    PERSONAL_SELLING: 'Personal selling',
    DEVELOPING_DOWNLINE_AGENT: 'Developing downline agent',
    DEVELOPING_DOWNLINE_LEADER: 'Developing downline leader',
  },
  items: {
    LEADS_GEN: 'Leads generation consistency',
    APPROACH: 'Approach & appointment setting',
    FACT_FINDING: 'Fact finding & needs ID',
    PRODUCT_ADVISORY: 'Product advisory & knowledge',
    PRESENTATION: 'Presentation',
    OBJECTION_HANDLING: 'Objection handling & closing',
    AFTER_SALES: 'After-sales service',
    CANDIDATE_LEADS_GEN: 'Candidate leads generation',
    FILTERING: 'Filtering potential candidates',
    RECRUIT_APPROACH: 'Approaching',
    PROFILING: 'Profiling (motivation / hot button)',
    PITCHING: 'Pitching the business opportunity',
    RECRUIT_CLOSING: 'Closing recruitment & FLC accompaniment',
    AGENT_VISIBILITY: "Visibility into each agent's progress & goals",
    AGENT_TRACKING: 'Consistent activity tracking & 1-on-1 check-ins',
    AGENT_SKILL_GAPS: "Identifying agents' selling skill gaps",
    AGENT_SALES_COACHING: 'Delivering effective sales coaching to agents',
    AGENT_MINDSET: 'Reinforcing agent mindset & motivation',
    AGENT_ACTIVATION: 'Structured 90-day activation (incl. Join Field Work)',
    AGENT_REACTIVATION: 'Reactivating unproductive agents',
    LEADER_VISIBILITY: "Visibility into each leader's & their team's progress",
    LEADER_TIME: 'Allocating time for team building',
    LEADER_SKILL_GAPS: "Identifying downline leaders' recruitment skill gaps",
    LEADER_RECRUIT_COACHING: 'Delivering effective recruitment coaching to leaders',
    LEADER_JFW: 'Accompanying leaders on recruitment Join Field Work',
    LEADER_CHECK_INS: "Consistent 1-on-1 check-ins across the leader's team",
    LEADER_COACH_THE_COACH: "Coaching-the-coach: improving leaders' coaching effectiveness",
  },
};

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
