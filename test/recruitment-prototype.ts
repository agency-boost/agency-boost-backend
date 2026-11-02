import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

/**
 * **`AgencyBoost_Recruitment_Section.html`, read rather than retyped** (Phase 17).
 *
 * The constants spec pins every code, label, slot, checklist item and playbook string against the file,
 * and exit test 3 compares the plan with a port of the file's own `renderPlan` — so both read the
 * prototype's objects out of its `<script>`, evaluated in an empty context, and its chips out of its
 * markup. A transcription somebody typed by hand is a transcription that drifts from the file it copies.
 */
const FILE = join(__dirname, '../../prototype/AgencyBoost_Recruitment_Section.html');

export const PROTOTYPE_HTML = readFileSync(FILE, 'utf8');

/** One `const NAME = …;` of the prototype's script, evaluated on its own. */
function literal<T>(name: string): T {
  const start = PROTOTYPE_HTML.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`${name} is not in the prototype.`);
  const from = PROTOTYPE_HTML.indexOf('=', start) + 1;
  let depth = 0;
  let quote: string | null = null;
  let i = from;
  for (; i < PROTOTYPE_HTML.length; i += 1) {
    const c = PROTOTYPE_HTML[i];
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === '\'' || c === '`') quote = c;
    else if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') depth -= 1;
    else if (c === ';' && depth === 0) break;
  }
  return runInNewContext(`(${PROTOTYPE_HTML.slice(from, i)})`) as T;
}

export interface PrototypeProfile {
  label: string;
  tagline: string;
  bestFor: string;
  benefits: string[];
  openings: Record<string, string>;
}
export interface PrototypeObjection { says: string; reply: string }
export interface PrototypeSlot {
  id: string;
  title: string;
  desc: string;
  checklist?: { id: string; label: string }[];
}

export const PROTOTYPE = {
  PROFILES: literal<Record<string, PrototypeProfile>>('PROFILES'),
  OBJECTIONS: literal<Record<string, PrototypeObjection>>('OBJECTIONS'),
  OBJECTION_OVERRIDES: literal<Record<string, Record<string, PrototypeObjection>>>('OBJECTION_OVERRIDES'),
  CLOSING: literal<string>('CLOSING'),
  SLOTS: literal<PrototypeSlot[]>('SLOTS'),
};

/** One question's chips, `data-val` and text, in the order drawn (`:302-331`). */
export function prototypeChips(question: 'type' | 'motivation' | 'hesitation'): { code: string; label: string }[] {
  const start = PROTOTYPE_HTML.indexOf(`data-q="${question}"`);
  const block = PROTOTYPE_HTML.slice(start, PROTOTYPE_HTML.indexOf('</div>', start));
  return [...block.matchAll(/data-val="([^"]+)">([^<]+)<\/button>/g)].map((m) => ({ code: m[1], label: m[2] }));
}

/**
 * **The client's shorter chip words** (ADR-0167; the client's UI review of 2026-10-26, UI-015; P18.95-T6 AC-2;
 * parity I-421), typed here as the client gave them, by the prototype's `data-val`: the one place the shipped
 * vocabulary departs from the file. Every other chip keeps the prototype's text.
 */
export const CLIENT_CHIP_WORDS: Readonly<Record<string, string>> = {
  'side-income': 'Side income',
  'full-career': 'Career change',
  flexibility: 'Flexibility',
  leadership: 'Lead a team',
  'no-experience': 'No sales exp.',
  reputation: 'Bad reputation',
  'no-network': 'No network',
};

/** One question's chips as they ship: the prototype's, with the client's shorter words where it gave one. */
export function shippedChips(question: 'type' | 'motivation' | 'hesitation'): { code: string; label: string }[] {
  return prototypeChips(question).map(({ code, label }) => ({ code, label: CLIENT_CHIP_WORDS[code] ?? label }));
}

/** The words of the plan a playbook in the prototype's own shapes renders. */
export interface PrototypeWords {
  PROFILES: Record<string, PrototypeProfile>;
  OBJECTIONS: Record<string, PrototypeObjection>;
  OBJECTION_OVERRIDES: Record<string, Record<string, PrototypeObjection>>;
  CLOSING: string;
}

/** What `renderPlan` draws, block by block, in the order it draws it. */
export interface RenderedPlan {
  tag: string;
  heading: string;
  tagline: string;
  pill: string;
  goodFitFor: string;
  openingsLabel: string;
  openings: { tag: string | null; line: string }[];
  benefits: string[];
  objections: { says: string; reply: string }[];
  nextAction: string;
}

/**
 * **A port of `renderPlan`** (`:565-621`), statement for statement, over a playbook in the prototype's
 * shapes — the HTML template replaced by the values it interpolates, so a test can compare them.
 *
 * A motivation's tag is its chip's label, as `renderPlan` reads it from the chip — the chip **as it ships**
 * (`shippedChips`), so the client's shorter words tag an opening as they label its chip (P18.95-T6 AC-2).
 */
export function renderPlanPort(
  words: PrototypeWords,
  state: { type: string; motivation: string[]; hesitation: string[] },
): RenderedPlan {
  const labelFor = (q: 'motivation', val: string) => shippedChips(q).find((c) => c.code === val)!.label;
  const profile = words.PROFILES[state.type];
  const multiMotivation = state.motivation.length > 1;
  const openings = state.motivation.map((m) => ({
    tag: multiMotivation ? labelFor('motivation', m) : null,
    line: profile.openings[m],
  }));
  const objections = state.hesitation.map((h) => {
    const objection = (words.OBJECTION_OVERRIDES[state.type] && words.OBJECTION_OVERRIDES[state.type][h])
      || words.OBJECTIONS[h];
    return { says: objection.says, reply: objection.reply };
  });
  return {
    tag: 'Candidate profile',
    heading: profile.label,
    tagline: profile.tagline,
    pill: 'Plan ready',
    goodFitFor: profile.bestFor,
    openingsLabel: `Opening line${multiMotivation ? 's' : ''}`,
    openings,
    benefits: [...profile.benefits],
    objections,
    nextAction: words.CLOSING,
  };
}

/**
 * The chips a brief selects, **in the chips' order** (`:521`): `Array.from(group.querySelectorAll(
 * '.chip.selected'))` reads the DOM in document order, whatever order they were clicked in.
 */
export function inChipOrder(question: 'motivation' | 'hesitation', chosen: readonly string[]): string[] {
  return prototypeChips(question).map((c) => c.code).filter((code) => chosen.includes(code));
}

/** Every non-empty subset of a list, each in the list's order: 2ⁿ − 1 of them. */
export function nonEmptySubsets<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let mask = 1; mask < 1 << items.length; mask += 1) {
    out.push(items.filter((_, i) => (mask & (1 << i)) !== 0));
  }
  return out;
}
