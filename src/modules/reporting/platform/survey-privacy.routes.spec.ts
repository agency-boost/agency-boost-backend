import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestContext } from '@/common/context/request-context';
import { can, PERMISSIONS, type Permission } from '@/modules/rbac/permissions';

/**
 * **No route a Super Admin can call returns a survey answer per person** (P19.4-T3 AC-5; A-R9, A5-6; ADR-0207 §6,
 * ADR-0216 §3): no person's answers, no anonymous run's rows, no *Dukungan leader* (Q12).
 *
 * **The route inventory, walked off the controllers' own decorators** — every `@Controller` path and every handler's verb,
 * path and `@RequirePermission` — so a route Phase 19.5 adds is held to it the day it is written: a route whose path names
 * a survey, an NPS or a qualitative reading, and which the Super Admin's grants reach, must be registered below as an
 * aggregate with its reason, and a route that serves answers per person must stay out of the Super Admin's reach.
 * The Super Admin's own reads (`/admin/members`, the comparison, *Lihat sebagai KPM*, *Data bulanan*, *KPM & data*) are
 * walked too, and none of them names a survey.
 */

const MODULES = join(__dirname, '../..');

interface Route { file: string; verb: string; path: string; permission: Permission | null }

/** Every route of every controller under `src/modules`, read off the source: the decorators in declaration order. */
function routes(): Route[] {
  const out: Route[] = [];
  const files = globSync('**/*.controller.ts', { cwd: MODULES }).filter((f) => !f.includes('.spec.')).map((f) => f.replace(/\\/g, '/'));
  for (const file of files) {
    const source = readFileSync(join(MODULES, file), 'utf8');
    const token = /@Controller\(\s*(?:'([^']*)'|"([^"]*)")?\s*\)|@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)?\s*\)|@RequirePermission\(\s*'([^']+)'\s*\)/g;
    let base = '';
    let pending: Route | null = null;
    for (const m of source.matchAll(token)) {
      if (m[0].startsWith('@Controller')) {
        if (pending) out.push(pending);
        pending = null;
        base = m[1] ?? m[2] ?? '';
      } else if (m[3]) {
        if (pending) out.push(pending);
        const own = m[4] ?? m[5] ?? m[6] ?? '';
        pending = { file, verb: m[3].toUpperCase(), path: `/${[base, own].filter(Boolean).join('/')}`, permission: null };
      } else if (m[7] && pending && pending.permission === null) {
        pending.permission = m[7] as Permission;
      }
    }
    if (pending) out.push(pending);
  }
  return out;
}

/** A path that reads a survey, an NPS or a qualitative result. */
const SURVEY = /survey|surveys|\/nps\b|\/qual\b|advanced-analytics|advanced_analytics/i;

/**
 * **The survey routes a Super Admin's grants reach, each an aggregate** — with what it returns and why no person is in it.
 * A new one is a decision: written here, with its reason, or the test fails.
 */
const SUPER_ADMIN_AGGREGATES: Record<string, string> = {
  'GET /admin/companies/:companyId/template/advanced_analytics/code-check':
    'how many registered agent codes a format misses, and up to five codes — a code is no answer (P19.5-T1 AC-11)',
  'GET /admin/companies/:companyId/template/advanced_analytics/open-runs':
    'how many NPS and qualitative runs are open and in how many KPMs — counts only (ADR-0216 §2)',
  'GET /admin/tenants/:id/advanced-analytics':
    'the KPM\'s *Advanced analytics* tabs — which sections its template shows, the template\'s name and version; no '
    + 'figure and no answer (P19.5-T3 AC-12, ADR-0215 §9)',
  'GET /admin/tenants/:id/advanced-analytics/:section':
    'one section as the KPM\'s Owner reads it; `nps` and `qual` in the `summary` audience — counts, scores and '
    + 'percentages over at least three respondents, no free text, no Dukungan leader, no person (P19.5-T3 AC-12, A-R9, '
    + 'ADR-0216 §3)',
};

/** Routes that serve a person's answers, whoever may read them: never the Super Admin's. */
const PER_PERSON = ['GET /coaching/:membershipId/survey'];

const SUPER_ADMIN = RequestContext.platform('sa');
const reachable = (route: Route) => route.permission !== null && route.permission in PERMISSIONS && can(SUPER_ADMIN, route.permission);
const key = (route: Route) => `${route.verb} ${route.path}`;

describe('P19.4-T3 AC-5 no Super Admin route returns a survey answer per person (A-R9, A5-6)', () => {
  const all = routes();

  it('P19.4-T3 AC-5 walks the route inventory at all, so a silent zero cannot pass', () => {
    expect(all.length).toBeGreaterThan(300);
    expect(all.map(key)).toEqual(expect.arrayContaining([
      'GET /admin/members', 'GET /admin/analytics/kpms', 'GET /admin/tenants/:id/analytics',
      'GET /admin/tenants/:id/analytics/compliance', 'GET /admin/tenants/:id/data', 'GET /admin/companies/:companyId/kpms',
    ]));
  });

  it('P19.4-T3 AC-5 every survey route the Super Admin’s grants reach is a registered aggregate', () => {
    const reached = all.filter((r) => SURVEY.test(r.path) && reachable(r)).map(key).sort();
    expect(reached).toEqual(Object.keys(SUPER_ADMIN_AGGREGATES).sort());
    for (const reason of Object.values(SUPER_ADMIN_AGGREGATES)) expect(reason.length).toBeGreaterThan(20);
  });

  it('P19.4-T3 AC-5 a route that serves a person’s answers exists, and the Super Admin’s grants do not reach it', () => {
    for (const path of PER_PERSON) {
      const route = all.find((r) => key(r) === path);
      expect([path, route !== undefined]).toEqual([path, true]);
      expect([path, reachable(route!)]).toEqual([path, false]);
    }
  });

  it('P19.4-T3 AC-5 the platform reads name no survey, and each is a read', () => {
    const platform = all.filter((r) => r.file === 'reporting/platform/platform-reads.controller.ts');
    expect(platform).toHaveLength(6);
    for (const route of platform) {
      expect(route.verb).toBe('GET');
      expect(SURVEY.test(route.path)).toBe(false);
      expect(['platform_members:read', 'platform_kpm_figures:read']).toContain(route.permission);
    }
  });
});
