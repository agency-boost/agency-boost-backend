import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ACTIVITY_TEXT, SEED_ACTIVITY_CATEGORIES, SEED_ACTIVITY_TYPES, SEED_LEAD_STATUSES, SEED_RATIO_DEFINITIONS, SEED_RATIO_PURPOSES,
  SEEDED_ACTIVITY_WORDINGS_BEFORE_ADR_0160, SEEDED_LEAD_STATUS_LABELS_BEFORE_ADR_0167, SEEDED_RATIO_VALUES_BEFORE_ADR_0160,
  SEEDED_ACTIVITY_WORDINGS_BEFORE_OD_238, SEEDED_LEAD_STATUS_LABELS_BEFORE_OD_238,
} from './activity-taxonomy';
import { RATIO_BENCHMARKS } from './benchmarks';

/**
 * The seeded taxonomy against the prototype it was transcribed from.
 *
 * `AgencyBoost_KPM_Owner.html` is frozen input and the Owner settings screens are its own
 * module, so it is the later word on this copy (`docs/99-meta/prototype-sources.md`,
 * precedence rule 2). Nothing pinned that until now, and the gap was not hypothetical:
 * item 12's description — *"1-on-1 coaching, unit meeting, role-play, JFW, memberikan
 * training"* — was dropped in transcription and nothing noticed, because a missing
 * description renders as an absent line rather than as a wrong one.
 *
 * This reads the prototype rather than restating it. A test carrying its own copy of the
 * twelve labels would be a third transcription, and would agree with the second one
 * whether or not either matched the source.
 */
const PROTOTYPE = join(__dirname, '../../../../prototype/AgencyBoost_KPM_Owner.html');

/**
 * **The seed in the English it gave before P18.10-T7** (OD-238): the platform's Default template is written in
 * Bahasa Indonesia, so the prototype is compared against the words recorded for migration 0046 — and the Indonesian is
 * pinned word for word in its own test below.
 */
const englishCategory = (c: { code: string; label: string }) =>
  SEEDED_ACTIVITY_WORDINGS_BEFORE_OD_238.categories[c.code]?.label ?? c.label;
const englishGroup = (c: { code: string; summaryGroupLabel: string | null }) =>
  SEEDED_ACTIVITY_WORDINGS_BEFORE_OD_238.categories[c.code]?.summaryGroupLabel ?? c.summaryGroupLabel;
const englishStatus = (s: { pipeline: 'sales' | 'recruitment'; code: string; label: string }) =>
  SEEDED_LEAD_STATUS_LABELS_BEFORE_OD_238[s.pipeline][s.code] ?? s.label;

/** Every `acttype-item` in document order: its number, title and optional description. */
function prototypeItems(): { num: number; title: string; description: string | null }[] {
  const html = readFileSync(PROTOTYPE, 'utf8');
  const items: { num: number; title: string; description: string | null }[] = [];
  const block = /<span class="acttype-num">(\d+)<\/span>([\s\S]*?)<div class="cfg-actions">/g;
  for (const [, num, body] of html.matchAll(block)) {
    const title = /acttype-item-title">([^<]*)</.exec(body)?.[1] ?? '';
    const description = /acttype-item-desc">([^<]*)</.exec(body)?.[1] ?? null;
    items.push({ num: Number(num), title, description });
  }
  return items;
}

