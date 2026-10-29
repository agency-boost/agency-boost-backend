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
 * **Recruitment tools read no lead, no training, no event and no campaign** (P17-T2 AC-7, P17-T4 AC-9): a
 * plan keeps nothing about a candidate, so no recruitment lead is read (D-store), and the product owner put
 * training, events and campaigns last (2026-10-08) — the BOP a candidate may be brought to is a word in the
 * playbook, not an event. Not only the module's own imports: **nothing it reaches, at any depth**, so a
 * dependency cannot bring one in behind it.
 */
describe('P17-T2 AC-7, P17-T4 AC-9 recruitment tools import no leads, training, events or campaigns module', () => {
  const MODULE = __dirname;
  const code = readdirSync(MODULE).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts')).map((f) => join(MODULE, f));

  it('P17-T2 AC-7 the module has code to check', () => {
    expect(code.map((f) => f.slice(MODULE.length + 1)).sort()).toEqual([
      'recruitment-pitch.repository.ts', 'recruitment-pitch.schema.ts', 'recruitment-pitch.service.ts',
      'recruitment-plan.service.ts', 'recruitment-plan.ts', 'recruitment-playbook-defaults.ts',
      'recruitment-playbook-input.ts', 'recruitment-playbook.schema.ts', 'recruitment-playbook.service.ts',
      'recruitment.controller.ts', 'recruitment.dto.ts', 'recruitment.messages.ts', 'recruitment.response.dto.ts',
    ]);
  });

  it('P17-T2 AC-7 imports none of those modules, directly or through anything it imports', () => {
    const files = reached(code);
    // The walk reaches what the module is built on: proof that it walks at all.
    expect([...files].some((f) => f.endsWith('modules/assets/asset.service.ts'))).toBe(true);
    expect([...files].some((f) => f.endsWith('modules/tenants/tenant-day.service.ts'))).toBe(true);
    const offending = [...files]
      .map((f) => f.slice(SRC.length + 1))
      .filter((f) => /^modules\/(leads|training|events|campaigns)\//.test(f));
    expect(offending).toEqual([]);
  });

  it('P17-T2 AC-7 the plan reads no office-tier collection: its service is built on the playbook and the office’s day alone', () => {
    const plan = readFileSync(join(MODULE, 'recruitment-plan.service.ts'), 'utf8');
    const imports = [...plan.matchAll(/from\s+'([^']+)'/g)].map(([, spec]) => spec);
    expect(imports.filter((spec) => /repository|schema/.test(spec))).toEqual([]);
    expect(plan).not.toMatch(/RecruitmentPitch|InjectModel/);
  });
});
