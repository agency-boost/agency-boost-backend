/**
 * **An agent-code pattern, matched in linear time** (ADR-0214 §7; P19.5-T1 AC-11).
 *
 * A template's `agentCodePattern` is typed by a Super Admin and run over every registered agent code of every KPM on
 * the template, then over every row of every upload. JavaScript's own engine backtracks: `^(a+)+$` against thirty
 * `a`s and a `b` takes seconds, and the API would hang on one pattern somebody typed. So the pattern is compiled here,
 * by Thompson's construction, into an automaton that reads each code once and keeps a set of states — time
 * proportional to the pattern's size times the code's length, whatever the pattern is. Nothing it accepts can
 * backtrack, because nothing here backtracks.
 *
 * **What it reads** — the part of JavaScript's syntax a code format needs, with JavaScript's meaning:
 *
 * - literals, `.`, `\d \D \w \W \s \S`, `\t \n \r \f \v`, `\xHH`, `\uHHHH` and an escaped symbol (`\.`, `\-`);
 * - classes `[…]` and `[^…]`, with ranges and the class escapes;
 * - groups `( )`, `(?: )` and `(?<name> )`, and alternation `|`;
 * - `* + ?` and `{n}`, `{n,}`, `{n,m}`, each optionally lazy (a whole-code match makes laziness moot).
 *
 * **What it refuses**, each a reason the API says (`PatternProblem`): a pattern not anchored `^…$`, longer than
 * `ANALYTICS.CODE_PATTERN_MAX_LENGTH`, a back-reference (`\1`, `\k<…>`), a look-around (`(?=`, `(?!`, `(?<=`, `(?<!`),
 * a word boundary, anything else it cannot read, and a repetition so large its automaton would pass `MAX_STATES`.
 *
 * A pattern is matched against **the whole code**: `^` and `$` are where it starts and ends, and it is case-sensitive,
 * as a `RegExp` with no flags is.
 */

/** Why a pattern was refused. */
export type PatternProblem =
  | 'too_long'
  | 'not_anchored'
  | 'backreference'
  | 'lookaround'
  | 'unsupported'
  | 'syntax'
  | 'too_large';

/** A compiled pattern: `test` reads a code once. */
export interface LinearPattern {
  readonly source: string;
  test(code: string): boolean;
}

export type CompiledPattern = { ok: true; pattern: LinearPattern } | { ok: false; problem: PatternProblem };

/** The most states an automaton may have: `{n,m}` copies what it repeats, and this bounds the copies. */
export const MAX_STATES = 20_000;

// ------------------------------------------------------------------------------------------------ the syntax tree

type Ranges = ReadonlyArray<readonly [number, number]>;

/** A set of characters: ranges of UTF-16 code units, perhaps negated. */
interface CharSet {
  readonly ranges: Ranges;
  readonly negated: boolean;
}

type Node =
  | { kind: 'set'; items: readonly CharSet[]; negated: boolean }
  | { kind: 'alt'; options: readonly Node[][] }
  | { kind: 'repeat'; node: Node; min: number; max: number | null };

class Refused extends Error {
  constructor(readonly problem: PatternProblem) {
    super(problem);
  }
}

const DIGIT: Ranges = [[0x30, 0x39]];
const WORD: Ranges = [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]];
// JavaScript's `\s`: white space and line terminators.
const SPACE: Ranges = [
  [0x09, 0x0d], [0x20, 0x20], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f],
  [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff],
];
const LINE_TERMINATORS: Ranges = [[0x0a, 0x0a], [0x0d, 0x0d], [0x2028, 0x2029]];
const SYNTAX = new Set(['\\', '^', '$', '.', '|', '?', '*', '+', '(', ')', '[', ']', '{', '}', '/']);

const one = (code: number): CharSet => ({ ranges: [[code, code]], negated: false });
const setOf = (items: CharSet[], negated = false): Node => ({ kind: 'set', items, negated });

/** A recursive-descent reader of the pattern between its anchors. */
class Parser {
  private at = 0;

  constructor(private readonly text: string) {}

  parse(): Node {
    const node = this.alternation();
    if (this.at < this.text.length) throw new Refused('syntax');
    return node;
  }

  private peek(): string | undefined {
    return this.text[this.at];
  }