describe('the seeded activity taxonomy matches the prototype', () => {
  const items = prototypeItems();

  it('reads twelve items out of the prototype, so the rest of this file means something', () => {
    // Guards the parser, not the seed. A regex that silently matched nothing would make
    // every assertion below vacuously true.
    expect(items).toHaveLength(12);
    expect(items.map((i) => i.num)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  /*
   * **Three named exceptions, the client's** (2026-10-26, ADR-0160 §1, P18.5-T8 AC-4; registered in
   * `prototype-parity.md`): item 3 reads *Set Appointment*, item 7 *Melakukan presentasi recruitment* — the
   * second time it is renamed, after P13.1-T3's *Proses pendaftaran kode agen* — and item 8 says
   * *recruitment* where the prototype says *NBO*. Pinned by code and by both wordings, so the prototype still
   * has to say what it said, and a fourth label drifting from it fails here rather than joining these.
   *
   * **And a fourth, the approved glossary's §C1** (OD-237; P18.10-T7): item 10 says *the company* where the
   * prototype names *Prudential* — our own words name no company.
   */
  const RENAMED: Readonly<Record<string, { prototype: string; ours: string }>> = {
    LEADS_CONTACTED: { prototype: 'Menghubungi prospek yang sudah ada', ours: 'Set Appointment' },
    RECRUIT_PRESENTATION: { prototype: 'Presentasi NBO ke calon agen', ours: 'Melakukan presentasi recruitment' },
    RECRUIT_FOLLOWUP: {
      prototype: 'Melakukan diskusi follow up dari presentasi NBO sebelumnya',
      ours: 'Melakukan diskusi follow up dari presentasi recruitment sebelumnya',
    },
    DEV_TRAINING_ATTEND: {
      prototype: SEEDED_ACTIVITY_WORDINGS_BEFORE_OD_238.types.DEV_TRAINING_ATTEND.label,
      ours: 'Menghadiri meeting atau training dari KPM atau perusahaan',
    },
  };

  it('P18.5-T8 AC-4 carries the same twelve labels, verbatim but for items 3, 7 and 8, renamed at the client’s request, and 10', () => {
    for (const [code, { prototype, ours }] of Object.entries(RENAMED)) {
      const index = SEED_ACTIVITY_TYPES.findIndex((t) => t.code === code);
      expect({ code, title: items[index].title }).toEqual({ code, title: prototype });
      expect({ code, label: SEED_ACTIVITY_TYPES[index].label }).toEqual({ code, label: ours });
    }
    expect(SEED_ACTIVITY_TYPES.filter((t) => t.code in RENAMED).map((t) => t.displayOrder)).toEqual([3, 7, 8, 10]);
    expect(RENAMED.DEV_TRAINING_ATTEND.prototype).toBe('Menghadiri meeting atau training dari KPM atau Prudential');
    expect(SEED_ACTIVITY_TYPES.map((t) => t.label).join(' ')).not.toContain('Prudential');

    expect(SEED_ACTIVITY_TYPES.map((t) => t.label))
      .toEqual(items.map((i, index) => RENAMED[SEED_ACTIVITY_TYPES[index].code]?.ours ?? i.title));
  });

  it('P18.5-T8 AC-3 keeps the earlier seeded wordings, for the migration to recognise', () => {
    // Item 7 was seeded with the prototype's words and then with P13.1-T3's; an office may hold either.
    expect(SEEDED_ACTIVITY_WORDINGS_BEFORE_ADR_0160).toEqual({
      LEADS_CONTACTED: { labels: [RENAMED.LEADS_CONTACTED.prototype] },
      RECRUIT_PRESENTATION: {
        labels: [RENAMED.RECRUIT_PRESENTATION.prototype, 'Proses pendaftaran kode agen'],
        description: items[6].description,
      },
      RECRUIT_FOLLOWUP: { labels: [RENAMED.RECRUIT_FOLLOWUP.prototype] },
    });
  });

  it('P18.5-T8 AC-2 carries the same descriptions but item 7’s, dropped with its rename', () => {
    // Item 7's note, *secara mandiri atau melalui BOP*, described registering an agent code (ADR-0160 §1).
    const seven = SEED_ACTIVITY_TYPES.findIndex((t) => t.code === 'RECRUIT_PRESENTATION');
    expect(items[seven].description).toBe('secara mandiri atau melalui BOP');
    expect(SEED_ACTIVITY_TYPES[seven].description).toBeNull();

    expect(SEED_ACTIVITY_TYPES.map((t) => t.description ?? null))
      .toEqual(items.map((i, index) => (index === seven ? null : i.description)));
    // Four in the prototype, not three: this is the assertion that was failing in production data.
    expect(items.filter((i) => i.description)).toHaveLength(4);
    // Item 3 keeps its own.
    expect(SEED_ACTIVITY_TYPES.find((t) => t.code === 'LEADS_CONTACTED')!.description).toBe('telepon, WhatsApp, tatap muka, dll');
  });

  it('keeps display order 1–12 across five categories, in the prototype’s grouping', () => {
    expect(SEED_ACTIVITY_TYPES.map((t) => t.displayOrder)).toEqual(items.map((i) => i.num));

    const html = readFileSync(PROTOTYPE, 'utf8');
    const headings = [...html.matchAll(/<div class="acttype-card-head"><h3>([^<]+)<\/h3>/g)]
      .map((m) => m[1]);
    expect(SEED_ACTIVITY_CATEGORIES.map(englishCategory)).toEqual(headings);
  });

  it('groups the same counts into the same categories', () => {
    const html = readFileSync(PROTOTYPE, 'utf8');
    const counts = [...html.matchAll(/<span class="acttype-count">(\d+) items?<\/span>/g)]
      .map((m) => Number(m[1]));

    const byCategory = SEED_ACTIVITY_CATEGORIES.map((c) =>
      SEED_ACTIVITY_TYPES.filter((t) => t.categoryCode === c.code).length);
    expect(byCategory).toEqual(counts);
  });
});

describe('the seeded lead pipelines against the prototype', () => {
  const html = readFileSync(PROTOTYPE, 'utf8');
  const labelsIn = (panelId: string) => {
    const panel = html.slice(html.indexOf(`id="${panelId}"`));
    const table = panel.slice(0, panel.indexOf('</div>\n      </div>'));
    return [...table.matchAll(/<div class="cfg-label">([^<]+)<\/div>/g)].map((m) => m[1]);
  };

  it('matches the sales pipeline exactly', () => {
    const sales = SEED_LEAD_STATUSES.filter((l) => l.pipeline === 'sales');
    expect(sales.map(englishStatus)).toEqual(labelsIn('leadstatuses-sales'));
  });

  /*
   * **One named exception, the client's** (2026-10-26, ADR-0167 §10, OD-205, UI-027; P18.7-T9 AC-6; registered in
   * `prototype-parity.md`): the recruitment pipeline's first status reads *Not yet approached*, the sales pipeline's
   * words, where both prototypes say *Not approached*. Pinned by code and by both wordings, so the prototype still
   * has to say what it said, and another stage drifting from it fails here rather than joining this one.
   */
  it('P18.7-T9 AC-6 starts the recruitment pipeline in the sales pipeline’s words, renamed at the client’s request', () => {
    const overall = readFileSync(join(__dirname, '../../../../prototype/AgencyBoost_Overall.html'), 'utf8');
    /** One of the agent app's status orders (`Overall.html:5366-5367`), read rather than retyped. */
    const order = (name: string): string[] =>
      JSON.parse(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`).exec(overall)![1]) as string[];
    const agentApp = order('RECRUITMENT_STATUS_ORDER');
    const settings = labelsIn('leadstatuses-recruitment');

    // The prototype's word, in the Owner's settings and in the agent app alike, and the one the seed gave before.
    expect(settings[0]).toBe('Not approached');
    expect(agentApp[0]).toBe('Not approached');
    expect(SEEDED_LEAD_STATUS_LABELS_BEFORE_ADR_0167).toEqual({
      NOT_APPROACHED: { pipeline: 'recruitment', labels: [settings[0]] },
    });

    // Ours: the same code, in the sales pipeline's first words — which the sales pipeline still has verbatim.
    const recruitment = SEED_LEAD_STATUSES.filter((l) => l.pipeline === 'recruitment');
    expect(recruitment[0]).toMatchObject({ code: 'NOT_APPROACHED', rank: 1 });
    expect(englishStatus(recruitment[0])).toBe('Not yet approached');
    expect(englishStatus(recruitment[0])).toBe(order('SALES_STATUS_ORDER')[0]);
    expect(englishStatus(recruitment[0])).toBe(labelsIn('leadstatuses-sales')[0]);
    // In Bahasa Indonesia since P18.10-T7, still the sales pipeline's first words.
    expect(recruitment[0].label).toBe(SEED_LEAD_STATUSES[0].label);

    // Every other stage keeps the agent app's words (ADR-0043's seven).
    expect(recruitment.map(englishStatus)).toEqual(agentApp.map((label, i) => (i === 0 ? englishStatus(recruitment[0]) : label)));
  });

  it('has two recruitment stages the Owner prototype does not — ratified by ADR-0043', () => {
    /*
     * The prototypes disagree with each other, not with us. `Overall.html:5367` — the
     * agent app, where leads are actually worked — lists seven stages including
     * *Agent code created*; this file's settings screen lists six and calls stage three
     * *Pitched*. `glossary.md:337` records the conflict.
     *
     * **ADR-0043 ratified the seven.** It was pinned here rather than corrected so that
     * closing OD-12 would be a deliberate edit in this file, and it was: the ADR found
     * that Phase 4 had already shipped the agent app's ladder and the register had not
     * noticed. Leads are worked in the agent app, and an office may add or archive its
     * own stages from P4-T3's settings screen regardless.
     */
    const ours = SEED_LEAD_STATUSES.filter((l) => l.pipeline === 'recruitment');
    const theirs = labelsIn('leadstatuses-recruitment');

    expect(theirs).toHaveLength(6);
    expect(ours).toHaveLength(7);
    expect(ours.map(englishStatus)).toEqual(expect.arrayContaining(['Agent code created']));
    // The terminal stage is the one both agree on, and the one everything downstream reads.
    expect(englishStatus(ours.at(-1)!)).toBe(theirs.at(-1));
    expect(ours.filter((l) => l.isTerminal).map(englishStatus)).toEqual(['New active agent']);
  });

  it('flags the stages after which the work is the counterparty’s (ADR-0043)', () => {
    /*
     * OD-12's second half. `RECRUITMENT_EXPECTED_TO_CLOSE` counts these, and it is the
     * KPM Overview tile that could not be computed before this field existed.
     *
     * Pinned by code rather than by count, because which stages these are is the decision
     * — an office may change its own copy, but changing what a new office starts with is
     * a change to the ADR.
     */
    const late = SEED_LEAD_STATUSES.filter((l) => l.isLateStage).map((l) => l.code);

    expect(late).toEqual([
      'POLICY_SUBMITTED', 'APPROVED_NOT_PAID',
      'AGENT_CODE_CREATED', 'AAJI_LICENSED', 'JOINT_FIELD_WORK_PLANNED',
    ]);
  });

  it('never flags a terminal stage, in either pipeline', () => {
    // A lead that has closed is not expected to close. Both flags on one stage would
    // double it against the previous period's figure.
    expect(SEED_LEAD_STATUSES.filter((l) => l.isTerminal && l.isLateStage)).toEqual([]);
  });
});

describe('the seeded ratios against the prototype', () => {
  const html = readFileSync(PROTOTYPE, 'utf8');

  it('P18.5-T9 AC-3 carries the five, with the benchmarks the prototype shows raised at the client’s request', () => {
    const shown = [...html.matchAll(/class="ratio-benchmark-input" value="([\d.]+)"/g)]
      .map((m) => Number(m[1]));
    expect(shown).toEqual([30, 15.0, 15.0, 0.30, 1.50]);

    /*
     * **Four named exceptions** (ADR-0160 §2, 2026-10-26): the client raised every benchmark but the band's.
     * The prototype writes the two success rates as whole percents and multiplies by 100 on display (`× 100`
     * in its own builder); the domain stores the proportion — which is how the prototype's numbers are kept
     * below, so the four still have to be what it shows.
     */
    expect(SEED_RATIO_DEFINITIONS.map((r) => SEEDED_RATIO_VALUES_BEFORE_ADR_0160[r.code as keyof typeof SEEDED_RATIO_VALUES_BEFORE_ADR_0160]?.benchmark ?? r.benchmark))
      .toEqual([30, 0.15, 0.15, 0.30, 1.50]);
    expect(SEED_RATIO_DEFINITIONS.map((r) => r.benchmark)).toEqual([30, 0.3, 0.3, 1, 0.5]);
    expect(SEED_RATIO_DEFINITIONS.map((r) => r.benchmark)).toEqual([
      RATIO_BENCHMARKS.BALANCE_BAND_PP, RATIO_BENCHMARKS.SELLING_SUCCESS_RATE,
      RATIO_BENCHMARKS.RECRUITMENT_SUCCESS_RATE, RATIO_BENCHMARKS.LEADS_PER_ACTIVITY,
      RATIO_BENCHMARKS.MEETING_PER_APPROACH,
    ]);
  });

  it('P18.5-T9 AC-1 names them the way the prototype’s rows do, but for the client’s Set appointment to meeting', () => {
    const rows = [...html.matchAll(/<div class="cfg-label">([^<\n]+)\n\s*<div id="ratio-builder-/g)]
      .map((m) => m[1].trim());
    expect(rows).toEqual([
      'Selling vs Recruitment balance',
      'Selling success rate',
      'Recruitment success rate',
      'Leads per activity',
      SEEDED_RATIO_VALUES_BEFORE_ADR_0160.MEETING_PER_APPROACH.label,
    ]);
    // Ours drops the trailing "balance", and the fifth is the client's name (ADR-0160 §2) — both
    // registered in `prototype-parity.md`.
    expect(SEED_RATIO_DEFINITIONS.map((r) => r.label)).toEqual([
      'Selling vs Recruitment',
      'Selling success rate',
      'Recruitment success rate',
      'Leads per activity',
      'Set appointment to meeting',
    ]);
  });

  it('P18.5-T9 AC-1 says what each measures in the prototype’s words, but for Set appointment to meeting', () => {
    // `Overall.html:5215-5268`, in the ratios' order. The fifth says *set appointment* where the prototype says
    // *pendekatan prospek*, with its name (ADR-0160 §2).
    const overall = readFileSync(join(__dirname, '../../../../prototype/AgencyBoost_Overall.html'), 'utf8');
    const theirs = [...overall.matchAll(/purpose: "([^"]+)"/g)].map((m) => m[1]);
    expect(theirs).toHaveLength(5);
    const ours = SEED_RATIO_DEFINITIONS.map((r) => SEED_RATIO_PURPOSES[r.code]);
    expect(ours.slice(0, 4)).toEqual(theirs.slice(0, 4));
    expect(theirs[4]).toBe('Mengukur efektivitas pendekatan prospek dalam menghasilkan pertemuan');
    expect(ours[4]).toBe('Mengukur efektivitas set appointment dalam menghasilkan pertemuan');
  });

  it('P18.5-T9 AC-1 shows Set appointment to meeting as a percent, its formula unchanged', () => {
    const mpa = SEED_RATIO_DEFINITIONS.find((r) => r.code === 'MEETING_PER_APPROACH')!;
    expect(mpa).toMatchObject({
      numerator: ['SELL_PRESENTATION', 'RECRUIT_PRESENTATION'],
      denominator: ['LEADS_CONTACTED'],
      comparison: 'gte',
      displayUnit: 'percent',
    });
    expect(SEEDED_RATIO_VALUES_BEFORE_ADR_0160.MEETING_PER_APPROACH.displayUnit).toBe('decimal');
  });
});

describe('the seeded summary tiles against the prototype’s strip (ADR-0064)', () => {
  /*
   * `Overall.html:2720-2726` and `:2752-2757`: four tiles and a total, each summing a range of
   * item numbers. The ranges went with OD-63; the grouping is the seed's now, and this pins it to
   * the strip it was read from — labels in order, and which items each tile counts.
   */
  const OVERALL = join(__dirname, '../../../../prototype/AgencyBoost_Overall.html');

  /** One strip's tiles: label and the item numbers it sums, the total included. */
  function stripOf(id: string): { label: string; items: number[] }[] {
    const html = readFileSync(OVERALL, 'utf8');
    const start = html.indexOf(`id="${id}"`);
    const block = html.slice(start, html.indexOf('</div>\n', html.indexOf('Total touches', start)));
    return [...block.matchAll(
      /<div class="label">([^<]+)<\/div><div class="value[^"]*" data-sum="([\d,]+)">/g,
    )].map(([, label, sum]) => ({ label, items: sum.split(',').map(Number) }));
  }

  /** The seed's tiles, derived the way a strip derives them: first section's position, group label. */
  function seededTiles(): { label: string; items: number[] }[] {
    const tiles = new Map<string, { label: string; items: number[] }>();
    for (const category of [...SEED_ACTIVITY_CATEGORIES].sort((a, b) => a.displayOrder - b.displayOrder)) {
      const key = category.summaryGroupCode ?? `category:${category.code}`;
      const tile = tiles.get(key) ?? { label: englishGroup(category) ?? englishCategory(category), items: [] };
      tile.items.push(...SEED_ACTIVITY_TYPES
        .filter((t) => t.categoryCode === category.code).map((t) => t.displayOrder));
      tiles.set(key, tile);
    }
    return [...tiles.values()];
  }

  it.each(['log-summary-strip', 'dashboard-summary-strip'])('%s: four tiles, then the total', (id) => {
    const strip = stripOf(id);
    // Guards the parser: a regex that matched nothing would make the comparison vacuous.
    expect(strip).toHaveLength(5);
    expect(strip.at(-1)!.items).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

    expect(seededTiles()).toEqual(strip.slice(0, -1));
  });

  it('gives every section both fields or neither, and one label per group', () => {
    for (const c of SEED_ACTIVITY_CATEGORIES) {
      expect(c.summaryGroupCode === null).toBe(c.summaryGroupLabel === null);
    }
    const labels = new Map<string, Set<string>>();
    for (const c of SEED_ACTIVITY_CATEGORIES) {
      if (!c.summaryGroupCode) continue;
      labels.set(c.summaryGroupCode, (labels.get(c.summaryGroupCode) ?? new Set()).add(c.summaryGroupLabel!));
    }
    expect([...labels.values()].every((set) => set.size === 1)).toBe(true);
    // Only a tile of two or more sections carries a code (OD-101): a tile of one is the section's
    // own, and follows its name.
    expect([...labels.keys()]).toEqual(['DEVELOPMENT']);
    for (const [code, members] of [...labels.keys()].map((k) => [k, SEED_ACTIVITY_CATEGORIES.filter((c) => c.summaryGroupCode === k)] as const)) {
      expect({ code, members: members.length }).toEqual({ code, members: 2 });
    }
  });
});

/*
 * **The platform's Default template in Bahasa Indonesia** (P18.10-T7; OD-238, option 1; ADR-0179 §5). The words every
 * new office starts with, pinned word for word: *Recruitment*, *Follow-up* and *AAJI* kept English by the approved
 * glossary (§A.6, §C11), *Dibayar dan diterbitkan* and *Agen aktif baru* its §B.10 words. The English recorded for
 * migration 0046 is exactly what changed — a code the seed no longer has, or a word it never changed, fails here.
 */
describe('P18.10-T7 the seeded taxonomy and pipelines in Bahasa Indonesia (OD-238)', () => {
  it('names the five sections and the Development tile in Bahasa Indonesia', () => {
    expect(SEED_ACTIVITY_CATEGORIES.map((c) => [c.label, c.summaryGroupLabel])).toEqual([
      ['Pencarian leads', null],
      ['Penjualan', null],
      ['Recruitment', null],
      ['Pengembangan diri', 'Pengembangan'],
      ['Pengembangan tim', 'Pengembangan'],
    ]);
    for (const [code, was] of Object.entries(SEEDED_ACTIVITY_WORDINGS_BEFORE_OD_238.categories)) {
      const now = SEED_ACTIVITY_CATEGORIES.find((c) => c.code === code)!;
      expect(now.label).not.toBe(was.label);
      // A tile's English is recorded only where it had one, and the Indonesian is not it.
      expect(now.summaryGroupLabel === (was.summaryGroupLabel ?? null)).toBe(now.summaryGroupLabel === null);
    }
    expect(Object.keys(SEEDED_ACTIVITY_WORDINGS_BEFORE_OD_238.types)).toEqual(['DEV_TRAINING_ATTEND']);
  });

  it('names the twelve statuses in Bahasa Indonesia, both first ones alike, and records the English of every one it changed', () => {
    expect(SEED_LEAD_STATUSES.map((s) => [s.pipeline, s.code, s.label])).toEqual([
      ['sales', 'NOT_YET_APPROACHED', 'Belum didekati'],
      ['sales', 'FOLLOW_UP', 'Follow-up'],
      ['sales', 'POLICY_SUBMITTED', 'Polis diajukan'],
      ['sales', 'APPROVED_NOT_PAID', 'Disetujui, belum dibayar'],
      ['sales', 'PAID_AND_ISSUED', 'Dibayar dan diterbitkan'],
      ['recruitment', 'NOT_APPROACHED', 'Belum didekati'],
      ['recruitment', 'MEETING_SCHEDULED', 'Pertemuan dijadwalkan'],
      ['recruitment', 'RECRUITMENT_PRESENTATION', 'Presentasi recruitment'],
      ['recruitment', 'AGENT_CODE_CREATED', 'Kode agen dibuat'],
      ['recruitment', 'AAJI_LICENSED', 'Berlisensi AAJI'],
      ['recruitment', 'JOINT_FIELD_WORK_PLANNED', 'Joint field work direncanakan'],
      ['recruitment', 'NEW_ACTIVE_AGENT', 'Agen aktif baru'],
    ]);
    // Recorded exactly where the words changed: *Follow-up* is kept, so it is the one status with no English recorded.
    expect(SEED_LEAD_STATUSES.filter((s) => englishStatus(s) === s.label).map((s) => s.code)).toEqual(['FOLLOW_UP']);
    for (const [pipeline, codes] of Object.entries(SEEDED_LEAD_STATUS_LABELS_BEFORE_OD_238)) {
      for (const code of Object.keys(codes)) {
        expect(SEED_LEAD_STATUSES.some((s) => s.pipeline === pipeline && s.code === code)).toBe(true);
      }
    }
  });
});

/*
 * **`metrics-and-definitions.md` Part 0 says what the seed gives** (P18.10-T7): its table of the twelve, read rather than
 * retyped, names each item by the seed's label (a note may follow it) and its section by the seed's section. The row
 * for item 10 changed with §C1, and the sections with OD-238: the document and the seed move together, or this fails.
 */
describe('P18.10-T7 metrics-and-definitions.md’s activity table against the seed', () => {
  const doc = readFileSync(join(__dirname, '../../../../docs/00-product/metrics-and-definitions.md'), 'utf8');
  const rows = [...doc.matchAll(/^\| (\d+) \| `([A-Z_]+)` \| (.+?) \| [^|]+ \| ([^|]+) \|$/gm)]
    .map(([, num, code, label, category]) => ({ num: Number(num), code, label, category: category.trim() }))
    .filter((r) => SEED_ACTIVITY_TYPES.some((t) => t.code === r.code));

  it('lists the twelve, each by the seed’s label in its seed section — item 10 naming no company', () => {
    expect(rows.map((r) => r.code)).toEqual(SEED_ACTIVITY_TYPES.map((t) => t.code));
    for (const type of SEED_ACTIVITY_TYPES) {
      const row = rows.find((r) => r.code === type.code)!;
      const section = SEED_ACTIVITY_CATEGORIES.find((c) => c.code === type.categoryCode)!.label;
      expect({ code: type.code, startsWithLabel: row.label.startsWith(type.label), category: row.category })
        .toEqual({ code: type.code, startsWithLabel: true, category: section });
    }
    expect(rows.find((r) => r.code === 'DEV_TRAINING_ATTEND')!.label)
      .toMatch(/^Menghadiri meeting atau training dari KPM atau perusahaan — /);
  });
});

/**
 * **The activity types' *Nama singkat*** (P19.8-T4, ADR-0229 §5): the owner's approved words of 7 November 2026 (MOB
 * UI-180; `revisions/2026-11-09/`, the *Aktivitas* mockup's table), by code — pinned here word for word, as the
 * Indonesian labels are — and the bound an office's and a template's writes refuse past.
 */
describe('P19.8-T4 AC-13 MOB UI-180 the short names', () => {
  it('P19.8-T4 AC-13 MOB UI-180 holds the bound at 20 characters', () => {
    expect(ACTIVITY_TEXT.SHORT_LABEL_MAX).toBe(20);
  });

  it('P19.8-T4 AC-13 MOB UI-180 seeds the twelve by code with the approved words, each within the bound', () => {
    expect(Object.fromEntries(SEED_ACTIVITY_TYPES.map((t) => [t.code, t.shortLabel]))).toEqual({
      LEADS_GEN_ACTIVITY: 'Leads generation',
      LEADS_NEW_PROSPECT: 'Prospek baru',
      LEADS_CONTACTED: 'Set appointment',
      SELL_PRESENTATION: 'Presentasi',
      SELL_FOLLOWUP: 'Follow up',
      SELL_SUBMISSION: 'Submission polis',
      RECRUIT_PRESENTATION: 'Presentasi rekrut',
      RECRUIT_FOLLOWUP: 'Follow up rekrut',
      RECRUIT_AGENT_CODE: 'Proses NPA',
      DEV_TRAINING_ATTEND: 'Meeting / training',
      DEV_COACHING_RECEIVED: '1-on-1 dgn leader',
      DEV_TEAM_ACTIVITY: 'Team development',
    });
    for (const t of SEED_ACTIVITY_TYPES) expect(t.shortLabel!.length).toBeLessThanOrEqual(ACTIVITY_TEXT.SHORT_LABEL_MAX);
  });
});
