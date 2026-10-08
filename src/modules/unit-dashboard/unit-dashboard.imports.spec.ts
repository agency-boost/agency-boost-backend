import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const SRC = join(__dirname, '../..');

/** A source file's imports, resolved to files under `src/` — `@/` and relative, types included. */
function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].flatMap(([, spec]) => {
    const base = spec.startsWith('@/') ? join(SRC, spec.slice(2))
      : spec.startsWith('.') ? normalize(join(dirname(file), spec))
        : null;
    if (base === null) return [];
    return [`${base}.ts`, join(base, 'index.ts')].filter((candidate) => existsSync(candidate)).slice(0, 1);
  });
}

/** Every file the module's code reaches, at any depth. */
function reached(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    stack.push(...importsOf(file).filter((next) => !seen.has(next)));
  }
  return seen;
}

/**
 * **Nothing on the Unit Dashboard reads training, events or campaigns** (P15-T1 AC-11): the product owner
 * put those three last (2026-10-08), so the *Chasing MDRT* column and the detail's campaigns wait for Phase
 * 18.5 (OD-138). Not only the module's own imports: **nothing it reaches, at any depth**, so a dependency
 * cannot bring one in behind it.
 */
describe('P15-T1 AC-11 the Unit Dashboard reads no training, event or campaign', () => {
  const MODULE = __dirname;
  const code = readdirSync(MODULE).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts')).map((f) => join(MODULE, f));

  it('P15-T1 AC-11 the module has code to check', () => {
    expect(code.map((f) => f.slice(MODULE.length + 1)).sort()).toEqual([
      'unit-dashboard.controller.ts', 'unit-dashboard.dto.ts', 'unit-dashboard.response.dto.ts', 'unit-dashboard.service.ts',
    ]);
  });

  it('P15-T1 AC-11 imports none of those modules, directly or through anything it imports', () => {
    const files = reached(code);
    // The walk reaches the readings the dashboard is built on: proof that it walks at all.
    expect([...files].some((f) => f.endsWith('modules/coaching/pace-status.ts'))).toBe(true);
    const offending = [...files]
      .map((f) => f.slice(SRC.length + 1))
      .filter((f) => /^modules\/(training|events|campaigns)\//.test(f));
    expect(offending).toEqual([]);
  });
});
