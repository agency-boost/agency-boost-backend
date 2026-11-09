import { PROPOSAL } from '@/domain/constants';

/**
 * **A `pdfDetail` row's value formula** (P19.7-T1 AC-3; ADR-0225 §4): `2 × up`, `5% × target_dana`, `(up + 50.000) / 2`.
 *
 * **Parsed by this small parser of our own, never `eval` or `Function`.** The grammar is all it accepts:
 *
 * ```
 * expr    := term (('+' | '-' | '−') term)*
 * term    := unary (('*' | '×' | '/') unary)*
 * unary   := ('-' | '−')? postfix
 * postfix := primary '%'*
 * primary := number | name | '(' expr ')'
 * number  := digits ((',' | '.') digits)?      a decimal mark, never a thousands separator
 * name    := [a-z][a-z0-9_]*                   a money field's key of the same product
 * ```
 *
 * at most `PROPOSAL.FORMULA_MAX_LENGTH` (120) characters. Anything else — a letter in capitals, `**`, `^`, a function
 * call, two numbers side by side, an empty bracket — is refused where it stops being readable.
 *
 * **Worked out exactly** ({@link evaluateFormula}): every value a fraction of two big integers, a money field's value
 * its integer minor units, `n%` the fraction `n/100`, and the result rounded half up to one minor unit. A value left
 * empty, or a division by zero, gives **no number** (`null`) — the PDF writes *–*, never zero (ADR-0223 §4).
 */

export type Formula =
  | { kind: 'number'; value: Fraction }
  | { kind: 'name'; name: string }
  | { kind: 'percent'; of: Formula }
  | { kind: 'negate'; of: Formula }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: Formula; right: Formula };

/** An exact value: `n / d`, `d` positive. */
interface Fraction { n: bigint; d: bigint }

/** Why a formula was refused: where it stopped being readable, or the name that is not a money field of the product. */
export type FormulaProblem =
  | { kind: 'grammar'; at: string }
  | { kind: 'name'; name: string };

type Token =
  | { t: 'num'; value: Fraction; text: string }
  | { t: 'name'; name: string }
  | { t: 'op'; op: '+' | '-' | '*' | '/' | '%' | '(' | ')'; text: string };

const OPS: Readonly<Record<string, '+' | '-' | '*' | '/' | '%' | '(' | ')'>> = {
  '+': '+', '-': '-', '−': '-', '*': '*', '×': '*', '/': '/', '%': '%', '(': '(', ')': ')',
};

class Refused extends Error {
  constructor(readonly problem: FormulaProblem) {
    super(problem.kind);
  }
}

/** The tokens of a formula, or the place it stops being readable. */
function tokens(source: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t') { i += 1; continue; }
    if (OPS[c]) { out.push({ t: 'op', op: OPS[c], text: c }); i += 1; continue; }
    const number = /^\d+(?:[.,]\d+)?/.exec(source.slice(i));
    if (number) {
      const text = number[0];
      // `1.000.000` is not a number: one decimal mark at most, and a digit after it.
      if (/^[.,]\d/.test(source.slice(i + text.length))) throw new Refused({ kind: 'grammar', at: source.slice(i) });
      out.push({ t: 'num', value: decimal(text), text });
      i += text.length;
      continue;
    }
    const name = /^[a-z][a-z0-9_]*/.exec(source.slice(i));
    if (name) { out.push({ t: 'name', name: name[0] }); i += name[0].length; continue; }
    throw new Refused({ kind: 'grammar', at: source.slice(i) });
  }
  return out;
}

/** `12,5` or `12.5` as the fraction `125/10`. */
function decimal(text: string): Fraction {
  const [whole, part = ''] = text.split(/[.,]/);
  return reduce({ n: BigInt(whole + part), d: 10n ** BigInt(part.length) });
}

/**
 * **Parse a formula** into its tree, or say why not. Pure: nothing is looked up, and no name is checked against a
 * product — {@link checkFormula} does that.
 */