  private alternation(): Node {
    const options: Node[][] = [this.sequence()];
    while (this.peek() === '|') {
      this.at += 1;
      options.push(this.sequence());
    }
    return { kind: 'alt', options };
  }

  private sequence(): Node[] {
    const out: Node[] = [];
    for (let c = this.peek(); c !== undefined && c !== '|' && c !== ')'; c = this.peek()) {
      out.push(this.quantified(this.atom()));
    }
    return out;
  }

  private quantified(node: Node): Node {
    let out = node;
    for (;;) {
      const c = this.peek();
      let min: number;
      let max: number | null;
      if (c === '*') { min = 0; max = null; this.at += 1; }
      else if (c === '+') { min = 1; max = null; this.at += 1; }
      else if (c === '?') { min = 0; max = 1; this.at += 1; }
      else if (c === '{') {
        const m = /^\{(\d{1,4})(,(\d{0,4}))?\}/.exec(this.text.slice(this.at));
        if (!m) throw new Refused('syntax');
        min = Number(m[1]);
        max = m[2] === undefined ? min : m[3] === '' ? null : Number(m[3]);
        if (max !== null && max < min) throw new Refused('syntax');
        this.at += m[0].length;
      } else return out;
      // A lazy quantifier matches the same whole codes as a greedy one.
      if (this.peek() === '?') this.at += 1;
      out = { kind: 'repeat', node: out, min, max };
      // `a**` is a syntax error in JavaScript, as a quantifier on a quantifier.
      const next = this.peek();
      if (next === '*' || next === '+' || next === '?' || next === '{') throw new Refused('syntax');
    }
  }

  private atom(): Node {
    const c = this.peek()!;
    switch (c) {
      case '(': return this.group();
      case '[': return this.charClass();
      case '.':
        this.at += 1;
        return setOf([{ ranges: LINE_TERMINATORS, negated: true }]);
      case '\\': {
        this.at += 1;
        return setOf([this.escape(false)]);
      }
      // An anchor inside the pattern, a stray quantifier or a stray closer: not a code format. (A stray `)` never
      // reaches here: `sequence` stops at it, and `parse` refuses what is left.)
      case '^': case '$': throw new Refused('unsupported');
      case '*': case '+': case '?': case '{': case '}': case ']':
        throw new Refused('syntax');
      default:
        this.at += 1;
        return setOf([one(c.charCodeAt(0))]);
    }
  }

  private group(): Node {
    this.at += 1; // (
    const rest = this.text.slice(this.at);
    if (rest.startsWith('?=') || rest.startsWith('?!') || rest.startsWith('?<=') || rest.startsWith('?<!')) {
      throw new Refused('lookaround');
    }
    if (rest.startsWith('?:')) this.at += 2;
    else if (rest.startsWith('?<')) {
      const m = /^\?<[A-Za-z_$][\w$]*>/.exec(rest);
      if (!m) throw new Refused('syntax');
      this.at += m[0].length;
    } else if (rest.startsWith('?')) throw new Refused('syntax');
    const inner = this.alternation();
    if (this.peek() !== ')') throw new Refused('syntax');
    this.at += 1;
    return inner;
  }

  private charClass(): Node {
    this.at += 1; // [
    let negated = false;
    if (this.peek() === '^') {
      negated = true;
      this.at += 1;
    }
    const items: CharSet[] = [];
    for (;;) {
      const c = this.peek();
      if (c === undefined) throw new Refused('syntax');
      if (c === ']') {
        this.at += 1;
        return setOf(items, negated);
      }
      const from = this.classAtom();
      // A range: `a-z`. A `-` first, last, or beside a class escape is itself.
      if (this.peek() === '-' && this.text[this.at + 1] !== undefined && this.text[this.at + 1] !== ']') {
        const lo = single(from);
        this.at += 1;
        const to = this.classAtom();
        const hi = single(to);
        if (lo === null || hi === null) throw new Refused('syntax');
        if (hi < lo) throw new Refused('syntax');
        items.push({ ranges: [[lo, hi]], negated: false });
      } else {
        items.push(from);
      }
    }
  }

  private classAtom(): CharSet {
    const c = this.peek()!;
    this.at += 1;
    if (c !== '\\') return one(c.charCodeAt(0));
    return this.escape(true);
  }

