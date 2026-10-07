import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { join } from 'node:path';

/**
 * **Every raw-model write to a tenant-scoped collection carries `kpmId` in its filter.**
 *
 * Invariant §1 says a query built without the tenant is a defect "even when it happens to
 * be correct today". Five writes in `modules/org` filtered on `membershipId` alone. None
 * of them could actually cross a tenant, because ObjectIds are globally unique — so no
 * behavioural test could ever have failed, and none did. What they *did* do is miss every
 * index on `membershipHistory`, all of which lead with `kpmId`, and stand as the precedent
 * the next module would copy.
 *
 * That is why this is a source-shape assertion rather than a behavioural one, in the same
 * spirit as `index-conventions.tenancy.spec.ts`: the guarantee is about how the query is
 * *written*, and the day it becomes observable is the day it is already a leak.
 *
 * `writes-through-the-repository` is the stronger rule and this does not replace it —
 * these are the deliberate raw-model escapes, and they still have to be scoped.
 */

const SRC = join(__dirname, '../..');
const WRITES = ['updateMany', 'updateOne', 'deleteMany', 'deleteOne'] as const;

/** Model classes whose documents belong to exactly one tenant. */
const TENANT_SCOPED = new Set([
  'Asset',
  'Membership',
  'MembershipHistory',
  'JoinRequest',
  'InviteCode',
  'Group',
]);

/**
 * Model classes a write may filter without `kpmId`, each with the reason. Anything
 * injected and written that is in neither list fails the last test below, so a new
 * collection cannot quietly avoid being classified.
 */
const EXEMPT: Record<string, string> = {
  User: 'global. One person, one account, one login — identity is not tenant-scoped (§2).',
  Kpm: 'the tenant record itself.',
  Company: 'platform-global. Owned by Super Admin, read-only to a tenant.',
  CompanyOrgLevel: 'platform-global. A company defines its ladder, not an office (ADR-0012).',
  Product:
    'company-partitioned (ADR-0033). A product belongs to the insurer and is read live by every '
    + 'office of it, so `kpmId` would say the opposite of what it is. `companyId` is the filter '
    + 'that matters, and `ProductService.of` is the one place it is applied.',
  QualificationRule:
    'company-partitioned (ADR-0026, ADR-0034), for the same reason as Product above. A carrier '
    + 'rule — MOC, a production club — belongs to the insurer and is read live by every office of '
    + 'it, so a carrier changing MOC does not wait on fifty Owners republishing. P5-T9 writes it '
    + 'from the published `campaign_kinds` template, filtered by `companyId` on every query.',
  NamedTemplate:
    'company-partitioned (ADR-0115 §3), for the same reason as Product above: a company\'s named '
    + 'template belongs to the insurer, is written only by Super Admin, and is read before the office '
    + 'made from it exists. Every write filters by its id, found under the company first.',
  CompanyTemplate:
    'company-partitioned (ADR-0018, ADR-0115 §3): a company\'s template kinds, written only by Super '
    + 'Admin and read before the office made from them exists. P13.2-T7\'s one raw write soft-deletes the '
    + 'rows of a template that was never written, filtered by `companyId` and that template\'s id.',
  KpmRequest: 'an office that does not exist yet, so there is no tenant to scope to.',
  AuthToken: 'platform-global. A session belongs to a user, not to an office.',
  ImpersonationSession:
    'a platform record of a platform action. `kpmId` is nullable because a target may be '
    + 'in no office at all, and ending every session an operator has open is keyed by the '
    + 'person, not by a tenant. An Owner\'s read is narrowed in the service, which refuses '
    + 'another office as a 404.',
  AuditLog: 'written through AuditService, which stamps the tenant itself.',
  NotificationPreferences: 'per-user, for the same reason as Notification below.',
  Notification:
    "per-user by design, and cross-office. `kpmId` is nullable because verification and " +
    'password-reset notifications are created before a user has joined any KPM, so the ' +
    'inbox is filtered by `userId` — the one exception already declared in ' +
    '`CROSS_TENANT_INDEXES` in index-conventions.tenancy.spec.ts. Adding `kpmId` here ' +
    'would hide a new account’s own verification notice from it.',
};

/** The first argument of a call, by balanced scan from just after the `(`. */
function firstArgument(source: string, from: number): string {
  let depth = 1;
  for (let i = from; i < source.length; i += 1) {
    const c = source[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 1) return source.slice(from, i);
    if (depth === 0) return source.slice(from, i);
  }
  return '';
}

interface RawWrite {
  where: string;
  model: string;
  filter: string;
}

function rawWrites(): RawWrite[] {
  const found: RawWrite[] = [];
  const files = globSync('modules/**/*.ts', { cwd: SRC })
    .filter((f) => !f.includes('.spec.'))
    .map((f) => join(SRC, f));

  for (const file of files) {
    const source = readFileSync(file, 'utf8');

    // `@InjectModel(InviteCode.name) private readonly invites: Model<…>`, with the
    // property allowed to sit on the next line — several do.
    const models = new Map<string, string>();
    const injection = /@InjectModel\(\s*(\w+)\.name\s*\)\s*(?:\n\s*)?(?:private|readonly|public|protected)[^:]*?(\w+)\s*:/g;
    for (const m of source.matchAll(injection)) models.set(m[2], m[1]);

    const call = new RegExp(`this\\.(\\w+)\\s*(?:\\n\\s*)?\\.\\s*(${WRITES.join('|')})\\s*\\(`, 'g');
    for (const m of source.matchAll(call)) {
      const model = models.get(m[1]);
      if (!model) continue; // Not an injected model — a service, or the tenant repository.
      found.push({
        where: `${file.slice(SRC.length + 1)}:${source.slice(0, m.index).split('\n').length} this.${m[1]}.${m[2]}()`,
        model,
        filter: firstArgument(source, m.index + m[0].length),
      });
    }
  }
  return found;
}

describe('raw-model writes are tenant-scoped', () => {
  const writes = rawWrites();

  it('finds the raw writes at all, so a silent zero cannot pass this suite', () => {
    /*
     * The whole file is a regex over source. If a refactor changes how models are
     * injected, every assertion below would pass vacuously — this is the tripwire.
     *
     * **The floor goes down, not up.** It was 20, and anchored on `MembershipHistory`,
     * until `P4-T11` moved `groups`, `joinRequests` and `membershipHistory` behind
     * repositories — which is the point of that task, and is the suite's own success
     * showing up as a failing number. It is anchored on `Notification` now: the one
     * collection that is *declared* per-user rather than tenant-scoped
     * (`CROSS_TENANT_INDEXES`), so it stays raw by design rather than by omission.
     */
    expect(writes.length).toBeGreaterThanOrEqual(10);
    expect(writes.some((w) => w.model === 'Notification')).toBe(true);
  });

  it('every write to a tenant-scoped collection filters on kpmId', () => {
    const unscoped = writes
      .filter((w) => TENANT_SCOPED.has(w.model))
      .filter((w) => !w.filter.includes('kpmId'))
      .map((w) => `${w.where} → ${w.filter.replace(/\s+/g, ' ').trim()}`);

    expect(unscoped).toEqual([]);
  });

  it('every written model is classified as scoped or exempt, with a reason', () => {
    const unclassified = [
      ...new Set(
        writes.map((w) => w.model).filter((m) => !TENANT_SCOPED.has(m) && !EXEMPT[m]),
      ),
    ];
    expect(unclassified).toEqual([]);
  });
});
