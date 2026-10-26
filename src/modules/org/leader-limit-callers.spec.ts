import { globSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * **No path is missed** (ADR-0113 §2, P13.2-T4 AC-8).
 *
 * The leader limit is checked inside `HierarchyService.create`, `createWithAccount`, `setLevel` and
 * `activate` because every path that makes a leader passes through one of them. That is true of the code
 * as ADR-0113's table found it — `activate` and `createWithAccount` added by the P13.2 exit review, for
 * the approval, tag and Owner's assignment that made a pending leader active unasked, and for the roster
 * row whose account outlived its refusal — and stays true only while nobody adds a caller the table does
 * not name. This reads every source file for a call to any of them — through whatever name the service
 * is injected under — and fails on one the table does not list, or on a listed one that is gone.
 *
 * A source-shape assertion, as `raw-writes.tenancy.spec.ts` is: a new caller is a decision about who may
 * make a leader, and it has to be made in ADR-0113's table before it is made here.
 */

const SRC = join(__dirname, '../..');

type Method = 'create' | 'createWithAccount' | 'setLevel' | 'activate';

/** ADR-0113's table: who calls which method, and the rung that call can produce. */
const CALLERS: Record<string, { method: Method; makes: string }[]> = {
  'modules/org/onboarding.service.ts': [{ method: 'create', makes: 'Agent, pending (registration)' }],
  'modules/org/leader-code.service.ts': [{ method: 'create', makes: 'Agent (a leader’s code)' }],
  'modules/tenants/roster-import.service.ts': [
    { method: 'createWithAccount', makes: 'any, from the role column, the account made with the seat' },
  ],
  'modules/tenants/tenant.service.ts': [
    { method: 'create', makes: 'AB, assigning an Owner who is not yet a member' },
    { method: 'activate', makes: 'their own rung, assigning an Owner who had registered (pending)' },
  ],
  // Each also carries out a request AgencyBoost approved past the limit (ADR-0157 §3), through the same method.
  'modules/org/role-change.service.ts': [{ method: 'setLevel', makes: 'any (a role change, or one approved past the limit)' }],
  'modules/org/approvals.service.ts': [
    { method: 'activate', makes: 'their own rung, approving or tagging a pending member, or one approved past the limit' },
  ],
};

/** Every `<name>.<method>(` on a property injected as `HierarchyService`. */
function callsIn(file: string): { method: Method; text: string }[] {
  const source = readFileSync(file, 'utf8');
  const names = [...source.matchAll(/(?:private|public|protected)?\s*readonly\s+(\w+)\s*:\s*HierarchyService\b/g)]
    .map((m) => m[1]);
  const found: { method: Method; text: string }[] = [];
  for (const name of names) {
    for (const m of source.matchAll(new RegExp(`this\\.${name}\\.(createWithAccount|create|setLevel|activate)\\(`, 'g'))) {
      found.push({
        method: m[1] as Method,
        text: source.slice(m.index ?? 0, (m.index ?? 0) + 400),
      });
    }
  }
  return found;
}

const sources = globSync('**/*.ts', { cwd: SRC })
  .filter((f) => !f.endsWith('.spec.ts') && !f.startsWith('seed/') && !f.startsWith('migrations/'))
  .map((f) => join(SRC, f));

const found = Object.fromEntries(
  sources
    .map((file) => [relative(SRC, file), callsIn(file)] as const)
    .filter(([, calls]) => calls.length > 0),
);

describe('every caller of the HierarchyService writes that can make a leader is one ADR-0113 names (P13.2-T4 AC-8)', () => {
  it('finds exactly the callers the table lists, no more and no fewer', () => {
    expect(Object.keys(found).sort()).toEqual(Object.keys(CALLERS).sort());
  });

  it.each(Object.entries(CALLERS).flatMap(([file, rows]) => rows.map(({ method, makes }) => [file, method, makes])))(
    '%s calls %s, making %s',
    (file, method) => {
      expect(found[file]?.map((c) => c.method)).toContain(method);
    },
  );

  it('each file calls only the methods the table gives it', () => {
    for (const [file, calls] of Object.entries(found)) {
      const listed = new Set((CALLERS[file] ?? []).map((row) => row.method));
      expect([file, calls.filter((c) => !listed.has(c.method)).map((c) => c.method)]).toEqual([file, []]);
    }
  });

  it('nothing but the service itself calls them from inside it', () => {
    const own = readFileSync(join(SRC, 'modules/org/hierarchy.service.ts'), 'utf8');
    expect(own).not.toMatch(/this\.(create|createWithAccount|setLevel|activate)\(/);
  });

  it.each(['modules/org/onboarding.service.ts', 'modules/org/leader-code.service.ts'])(
    '%s, a join path, only ever makes an Agent — which is why it is never refused',
    (file) => {
      // The ladder's lowest rung that leads nobody (ADR-0156): `AGENT` on the default ladder, never a leader rung.
      for (const call of found[file]) expect(call.text).toMatch(/role:\s*await this\.hierarchy\.entryRungCode\(.*'joiner'\)/);
    },
  );

  it('assigning an Owner makes the root AB, which the limit counts', () => {
    const create = found['modules/tenants/tenant.service.ts'].find((c) => c.method === 'create');
    // The ladder's Senior Leader rung (ADR-0156): `AB` on the default ladder, a rung the limit counts.
    const tenantService = readFileSync(join(SRC, 'modules/tenants/tenant.service.ts'), 'utf8');
    expect(tenantService).toMatch(/const role = await this\.hierarchy\.entryRungCode\(kpmId, 'owner'\)/);
    expect(create?.text).toMatch(/\{ userId, role, leaderId: null, status: 'active' \}/);
  });

  /*
   * **The only way past the limit is AgencyBoost's approval** (ADR-0157 §3, P18.8-T2 AC-8). `withLeaderSeat` skips
   * the count for an `ApprovedPastLimit` alone; one is built — its `approvedRequestId` written — only where an
   * approved request is carried out, and those two methods are called from the request service alone, after
   * `leader_limit_request:decide`.
   */
  it('builds a past-the-limit write only where an approved request is carried out, called from the decision alone', () => {
    const building = sources
      .filter((file) => /approvedRequestId:\s*request\.requestId/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file))
      .sort();
    expect(building).toEqual(['modules/org/approvals.service.ts', 'modules/org/role-change.service.ts']);

    const carrying = sources
      .filter((file) => /\.carryOutApproved\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(carrying).toEqual(['modules/org/leader-limit-request.service.ts']);
    const decider = readFileSync(join(SRC, 'modules/org/leader-limit-request.service.ts'), 'utf8');
    const approve = decider.slice(decider.indexOf('async approve('), decider.indexOf('async decline('));
    expect(approve).toContain("this.requireDecider(ctx, 'leader_limit_request:decide')");
  });
});