  /** After a `\`. */
  private escape(inClass: boolean): CharSet {
    const c = this.peek();
    if (c === undefined) throw new Refused('syntax');
    this.at += 1;
    switch (c) {
      case 'd': return { ranges: DIGIT, negated: false };
      case 'D': return { ranges: DIGIT, negated: true };
      case 'w': return { ranges: WORD, negated: false };
      case 'W': return { ranges: WORD, negated: true };
      case 's': return { ranges: SPACE, negated: false };
      case 'S': return { ranges: SPACE, negated: true };
      case 't': return one(0x09);
      case 'n': return one(0x0a);
      case 'r': return one(0x0d);
      case 'f': return one(0x0c);
      case 'v': return one(0x0b);
      case '0':
        if (/\d/.test(this.peek() ?? '')) throw new Refused('backreference');
        return one(0);
      case 'x': return one(this.hex(2));
      case 'u': return one(this.hex(4));
      case 'k': throw new Refused('backreference');
      case 'b': case 'B':
        // A word boundary outside a class is an assertion; inside one `\b` is a backspace.
        if (inClass && c === 'b') return one(0x08);
        throw new Refused('unsupported');
      case '-':
        return one(0x2d);
      default:
        if (/[1-9]/.test(c)) throw new Refused('backreference');
        if (SYNTAX.has(c)) return one(c.charCodeAt(0));
        throw new Refused('syntax');
    }
  }

  private hex(digits: number): number {
    const m = new RegExp(`^[0-9A-Fa-f]{${digits}}`).exec(this.text.slice(this.at));
    if (!m) throw new Refused('syntax');
    this.at += digits;
    return parseInt(m[0], 16);
  }
}

/** The one code unit a class atom names, or `null` for a class escape (which cannot bound a range). */
function single(set: CharSet): number | null {
  if (set.negated || set.ranges.length !== 1) return null;
  const [lo, hi] = set.ranges[0];
  return lo === hi ? lo : null;
}

// --------------------------------------------------------------------------------------------- the automaton

/** A state: reads one character into `next`, splits into two, or accepts. */
type State =
  | { kind: 'read'; node: Extract<Node, { kind: 'set' }>; next: number }
  | { kind: 'split'; a: number; b: number }
  | { kind: 'match' };

/** A fragment under construction: its start, and the dangling exits to patch. */
interface Fragment {
  start: number;
  /** `[state, field]` pairs still pointing nowhere (`-1`). */
  exits: Array<[number, 'next' | 'a' | 'b']>;
}

class Builder {
  readonly states: State[] = [];

  private add(state: State): number {
    if (this.states.length >= MAX_STATES) throw new Refused('too_large');
    this.states.push(state);
    return this.states.length - 1;
  }

  private patch(exits: Fragment['exits'], to: number): void {
    for (const [index, field] of exits) {
      const state = this.states[index] as Record<string, unknown>;
      state[field] = to;
    }
  }

  /** An empty fragment: one split whose both exits dangle, used where a sequence or an option is empty. */
  private empty(): Fragment {
    const s = this.add({ kind: 'split', a: -1, b: -1 });
    // Both exits go to the same place; patching `a` and `b` together keeps it epsilon-only.
    return { start: s, exits: [[s, 'a'], [s, 'b']] };
  }

