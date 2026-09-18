import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { join } from 'node:path';

const MODULES = join(__dirname, '..');

/**
 * The structural half of P4-T11.
 *
 * `raw-writes.tenancy.spec.ts` holds the **writes**; it can only see the shape of a call,
 * so a *read* has nothing for it to check. This asserts the other thing: that no service
 * injects a tenant-scoped model at all. A repository removes the chance of forgetting
 * `kpmId` rather than catching it afterwards — invariant §1: *"a query built without the
 * repository is a defect even when it happens to be correct today."*
 */
const TENANT_SCOPED_MODELS = [
  // Added 2026-09-18, finishing P4-T11 AC-1, which named `assets` and stopped short of it.
  // Its absence is why this spec — written to catch a service holding a raw model — never
  // asked about the one service that was.
  'Asset',
  'Group',
  'JoinRequest',
  'MembershipHistory',
  'Membership',
  'ActivityCategory',
  'ActivityType',
  'LeadStatus',
  'RatioDefinition',
  'ConfigSnapshot',
  'TrainingCategory',
  'TrainingSkill',
  'TrainingModule',
  'ActivationTemplate',
  'KpmProductConfig',
  'EventType',
  'Event',
  'Campaign',
  'CapabilityCatalog',
];

/**
 * Files allowed to inject one, each with the reason.
 *
 * A repository has to reach its own model, and provisioning writes into an office that
 * has no request context yet — the Super Admin creating it is in no tenant, and every
 * document it writes carries an explicit `kpmId`, which `raw-writes.tenancy.spec.ts`
 * checks.
 */
const ALLOWED = new Map<string, string>([
  ['org/membership.repository.ts', 'the repository for that model'],
  ['org/org.repositories.ts', 'the repositories for those models'],

  ['config/activity.repository.ts', 'the repositories for those models'],
  ['training/training.repository.ts', 'the repositories for those models'],
  ['activation/activation.repository.ts', 'the repository for that model'],
  ['assets/asset.repository.ts', 'the repository for that model'],
  ['products/kpm-product.repository.ts', 'the repository for that model'],
  ['events/event.repository.ts', 'the repositories for those models'],
  ['campaigns/campaign.repository.ts', 'the repository for that model'],
  ['capability/capability.repository.ts', 'the repository for that model'],
  [
    'config/provisioning.service.ts',
    'writes into an office being created, before any context is scoped to it',
  ],
  [
    'auth/context-resolver.ts',
    'builds the RequestContext a scoped repository would need — it reads the membership '
      + 'that decides which tenant the caller is in, so it cannot be scoped to one',
  ],
]);

function sourceFiles(dir: string): string[] {
  return globSync('**/*.ts', { cwd: dir })
    .filter((f) => !f.endsWith('.spec.ts'))
    .map((f) => f.replace(/\\/g, '/'));
}

describe('tenant-scoped collections go through a repository (P4-T11)', () => {
  const files = sourceFiles(MODULES);

  it('finds the module sources at all, so a silent zero cannot pass', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('injects no tenant-scoped model outside a repository', () => {
    const offenders: string[] = [];

    for (const file of files) {
      if (ALLOWED.has(file)) continue;
      const text = readFileSync(join(MODULES, file), 'utf8');
      for (const model of TENANT_SCOPED_MODELS) {
        if (text.includes(`@InjectModel(${model}.name)`)) {
          offenders.push(`${file} injects ${model}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('lists a reason for every file that is allowed to', () => {
    // An allowance with no reason is how this list becomes a place to hide.
    for (const [file, reason] of ALLOWED) {
      expect(reason.length).toBeGreaterThan(10);
      expect(files).toContain(file);
    }
  });
});
