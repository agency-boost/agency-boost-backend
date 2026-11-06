import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROPOSAL } from '@/domain/constants';
import { checkFormula, evaluateFormula, parseFormula } from './proposal-formula';

/**
 * **P19.7-T1 AC-3 — a `pdfDetail` row's formula** (ADR-0225 §4): our own grammar and nothing else, names held to the
 * product's own money keys, worked out exactly in minor units and rounded half up, and *–* (`null`) — never zero —
 * where a value is missing or a division by zero.
 */
describe('P19.7-T1 AC-3 the proposal formula (proposal-formula.ts)', () => {
  const money = { up: 1_000_000_000_00, target_dana: 250_000_000_00 };

  it('P19.7-T1 AC-3 reads the spec’s own examples: `2 × up`, `5% × target_dana`', () => {
    expect(evaluateFormula('2 × up', money)).toBe(2_000_000_000_00);
    expect(evaluateFormula('5% × target_dana', money)).toBe(12_500_000_00);
    expect(evaluateFormula('200% * up', money)).toBe(2_000_000_000_00);
  });

  it('P19.7-T1 AC-3 takes a decimal comma or point, −, /, + and brackets, with the usual precedence', () => {
    expect(evaluateFormula('2,5 × up', money)).toBe(2_500_000_000_00);
    expect(evaluateFormula('2.5 × up', money)).toBe(2_500_000_000_00);
    expect(evaluateFormula('up − target_dana', money)).toBe(750_000_000_00);
    expect(evaluateFormula('up - target_dana / 2', money)).toBe(875_000_000_00);
    expect(evaluateFormula('(up - target_dana) / 2', money)).toBe(375_000_000_00);
    expect(evaluateFormula('-up + 2 * up', money)).toBe(1_000_000_000_00);
    expect(evaluateFormula('10%%  × up', money)).toBe(1_000_000_00);
  });

  it('P19.7-T1 AC-3 works exactly in minor units and rounds half up to one', () => {
    expect(evaluateFormula('x / 3', { x: 100 })).toBe(33);
    expect(evaluateFormula('x / 2', { x: 5 })).toBe(3); // 2.5 → 3
    expect(evaluateFormula('x / 4', { x: 5 })).toBe(1); // 1.25 → 1
    expect(evaluateFormula('-x / 2', { x: 5 })).toBe(-2); // -2.5 → -2, half up
    // No binary floating point: 0.1 + 0.2 of a sum is exactly 0.3 of it.
    expect(evaluateFormula('0,1 × x + 0,2 × x', { x: 10 })).toBe(3);
    expect(evaluateFormula('7% × x', { x: 100 })).toBe(7);
  });

  it('P19.7-T1 AC-3 gives no number — never zero — for a value left empty or a division by zero', () => {
    expect(evaluateFormula('2 × up', {})).toBeNull();
    expect(evaluateFormula('2 × up', { up: null })).toBeNull();
    expect(evaluateFormula('up / (target_dana - target_dana)', money)).toBeNull();
    expect(evaluateFormula('up / 0', money)).toBeNull();
    expect(evaluateFormula('2 × ', money)).toBeNull();
  });

  it.each([
    ['2 ** up'], ['up ^ 2'], ['Math.max(up)'], ['up up'], ['2 3'], ['()'], ['(up'], ['up)'], ['1.000.000 × up'],
    ['UP × 2'], ['up; drop'], ['up == 1'], ['`up`'], ['alert(1)'], ['constructor'], ['up.toString()'], [''], ['   '],
    ['2 × $up'], ['up × 2,'],
  ])('P19.7-T1 AC-3 refuses anything outside the grammar: %p', (source) => {
    const parsed = parseFormula(source);
    const named = parsed.ok ? checkFormula(source, ['up']) : null;
    // Either the grammar refuses it, or it parses only as a name that is not a money key (`alert`, `constructor`).
    expect(parsed.ok ? named : parsed.problem).not.toBeNull();
  });

  it('P19.7-T1 AC-3 refuses a formula longer than PROPOSAL.FORMULA_MAX_LENGTH (120)', () => {
    expect(PROPOSAL.FORMULA_MAX_LENGTH).toBe(120);
    const long = Array.from({ length: 41 }, () => 'up').join('+');
    expect(long.length).toBeGreaterThan(120);
    expect(parseFormula(long)).toMatchObject({ ok: false, problem: { kind: 'grammar' } });
    expect(parseFormula('up + '.repeat(23) + 'up').ok).toBe(true);
  });

  it('P19.7-T1 AC-3 names only the product’s own money keys: another key, an unknown one or a chips key is refused by name', () => {
    expect(checkFormula('2 × up + 5% × target_dana', ['up', 'target_dana'])).toBeNull();
    expect(checkFormula('2 × santunan', ['up'])).toEqual({ kind: 'name', name: 'santunan' });
    expect(checkFormula('2 × plan', ['up'])).toEqual({ kind: 'name', name: 'plan' });
    expect(checkFormula('2 × up', [])).toEqual({ kind: 'name', name: 'up' });
  });

  it('P19.7-T1 AC-3 is never eval or Function: the module’s source holds neither', () => {
    const source = fs.readFileSync(path.join(__dirname, 'proposal-formula.ts'), 'utf8')
      .replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/\bnew\s+Function\b|\bFunction\s*\(/);
  });
});
