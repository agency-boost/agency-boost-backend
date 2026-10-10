import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **Every named cross-tenant read, and where it may be called from** (invariant §1;
 * `multi-tenancy-and-scoping.md`, *Phase 13.2's named cross-tenant reads*; P13.2-T7 AC-6).
 *
 * `raw-writes.tenancy.spec.ts` holds the raw **writes** and `repositories.tenancy.spec.ts` holds who may
 * inject a tenant-scoped model. Neither sees a **read** that goes round the tenant on purpose: the
 * repository's own unscoped methods, each named for what it does (`…AcrossTenants`,
 * `…AcrossAllTenants`), each refusing anybody but a Super Admin. This is their register — a source-shape
 * assertion in the same spirit as the other two: a new caller is a decision, and a decision has a
 * reason written next to it, here.
 *
 * And for P13.2-T7's read of one office's settings, the stronger claim the phase makes: **nothing
 * outside configuration is read**. The method is called from one file, and that file is constructed
 * with configuration repositories and the asset registry, and nothing else.
 */

const MODULES = join(__dirname, '../../modules');

/** `file → method → why`. A caller missing here fails; an entry nobody needs any more fails too. */
const CALLERS: Record<string, Record<string, string>> = {
  'tenants/tenant.service.ts': {
    findAcrossAllTenants:
      'the platform overview and the platform admins list (`platform_metrics:read`, '
      + '`kpm_admin:list_platform`): active memberships across every office, for counts and the '
      + 'Owner/Admin rows, by the Super Admin who is in none',
  },
  'assets/asset.service.ts': {
    findAcrossAllTenants:
      'the orphan sweep: storage accounting is a platform job, and a per-office sweep would never see '
      + 'an archived office — nor a company file a failed template copy left behind (P13.2-T7 AC-5)',
  },
  'org/leader-limit.ts': {
    countPerOfficeAcrossTenants:
      '*Leaders used* per office on the Super Admin\'s offices list (P13.2-T3, ADR-0113): counts, never '
      + 'a row, for the offices named',
  },
  'reporting/platform-analytics.service.ts': {
    adoptionPerOfficeAcrossTenants:
      '*Cross-platform analytics* (P18-T8, OD-148, D-admin): each office\'s active members by rung, and the '
      + 'memberships that began and ended this month — counts, never a row, by the Super Admin who is in no office',
    signInsPerOfficeAcrossTenants:
      '*Cross-platform analytics* (P18-T8): how many of each office\'s active members signed in within 7 and 30 '
      + 'days, the account joined inside the aggregate so no id or time leaves the database — two counts per office',
    distinctAccountsAcrossTenants:
      '*Cross-platform analytics* (P18-T8, the exit review item 6): the company and platform rows\' members and '
      + 'sign-ins as people, not memberships — distinct accounts grouped inside the aggregate, three counts a row',
  },
  'config/office-settings.source.ts': {
    findInOfficeAcrossTenants:
      '*Save as template* (P13.2-T7, ADR-0115 §5): one named office\'s published configuration — and '
      + 'its own training files, to duplicate — read by the Super Admin, who is in no office',
  },
};

/**
 * What `OfficeSettingsSource` may be given: the office's configuration, and the asset registry for the
 * office's own training files. A lead, a log, a goal, a membership or a note is not on it.
 *
 * *Narrowed in P13.2's exit review (finding 1):* the training category and skill, event-type and
 * capability repositories went when the source stopped reading their live rows — the Owner's unpublished
 * edits — and took them from the published snapshot instead. Module content is still read by code, so
 * the module repository stays.
 */
const CONFIGURATION_REPOSITORIES = new Set([
  'ConfigSnapshotRepository',
  'ActivationTemplateRepository',
  'TrainingModuleRepository',
  'AssetRepository',
]);

const METHOD = /\.(\w*AcrossTenants|\w*AcrossAllTenants)\s*\(/g;

function callers(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const files = globSync('**/*.ts', { cwd: MODULES })
    .filter((f) => !f.includes('.spec.'))
    .map((f) => f.replace(/\\/g, '/'));
  for (const file of files) {
    const source = readFileSync(join(MODULES, file), 'utf8');
    for (const m of source.matchAll(METHOD)) {
      // A declaration is `async name(`, not `.name(` — only calls are matched.
      const methods = found.get(file) ?? new Set<string>();
      methods.add(m[1]);
      found.set(file, methods);
    }
  }
  return found;
}

describe('named cross-tenant reads (invariant §1, P13.2-T7 AC-6)', () => {
  const found = callers();

  it('finds the calls at all, so a silent zero cannot pass', () => {
    expect(found.size).toBeGreaterThanOrEqual(4);
    expect(found.get('config/office-settings.source.ts')?.has('findInOfficeAcrossTenants')).toBe(true);
  });

  it('every caller of a named cross-tenant read is registered, with its reason', () => {
    const unregistered = [...found].flatMap(([file, methods]) => [...methods]
      .filter((method) => !CALLERS[file]?.[method])
      .map((method) => `${file} calls ${method}`));
    expect(unregistered).toEqual([]);
  });

  it('every registered caller still calls it, and says why', () => {
    for (const [file, methods] of Object.entries(CALLERS)) {
      for (const [method, reason] of Object.entries(methods)) {
        expect(reason.length).toBeGreaterThan(20);
        expect([file, found.get(file)?.has(method) ?? false]).toEqual([file, true]);
      }
    }
  });

  it('reads one office’s settings from configuration alone — nothing outside it is in reach', () => {
    const source = readFileSync(join(MODULES, 'config/office-settings.source.ts'), 'utf8');
    const constructor = source.slice(source.indexOf('constructor('), source.indexOf(') {}', source.indexOf('constructor(')));
    const injected = [...constructor.matchAll(/private readonly \w+\s*:\s*(\w+)/g)].map((m) => m[1]);
    expect(injected.length).toBeGreaterThanOrEqual(4);
    expect(injected.filter((type) => !CONFIGURATION_REPOSITORIES.has(type))).toEqual([]);
    // And no model of its own, through which any collection could be reached.
    expect(source).not.toContain('@InjectModel(');
  });
});
