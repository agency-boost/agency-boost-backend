import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **The campaigns module reads its tenant-scoped collections through its repositories alone** (invariant §1; the Phase
 * 18.2 permission review, item 19). A source-shape assertion, as `raw-writes.tenancy.spec.ts` is: every
 * `@InjectModel(…)` in the module's code is a repository injecting its own model, or one of the exceptions below,
 * each with its reason. A service injecting `CampaignChase`, `CampaignStanding` or `Campaign` raw fails here by name.
 */
describe('P18.2-T8 review item 19 — the campaigns services use no raw model', () => {
  const code = readdirSync(__dirname).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

  /** `file: model` for every injection in the module's code. */
  const injections = code.flatMap((file) =>
    [...readFileSync(join(__dirname, file), 'utf8').matchAll(/@InjectModel\(\s*(\w+)\.name\s*\)/g)].map((m) => `${file}: ${m[1]}`));

  /** The repositories, each injecting the one model it scopes. */
  const REPOSITORIES = [
    'campaign-chase.repository.ts: CampaignChase',
    'campaign-standing.repository.ts: CampaignStanding',
    'campaign.repository.ts: Campaign',
  ];

  /** The exceptions, each with why it is not a tenant-scoped read. */
  const ALLOWED: Record<string, string> = {
    'campaign.service.ts: QualificationRule':
      'company-partitioned (ADR-0026, ADR-0035): the carrier rules are the insurer’s, filtered by `companyId` on every query',
    'campaign.service.ts: Kpm': 'the tenant record itself, read by `_id: ctx.kpmId` for its zone and its company',
    'carrier-rules.ts: QualificationRule': 'company-partitioned, as above: Phase 18’s one named reader of the carrier rules',
    'carrier-rules.ts: Kpm': 'the tenant record itself, by `_id: ctx.kpmId` (`repositories.tenancy.spec.ts`)',
  };

  it('P18.2-T8 review item 19 finds the injections at all, so a silent zero cannot pass', () => {
    expect(injections.length).toBeGreaterThanOrEqual(REPOSITORIES.length);
  });

  it('P18.2-T8 review item 19 injects only the repositories’ own models and the exceptions written down', () => {
    expect([...injections].sort()).toEqual([...REPOSITORIES, ...Object.keys(ALLOWED)].sort());
    for (const reason of Object.values(ALLOWED)) expect(reason.length).toBeGreaterThan(20);
  });

  it('P18.2-T8 review item 19 no service of the new member-side code injects a model', () => {
    const memberSide = [
      'campaign-agent.service.ts', 'campaign-chase-readings.ts', 'campaign-evaluation.ts', 'campaign-standings-reader.ts',
      'campaign-departure.ts',
    ];
    expect(injections.filter((i) => memberSide.some((f) => i.startsWith(`${f}:`)))).toEqual([]);
  });
});