  build(node: Node): Fragment {
    switch (node.kind) {
      case 'set': {
        const s = this.add({ kind: 'read', node, next: -1 });
        return { start: s, exits: [[s, 'next']] };
      }
      case 'alt': {
        const options = node.options.map((seq) => this.sequence(seq));
        let fragment = options[options.length - 1];
        for (let i = options.length - 2; i >= 0; i -= 1) {
          const s = this.add({ kind: 'split', a: options[i].start, b: fragment.start });
          fragment = { start: s, exits: [...options[i].exits, ...fragment.exits] };
        }
        return fragment;
      }
      case 'repeat': {
        const parts: Fragment[] = [];
        for (let i = 0; i < node.min; i += 1) parts.push(this.build(node.node));
        if (node.max === null) {
          // `x*`: a split that reads `x` and comes back, or leaves.
          const body = this.build(node.node);
          const s = this.add({ kind: 'split', a: body.start, b: -1 });
          this.patch(body.exits, s);
          parts.push({ start: s, exits: [[s, 'b']] });
        } else {
          // `x{0,k}` as `(x(x(x)?)?)?`: each optional copy may leave before the next.
          const optional = node.max - node.min;
          if (optional > 0) {
            const leaves: Fragment['exits'] = [];
            let first = -1;
            let previous: Fragment['exits'] | null = null;
            for (let i = 0; i < optional; i += 1) {
              const body = this.build(node.node);
              const s = this.add({ kind: 'split', a: body.start, b: -1 });
              leaves.push([s, 'b']);
              if (previous) this.patch(previous, s);
              else first = s;
              previous = body.exits;
            }
            parts.push({ start: first, exits: [...leaves, ...previous!] });
          }
        }
        return parts.length ? this.chain(parts) : this.empty();
      }
    }
  }

  private sequence(nodes: readonly Node[]): Fragment {
    return nodes.length ? this.chain(nodes.map((n) => this.build(n))) : this.empty();
  }

  private chain(parts: Fragment[]): Fragment {
    for (let i = 0; i < parts.length - 1; i += 1) this.patch(parts[i].exits, parts[i + 1].start);
    return { start: parts[0].start, exits: parts[parts.length - 1].exits };
  }

  finish(fragment: Fragment): number {
    const accept = this.add({ kind: 'match' });
    this.patch(fragment.exits, accept);
    return fragment.start;
  }
}

function inRanges(code: number, ranges: Ranges): boolean {
  for (const [lo, hi] of ranges) if (code >= lo && code <= hi) return true;
  return false;
}

function reads(node: Extract<Node, { kind: 'set' }>, code: number): boolean {
  let hit = false;
  for (const item of node.items) {
    if (inRanges(code, item.ranges) !== item.negated) {
      hit = true;
      break;
    }
  }
  return hit !== node.negated;
}

/**
 * **Compile a pattern** — `^…$`, at most `maxLength` characters — or say why it cannot be. Never throws, and never
 * runs JavaScript's own engine on the pattern.
 */
export function compileLinearPattern(source: string, maxLength: number): CompiledPattern {
  if (typeof source !== 'string' || source.length === 0) return { ok: false, problem: 'syntax' };
  if (source.length > maxLength) return { ok: false, problem: 'too_long' };
  // Anchored at both ends: a `$` escaped (`\$`) is a dollar, not the end.
  const escapedEnd = /(^|[^\\])(\\\\)*\\\$$/.test(source);
  if (!source.startsWith('^') || !source.endsWith('$') || escapedEnd || source.length < 2) {
    return { ok: false, problem: 'not_anchored' };
  }
  try {
    const tree = new Parser(source.slice(1, -1)).parse();
    const builder = new Builder();
    const start = builder.finish(builder.build(tree));
    const states = builder.states;
    return { ok: true, pattern: { source, test: (code) => run(states, start, code) } };
  } catch (err) {
    if (err instanceof Refused) return { ok: false, problem: err.problem };
    throw err;
  }
}

/** Thompson's simulation: every state the code could be in, advanced one character at a time. */
function run(states: readonly State[], start: number, code: string): boolean {
  const mark = new Int32Array(states.length).fill(-1);
  let generation = 0;
  let current: number[] = [];
  const add = (list: number[], index: number) => {
    // An explicit stack: an epsilon chain as long as the automaton must not overflow the call stack.
    const stack = [index];
    while (stack.length) {
      const i = stack.pop()!;
      if (i < 0 || mark[i] === generation) continue;
      mark[i] = generation;
      const state = states[i];
      if (state.kind === 'split') {
        stack.push(state.b, state.a);
      } else {
        list.push(i);
      }
    }
  };
  add(current, start);
  for (let p = 0; p < code.length; p += 1) {
    const ch = code.charCodeAt(p);
    generation += 1;
    const next: number[] = [];
    for (const i of current) {
      const state = states[i];
      if (state.kind === 'read' && reads(state.node, ch)) add(next, state.next);
    }
    current = next;
    if (current.length === 0) return false;
  }
  return current.some((i) => states[i].kind === 'match');
}
