import { ILLUSTRATION, PROPOSAL, PROPOSAL_TEXT_MAX, type PdfDetailBlockKind } from '@/domain/constants';
import { checkFormula, evaluateFormula } from '@/modules/products/proposal-formula';
import type { EvidenceReading, IllustrationReading } from './ai/reading-schema';
import { exactAsWritten, minorUnitsOf } from './intake-numbers';
import type { IllustrationBlock, IllustrationCheck, IllustrationRow } from './illustration.schema';

/**
 * **The illustration's blocks, and every formula checked by our own code** (P19.15-T2 AC-1, AC-2; ADR-0259 §8).
 *
 * The model proposes each amount as a formula of the agent's inputs and points at two numbers the illustration prints
 * for it. This file reads those numbers exactly as written (`intake-numbers.ts`), evaluates the formula for the
 * illustration's own inputs with the product's evaluator — the one the PDF prints with (`proposal-formula.ts`, no
 * `eval`) — and compares: **within Rp1 both times is `match`; any difference is `mismatch`, flagged, never corrected;
 * fewer than two numbers is `unchecked`**. A formula naming an input the product has not, or unreadable, is `mismatch`.
 */

/** The bounds a block keeps to, the product's own (`proposal-fields.ts`): rows, label and note lengths. */
const ROWS_MAX: Readonly<Record<PdfDetailBlockKind, number>> = {
  manfaat: ILLUSTRATION.BENEFITS_MAX,
  jadwal: PROPOSAL.PDF_DETAIL_ROWS_MAX,
  masa: 2,
  pengecualian: ILLUSTRATION.EXCLUSIONS_MAX,
  nilai_tunai: ILLUSTRATION.CASH_VALUE_YEARS_MAX,
};

/** An evidence's inputs and printed amount in minor units, kept when each reads exactly; else left out. */
function evidenceOf(e: EvidenceReading, samples: Record<string, number>): IllustrationRow['evidence'][number] | null {
  if (!e.printed.certain) return null;
  const printed = exactAsWritten(e.printed.asWritten, e.printed.value);
  const printedMinor = printed ? minorUnitsOf(printed) : null;
  if (printedMinor === null) return null;
  const inputs: Record<string, number> = { ...samples };
  for (const input of e.inputs) {
    if (!input.value.certain) return null;
    const exact = exactAsWritten(input.value.asWritten, input.value.value);
    const minor = exact ? minorUnitsOf(exact) : null;
    if (minor === null) return null;
    inputs[input.name] = minor;
  }
  return { page: e.page, printedMinor, inputs };
}

/** **One formula checked** against the evidence kept for its row. */
export function checkRow(formula: string | null, evidence: IllustrationRow['evidence'], names: readonly string[]): IllustrationCheck | null {
  if (!formula) return null;
  const problem = checkFormula(formula, names);
  if (problem) return { state: 'mismatch', reason: problem.kind === 'name' ? 'name' : 'grammar', samples: [] };
  const samples = evidence.slice(0, ILLUSTRATION.CHECK_SAMPLES).map((e) => {
    const computed = evaluateFormula(formula, e.inputs);
    return {
      page: e.page,
      inputs: e.inputs,
      printedMinor: e.printedMinor,
      computedMinor: computed,
      match: computed !== null && Math.abs(computed - e.printedMinor) <= ILLUSTRATION.CHECK_TOLERANCE_MINOR,
    };
  });
  if (samples.some((s) => !s.match)) return { state: 'mismatch', reason: 'differs', samples };
  if (samples.length < ILLUSTRATION.CHECK_SAMPLES) return { state: 'unchecked', reason: 'few_samples', samples };
  return { state: 'match', reason: null, samples };
}

const clip = (s: string | null, max: number) => (s === null ? null : s.replace(/\s+/g, ' ').trim().slice(0, max) || null);

/** **The reading, as blocks to edit**: each kind once, its rows bounded, every formula checked. */
export function blocksOf(
  reading: IllustrationReading, names: readonly string[], newId: () => string,
): { blocks: IllustrationBlock[]; samples: Record<string, number> } {
  const samples: Record<string, number> = {};
  for (const s of reading.sampleInputs) {
    if (!s.value.certain || !names.includes(s.name)) continue;
    const exact = exactAsWritten(s.value.asWritten, s.value.value);
    const minor = exact ? minorUnitsOf(exact) : null;
    if (minor !== null) samples[s.name] = minor;
  }
  const blocks: IllustrationBlock[] = [];
  for (const b of reading.blocks) {
    if (blocks.some((x) => x.block === b.block)) continue;
    const rows: IllustrationRow[] = b.rows.slice(0, ROWS_MAX[b.block]).map((r) => {
      const formula = clip(r.formula, PROPOSAL.FORMULA_MAX_LENGTH);
      const text = formula ? null : clip(r.text, PROPOSAL_TEXT_MAX.DETAIL_LABEL);
      const evidence = r.evidence.map((e) => evidenceOf(e, samples)).filter((e): e is NonNullable<typeof e> => e !== null);
      return {
        id: newId(),
        label: clip(r.label, PROPOSAL_TEXT_MAX.DETAIL_LABEL) ?? '',
        note: clip(r.note, PROPOSAL_TEXT_MAX.DETAIL_NOTE),
        formula,
        // An exclusion is its label; a row with neither formula nor text says its label alone.
        text: formula === null && text === null ? (b.block === 'pengecualian' ? 'Tidak ditanggung' : null) : text,
        page: r.page,
        evidence,
        check: checkRow(formula, evidence, names),
      };
    }).filter((r) => r.label && (r.formula !== null || r.text !== null));
    if (rows.length) blocks.push({ block: b.block, page: b.page ?? rows[0].page, rows });
  }
  const order = ['manfaat', 'jadwal', 'masa', 'pengecualian', 'nilai_tunai'];
  blocks.sort((a, b) => order.indexOf(a.block) - order.indexOf(b.block));
  return { blocks, samples };
}

/** The rows whose formula does not match: what keeps an illustration from being published. */
export function mismatches(blocks: readonly IllustrationBlock[]): { block: PdfDetailBlockKind; row: number }[] {
  const out: { block: PdfDetailBlockKind; row: number }[] = [];
  for (const b of blocks) b.rows.forEach((r, i) => { if (r.check?.state === 'mismatch') out.push({ block: b.block, row: i }); });
  return out;
}
