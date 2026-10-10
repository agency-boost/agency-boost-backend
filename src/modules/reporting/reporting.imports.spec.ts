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
 * **The Owner's reporting reads no training, event or campaign** (P18-T1 AC-12, P18-T2 AC-5; D-moc, D-clubs): the
 * product owner put those three last (2026-10-08). **One file of the campaigns module is in reach**, the named
 * reader of the company's carrier rules (`carrier-rules.ts`) — MOC thresholds and club tiers, Phase 5's
 * configuration, not a campaign — with the schema it reads. Nothing else of that module, nor anything of
 * training or events, at any depth, so a dependency cannot bring one in behind it. That no `campaigns` row is
 * read at run time is `reporting.performance.spec.ts`'s query log.
 */
describe('P18-T1 AC-12, P18-T2 AC-5 the reporting module reads no training, event or campaign', () => {
  const MODULE = __dirname;
  const code = readdirSync(MODULE).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts')).map((f) => join(MODULE, f));

  it('P18-T1 AC-12 the module has code to check', () => {
    expect(code.map((f) => f.slice(MODULE.length + 1)).sort()).toEqual([
      'agency-partition.ts', 'directory-columns.ts', 'kpm-analytics.service.ts', 'kpm-overview.service.ts',
      'kpm-recruit-target.repository.ts', 'kpm-recruit-target.schema.ts', 'office-figures.ts', 'office-people.ts',
      'platform-analytics.service.ts', 'reporting.controller.ts', 'reporting.dto.ts', 'reporting.response.dto.ts',
    ]);
  });

  it('P18-T1 AC-12, P18-T2 AC-5 reaches the carrier rules’ one reader and nothing else of those three modules', () => {
    const files = reached(code);
    // The walk reaches the readings the reports are built on: proof that it walks at all.
    expect([...files].some((f) => f.endsWith('modules/coaching/coaching-readings.ts'))).toBe(true);
    const touched = [...files]
      .map((f) => f.slice(SRC.length + 1))
      .filter((f) => /^modules\/(training|events|campaigns)\//.test(f))
      .sort();
    expect(touched).toEqual(['modules/campaigns/campaign.schema.ts', 'modules/campaigns/carrier-rules.ts']);
  });

  it('P18-T2 AC-5 the carrier rules’ reader injects the rules’ model and the office’s own row: no campaign, chase or standing', () => {
    const source = readFileSync(join(SRC, 'modules/campaigns/carrier-rules.ts'), 'utf8');
    expect([...source.matchAll(/@InjectModel\((\w+)\.name\)/g)].map((m) => m[1])).toEqual(['QualificationRule', 'Kpm']);
    expect(source).not.toMatch(/CampaignRepository|CampaignService|Campaign\.name/);
  });
});
