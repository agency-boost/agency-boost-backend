import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

/** The module's own code, the scorecard's included: every `.ts` under it that is not a spec. */
function codeUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return codeUnder(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

/**
 * **The forum reads no training, event, campaign, lead, activity or coaching module** (P18.1-T2 AC-4;
 * `functional/leader-forum.md`, *What this module reads*): its scorecard is Phase 18's functions over the office's
 * people, production and activations, and its editors the memberships — at any depth, so a dependency cannot bring
 * one of those modules in behind it. Training, events and campaigns go last (2026-10-08); leads, activity and
 * coaching hold what members *did*, which a scorecard over the office never reads.
 */
describe('P18.1-T2 AC-4 the forum module imports no training, events, campaigns, leads, activity or coaching module', () => {
  const MODULE = __dirname;
  const code = codeUnder(MODULE);

  it('P18.1-T2 AC-4 the module has code to check, the scorecard’s included', () => {
    const names = code.map((f) => f.slice(MODULE.length + 1));
    expect(names).toEqual(expect.arrayContaining([
      'leader-meetings.controller.ts', 'leader-meetings.service.ts', 'leader-meeting-minutes.service.ts',
      'leader-meeting-sharing.service.ts', 'leader-meeting-people.ts', 'leader-meeting.repository.ts',
      join('scorecard', 'scorecard.service.ts'),
    ]));
  });

  it('P18.1-T2 AC-4 reaches none of the six, at any depth', () => {
    const files = reached(code);
    // The walk reaches what the scorecard reads: proof that it walks at all.
    expect([...files].some((f) => f.endsWith('modules/production/production-readings.ts'))).toBe(true);
    expect([...files].some((f) => f.endsWith('modules/org/membership.repository.ts'))).toBe(true);
    const touched = [...files]
      .map((f) => f.slice(SRC.length + 1))
      .filter((f) => /^modules\/(training|events|campaigns|leads|activity|coaching)\//.test(f))
      .sort();
    expect(touched).toEqual([]);
  });

  it('P18.1-T2 AC-1 nothing in the module notifies anybody or writes a §3.5 entry', () => {
    const files = reached(code).values();
    const ours = [...files].filter((f) => f.startsWith(MODULE));
    for (const file of ours) {
      const source = readFileSync(file, 'utf8');
      expect([file, /NotificationService|SubjectReadAudit/.test(source)]).toEqual([file, false]);
    }
  });
});
