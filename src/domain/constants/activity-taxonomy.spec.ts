import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SEED_ACTIVITY_CATEGORIES, SEED_ACTIVITY_TYPES, SEED_LEAD_STATUSES, SEED_RATIO_DEFINITIONS,
} from './activity-taxonomy';

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

  it('carries the same twelve labels, verbatim', () => {
    expect(SEED_ACTIVITY_TYPES.map((t) => t.label)).toEqual(items.map((i) => i.title));
  });

  it('carries the same descriptions, including the four that exist', () => {
    expect(SEED_ACTIVITY_TYPES.map((t) => t.description ?? null))
      .toEqual(items.map((i) => i.description));
    // Four, not three: this is the assertion that was failing in production data.
    expect(items.filter((i) => i.description)).toHaveLength(4);
  });

  it('keeps display order 1–12 across five categories, in the prototype’s grouping', () => {
    expect(SEED_ACTIVITY_TYPES.map((t) => t.displayOrder)).toEqual(items.map((i) => i.num));

    const html = readFileSync(PROTOTYPE, 'utf8');
    const headings = [...html.matchAll(/<div class="acttype-card-head"><h3>([^<]+)<\/h3>/g)]
      .map((m) => m[1]);
    expect(SEED_ACTIVITY_CATEGORIES.map((c) => c.label)).toEqual(headings);
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
    expect(sales.map((l) => l.label)).toEqual(labelsIn('leadstatuses-sales'));
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
    expect(ours.map((l) => l.label)).toEqual(expect.arrayContaining(['Agent code created']));
    // The terminal stage is the one both agree on, and the one everything downstream reads.
    expect(ours.at(-1)!.label).toBe(theirs.at(-1));
    expect(ours.filter((l) => l.isTerminal).map((l) => l.label)).toEqual(['New active agent']);
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

  it('carries the five, with the benchmarks the prototype shows', () => {
    const shown = [...html.matchAll(/class="ratio-benchmark-input" value="([\d.]+)"/g)]
      .map((m) => Number(m[1]));
    expect(shown).toEqual([30, 15.0, 15.0, 0.30, 1.50]);

    // The prototype writes the two success rates as whole percents and multiplies by 100
    // on display (`× 100` in its own builder); the domain stores the proportion.
    expect(SEED_RATIO_DEFINITIONS.map((r) => r.benchmark)).toEqual([30, 0.15, 0.15, 0.30, 1.50]);
  });

  it('names them the way the prototype’s rows do', () => {
    const rows = [...html.matchAll(/<div class="cfg-label">([^<\n]+)\n\s*<div id="ratio-builder-/g)]
      .map((m) => m[1].trim());
    expect(rows).toEqual([
      'Selling vs Recruitment balance',
      'Selling success rate',
      'Recruitment success rate',
      'Leads per activity',
      'Meeting per approach',
    ]);
    // Ours drops the trailing "balance", which is the only label divergence and is
    // registered in `prototype-parity.md`.
    expect(SEED_RATIO_DEFINITIONS.map((r) => r.label)).toEqual([
      'Selling vs Recruitment',
      'Selling success rate',
      'Recruitment success rate',
      'Leads per activity',
      'Meeting per approach',
    ]);
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
      const tile = tiles.get(key) ?? { label: category.summaryGroupLabel ?? category.label, items: [] };
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
