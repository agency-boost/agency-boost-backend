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
 * **Nothing on the Unit Dashboard reads training or events, and of campaigns only the chases** (P15-T1 AC-11, amended
 * by P18.5-T7 AC-8): the *Chasing MDRT* column and *Campaigns they're chasing* arrive with campaigns (OD-138,
 * ADR-0122), through **one named reader**, `CampaignChaseReadings`. Not only the module's own imports: **nothing it
 * reaches, at any depth**, so a dependency cannot bring in a campaign's standings, its evaluation or the agent's
 * routes behind it.
 */
describe('P15-T1 AC-11, P18.5-T7 AC-8 the Unit Dashboard reads no training or event, and of campaigns the chase reader alone', () => {
  const MODULE = __dirname;
  const code = readdirSync(MODULE).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts')).map((f) => join(MODULE, f));
  const rel = (f: string) => f.slice(SRC.length + 1);

  it('P15-T1 AC-11 the module has code to check', () => {
    // Its sentences in both languages since P18.98-T5: `unit-dashboard.messages.ts`, the catalogue. The Activities tab's
    // read and its rules since UI V1 (Phase 18.99 T4): `unit-activities.*`, `unit-figures.ts` — walked like the rest.
    expect(code.map((f) => f.slice(MODULE.length + 1)).sort()).toEqual([
      'unit-activities.controller.ts', 'unit-activities.response.dto.ts', 'unit-activities.service.ts',
      'unit-dashboard.controller.ts', 'unit-dashboard.dto.ts', 'unit-dashboard.messages.ts',
      'unit-dashboard.response.dto.ts', 'unit-dashboard.service.ts', 'unit-figures.ts',
    ]);
  });

  it('P15-T1 AC-11 imports nothing of training or events, directly or through anything it imports', () => {
    const files = reached(code);
    // The walk reaches the readings the dashboard is built on: proof that it walks at all.
    expect([...files].some((f) => f.endsWith('modules/coaching/pace-status.ts'))).toBe(true);
    expect([...files].map(rel).filter((f) => /^modules\/(training|events)\//.test(f))).toEqual([]);
  });

  it('P18.5-T7 AC-8 imports one file of the campaigns module, the chase reader, and reaches only what it reads', () => {
    const direct = [...new Set(code.flatMap(importsOf))].map(rel).filter((f) => f.startsWith('modules/campaigns/'));
    expect(direct).toEqual(['modules/campaigns/campaign-chase-readings.ts']);
    const campaigns = [...reached(code)].map(rel).filter((f) => f.startsWith('modules/campaigns/')).sort();
    // The reader, the two repositories and schemas it reads, and the words it composes the MDRT tooltip with — held
    // in both languages in the module's catalogue since P18.98-T5, which is sentences and nothing else.
    expect(campaigns).toEqual([
      'modules/campaigns/campaign-chase-readings.ts',
      'modules/campaigns/campaign-chase.repository.ts',
      'modules/campaigns/campaign-chase.schema.ts',
      'modules/campaigns/campaign-words.ts',
      'modules/campaigns/campaign.repository.ts',
      'modules/campaigns/campaign.schema.ts',
      'modules/campaigns/campaigns.messages.ts',
    ]);
  });
});