export function parseFormula(source: string): { ok: true; formula: Formula; names: string[] } | { ok: false; problem: FormulaProblem } {
  try {
    if (source.trim() === '') throw new Refused({ kind: 'grammar', at: '' });
    if (source.length > PROPOSAL.FORMULA_MAX_LENGTH) {
      throw new Refused({ kind: 'grammar', at: source.slice(PROPOSAL.FORMULA_MAX_LENGTH) });
    }
    const list = tokens(source);
    let at = 0;
    const names: string[] = [];
    const rest = () => list.slice(at).map((tok) => (tok.t === 'name' ? tok.name : tok.text)).join(' ');
    const isOp = (op: string) => list[at]?.t === 'op' && (list[at] as { op: string }).op === op;

    const expr = (): Formula => {
      let left = term();
      while (isOp('+') || isOp('-')) {
        const op = (list[at] as { op: '+' | '-' }).op;
        at += 1;
        left = { kind: 'binary', op, left, right: term() };
      }
      return left;
    };
    const term = (): Formula => {
      let left = unary();
      while (isOp('*') || isOp('/')) {
        const op = (list[at] as { op: '*' | '/' }).op;
        at += 1;
        left = { kind: 'binary', op, left, right: unary() };
      }
      return left;
    };
    const unary = (): Formula => {
      if (isOp('-')) {
        at += 1;
        return { kind: 'negate', of: postfix() };
      }
      return postfix();
    };
    const postfix = (): Formula => {
      let value = primary();
      while (isOp('%')) {
        at += 1;
        value = { kind: 'percent', of: value };
      }
      return value;
    };
    const primary = (): Formula => {
      const tok = list[at];
      if (!tok) throw new Refused({ kind: 'grammar', at: '' });
      if (tok.t === 'num') { at += 1; return { kind: 'number', value: tok.value }; }
      if (tok.t === 'name') { at += 1; names.push(tok.name); return { kind: 'name', name: tok.name }; }
      if (tok.op === '(') {
        at += 1;
        const inner = expr();
        if (!isOp(')')) throw new Refused({ kind: 'grammar', at: rest() });
        at += 1;
        return inner;
      }
      throw new Refused({ kind: 'grammar', at: rest() });
    };

    const formula = expr();
    if (at !== list.length) throw new Refused({ kind: 'grammar', at: rest() });
    return { ok: true, formula, names };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, problem: err.problem };
    throw err;
  }
}

/**
 * **A formula as a save checks it** (ADR-0225 §4): readable by the grammar, and naming **only** the keys of the
 * product's own `money` fields — another product's key, an unknown key and a `chips` field's key are each refused by
 * name. `null` when it is fine.
 */
export function checkFormula(source: string, moneyKeys: readonly string[]): FormulaProblem | null {
  const parsed = parseFormula(source);
  if (!parsed.ok) return parsed.problem;
  const stranger = parsed.names.find((name) => !moneyKeys.includes(name));
  return stranger === undefined ? null : { kind: 'name', name: stranger };
}

function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  while (y !== 0n) [x, y] = [y, x % y];
  return x === 0n ? 1n : x;
}

function reduce(f: Fraction): Fraction {
  const g = gcd(f.n, f.d);
  const sign = f.d < 0n ? -1n : 1n;
  return { n: (sign * f.n) / g, d: (sign * f.d) / g };
}

/** The value of a tree, or `null` for a value left empty or a division by zero. */
function valueOf(node: Formula, values: Readonly<Record<string, number | null | undefined>>): Fraction | null {
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'name': {
      const v = values[node.name];
      if (v === null || v === undefined || !Number.isInteger(v)) return null;
      return { n: BigInt(v), d: 1n };
    }
    case 'percent': {
      const of = valueOf(node.of, values);
      return of && reduce({ n: of.n, d: of.d * 100n });
    }
    case 'negate': {
      const of = valueOf(node.of, values);
      return of && { n: -of.n, d: of.d };
    }
    case 'binary': {
      const [l, r] = [valueOf(node.left, values), valueOf(node.right, values)];
      if (!l || !r) return null;
      if (node.op === '+') return reduce({ n: l.n * r.d + r.n * l.d, d: l.d * r.d });
      if (node.op === '-') return reduce({ n: l.n * r.d - r.n * l.d, d: l.d * r.d });
      if (node.op === '*') return reduce({ n: l.n * r.n, d: l.d * r.d });
      if (r.n === 0n) return null;
      return reduce({ n: l.n * r.d, d: l.d * r.n });
    }
  }
}

/**
 * **A formula worked out** in integer minor units, from the money values an item holds (key → minor units), rounded
 * half up to one minor unit. `null` — written *–* — for a formula that cannot be read, a value left empty, or a
 * division by zero; never zero in their place.
 */
export function evaluateFormula(
  source: string, values: Readonly<Record<string, number | null | undefined>>,
): number | null {
  const parsed = parseFormula(source);
  if (!parsed.ok) return null;
  const result = valueOf(parsed.formula, values) ?? null;
  if (result === null) return null;
  // Half up: floor(n/d + 1/2) = floor((2n + d) / 2d), for a positive denominator.
  const twice = 2n * result.n + result.d;
  const denominator = 2n * result.d;
  const floor = twice >= 0n ? twice / denominator : -((-twice + denominator - 1n) / denominator);
  return Number(floor);
}
