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
      + 'Owner/Admin rows, by the Super Admin who is in none; and *Ganti Owner*\'s account picker '
      + '(`kpm:assign_owner`, P19-T3 AC-5, ADR-0191 §5): the live memberships of at most twenty accounts found by '
      + 'name or email, so the Super Admin sees which offices each already belongs to; and each Owner\'s own membership '
      + 'in the offices listed (P19.4-T3, ADR-0212 §2), for *Diundang* — its `invitedAt` — and no other member\'s row',
    countPerOfficeAcrossTenants:
      'the offices list, a KPM\'s page and *Perlu perhatian Anda* (P19.4-T3 AC-8, SA R5, ADR-0212): each office\'s live '
      + 'memberships, for *Anggota* and *"KPM {code} belum punya anggota"* — a count per office, never a row',
  },
  'assets/asset.service.ts': {
    findAcrossAllTenants:
      'the orphan sweep: storage accounting is a platform job, and a per-office sweep would never see '
      + 'an archived office — nor a company file a failed template copy left behind (P13.2-T7 AC-5)',
  },
  'tenants/org-level.service.ts': {
    countHoldingRungAcrossTenants:
      'a rung\'s leader tier refused while anybody holds it (P18.5-T1, ADR-0156 §5): the rung is the company\'s and '
      + 'its members are in every office of it, so the Super Admin, in none, counts them — a count, never a row',
  },
  'org/leader-limit-request.service.ts': {
    queueAcrossTenants:
      'the Super Admin\'s queue of leaders past an office\'s limit (ADR-0157 §3): every office\'s requests, by the '
      + 'Super Admin who is in none — each read in its own office afterwards for names, never widened',
    findByIdAcrossTenants:
      'deciding one leader-limit request (ADR-0157 §3): the route names the request, and the office it names is the '
      + 'one the approval then acts in, through the scoped repository with that office named',
  },
  'org/invites.service.ts': {
    pendingCodeAcrossTenants:
      '*+ Add agent* (P18.8-T3, ADR-0170 §2): whether an agent code already has an invite waiting anywhere in the '
      + 'company — the insurer issued the code and spans offices — answered as a boolean, never a row, an office or a name',
  },
  'tenants/roster-import.service.ts': {
    pendingCodeAcrossTenants:
      'the people import\'s WhatsApp invitation for an Agent row with no email (P19.12-T7, ADR-0250): the same check '
      + '*+ Add agent* makes, so the preview refuses a code already waiting anywhere in the company — a boolean, never a '
      + 'row, an office or a name',
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
      + 'its own training files, to duplicate, and its live activity binding — read by the Super Admin, who is in no office',
  },
  'auth/account-links.service.ts': {
    officeRoleOfLoginAcrossTenants:
      '*Tambah akun* (P19.2-T1 AC-8, UI-169 item 5, ADR-0199 §1, §3): one login\'s own membership — its office id, '
      + 'status and admin flag — in whichever office holds it, for whether a login may be linked (an Owner\'s, an '
      + 'Admin\'s or a Super Admin\'s) and for the caller\'s own other login\'s views on `GET /auth/me`; never a row '
      + 'of anything the office holds',
  },
  'products/product.service.ts': {
    referencesToProductAcrossTenants:
      'deleting a withdrawn product (P19.4-T4 AC-13, ADR-0209 §10): how many offices of the company still sell it or '
      + 'hold a script for it, by the Super Admin who is in none — two counts, never a row, an office or a word',
  },
  'tenants/org-level-references.ts': {
    countInOfficesAcrossTenants:
      'deleting an archived rung (P19.4-T5 AC-2, ADR-0213 §2): whether any office of the rung\'s company still names it '
      + '— a membership or its role history, a leader-limit request, a live or published setting, a campaign — counted by '
      + 'the Super Admin who is in none, the company\'s offices named; a count per kind, never a row, a name or a word',
  },
  'config/analytics-template.service.ts': {
    agentCodesInOfficesAcrossTenants:
      'the template\'s *Advanced analytics* agent-code format, tested before it is published and as it is typed (P19.5-T1 '
      + 'AC-11, ADR-0214 §7): the codes registered in every KPM that reads the template, by the Super Admin who is in '
      + 'none — codes alone, never a name, an office or a row; up to five named, as the insurer issued them',
    kodesHeldInOfficesAcrossTenants:
      'the template\'s *Advanced analytics* locks (P19.5-T1 AC-7, ADR-0214 §2): which columns any KPM reading the '
      + 'template holds a figure for, and the earliest month — kodes and months, never a figure, a person or an office',
  },
  'surveys/survey-open-runs.ts': {
    countOpenInOfficesAcrossTenants:
      'the template\'s *Bagian* switch before NPS or *Analitik kualitatif* goes off (P19.5-T4 AC-13, AA UI-022, AT-12, '
      + 'ADR-0216 §2): how many survey runs are open on each office\'s own today in the KPMs reading the template, by the '
      + 'Super Admin who is in none — two counts, never a run, an answer, an office or a person',
  },
  'reporting/advanced-analytics/quant-runs.service.ts': {
    peerMediansAcrossTenants:
      'the KPM\'s *Analitik kuantitatif* (P19.5-T3 AC-7, R3, D4, ADR-0215 §5): the median of each Quant metric over the '
      + 'other KPMs of the caller\'s own company whose run holds it complete, three at least — the one cross-KPM read a '
      + 'tenant role triggers; a median and a count, never another KPM\'s figure, name, id or template',
  },
  'reporting/platform/platform-reads.service.ts': {
    listMembershipsAcrossTenants:
      '*All members* and a KPM\'s *Anggota* (P19.4-T3 AC-1, ADR-0207 §2, §4): every membership of the offices named, the '
      + 'listed fields alone, by the Super Admin who is in none — audited per read in the platform\'s log and each KPM\'s; and '
      + 'the leaders of the page\'s rows, for their names; and *KPM & data*\'s member tiles, live memberships counted',
    liveMembershipCountsPerUserAcrossTenants:
      '*All members* › *Akun terdaftar* (P19.12-T2 AC-1, ADR-0245 §1): how many live memberships each account holds in '
      + 'any office, for *Tanpa KPM*, *Punya KPM* and each row\'s *n KPM*, by the Super Admin who is in none — a count '
      + 'per account, never an office, a row or a name; audited per read in the platform\'s log',
  },
  'reporting/platform/platform-reads.controller.ts': {
    kpmComparisonAcrossTenants:
      'the KPM comparison (P19.4-T3 AC-3, ADR-0207 §2, §4): each KPM\'s Overview, computed by its own code over the KPM '
      + 'through `figuresForOffice`, counts and sums only, audited per read',
    companyKpmsAcrossTenants:
      'the company\'s *KPM & data* (P19.4-T3 AC-15, ADR-0207 §2): each KPM\'s month through the Overview\'s functions over '
      + 'the KPM, and the D4 peer count, audited per read',
  },
  'tenants/admin.controller.ts': {
    dataStatusAcrossTenants:
      'the offices list\'s *Data terakhir* and *Perlu tindakan* (P19.4-T3 AC-8): whether each office\'s months are '
      + 'uploaded — a month, never a figure of it',
  },
  'config/activity-binding.service.ts': {
    findInOfficeAcrossTenants:
      'an office\'s activity binding, read by the Super Admin (P18.6-T2, ADR-0163 §3): one named office\'s binding '
      + 'and its activity types — configuration, never a log — to show on the KPM page; since P19.4-T3 the rebind is the '
      + 'Owner\'s and the Admin\'s, through the scoped repositories (ADR-0206 §1)',
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
  // ADR-0163: the office's activity binding, read live — the Super Admin's, never an Owner's unpublished edit.
  'ActivityBindingRepository',
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

/**
 * **The `…ForOffice` reads** (ADR-0207 §4; P19.4-T3): the KPM's own Phase 19.3 functions run over a named office for the
 * Super Admin, through a platform read's context. Each refuses any other context (`OfficePeople.requirePlatformRead`), and
 * each is called from one file: the platform reads, which audit every call.
 */
const FOR_OFFICE: Record<string, string[]> = {
  'reporting/platform/platform-reads.service.ts': ['analyticsForOffice', 'complianceForOffice', 'figuresForOffice'],
  // P19.5-T3 AC-12 (ADR-0215 §9): the *Advanced analytics* tab, its own reads' file, audited per visit.
  'reporting/advanced-analytics/admin-advanced-analytics.service.ts': ['advancedAnalyticsForOffice'],
};
const FOR_OFFICE_METHOD = /\.(figuresForOffice|analyticsForOffice|complianceForOffice|advancedAnalyticsForOffice)\s*\(/g;

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

  it('P19.4-T3 AC-16 the …ForOffice reads are called from the platform reads alone, and each refuses another context', () => {
    const found = new Map<string, Set<string>>();
    for (const file of globSync('**/*.ts', { cwd: MODULES }).filter((f) => !f.includes('.spec.')).map((f) => f.replace(/\\/g, '/'))) {
      for (const m of readFileSync(join(MODULES, file), 'utf8').matchAll(FOR_OFFICE_METHOD)) {
        found.set(file, (found.get(file) ?? new Set()).add(m[1]));
      }
    }
    expect(Object.fromEntries([...found].map(([file, methods]) => [file, [...methods].sort()]))).toEqual(FOR_OFFICE);
    for (const file of [
      'reporting/kpm-overview.service.ts', 'reporting/kpm-analytics.service.ts', 'reporting/compliance/compliance.service.ts',
      'reporting/advanced-analytics/advanced-analytics.service.ts',
    ]) {
      const source = readFileSync(join(MODULES, file), 'utf8');
      const at = source.search(/async (figuresForOffice|analyticsForOffice|complianceForOffice|advancedAnalyticsForOffice)\(/);
      expect([file, at > 0]).toEqual([file, true]);
      expect([file, source.slice(at, at + 400).includes('OfficePeople.requirePlatformRead(ctx)')]).toEqual([file, true]);
    }
  });

  it('P18.6-T2 reads an office’s activity binding from configuration alone — nothing outside it is in reach', () => {
    const source = readFileSync(join(MODULES, 'config/activity-binding.service.ts'), 'utf8');
    const constructor = source.slice(source.indexOf('constructor('), source.indexOf(') {}', source.indexOf('constructor(')));
    const injected = [...constructor.matchAll(/private readonly \w+\s*:\s*(\w+)/g)].map((m) => m[1]);
    // The binding and the types it names, the office record its 404 is answered from, and the audit it writes.
    expect(injected.sort()).toEqual(['ActivityBindingRepository', 'ActivityTypeRepository', 'AuditService', 'Model']);
    expect(source).toContain('@InjectModel(Kpm.name)');
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
