import { AuditReadService } from './audit-read.service';

const KPM = '66f0000000000000000000a1';
const CO = '66f0000000000000000000c1';
const ROOT = '66f0000000000000000000e1';
const OWNER = '66f0000000000000000000e2';
const MEM = '66f0000000000000000000d1';

/** A row as `findForTenant` hands it back: a Mongoose document, read by field. */
const row = (over: Record<string, unknown> = {}) => ({
  _id: 'a-1',
  createdAt: new Date('2026-09-24T02:00:00Z'),
  action: 'kpm.suspended',
  targetCollection: 'kpms',
  targetId: KPM,
  actorUserId: ROOT,
  effectiveUserId: null,
  before: null,
  after: null,
  ...over,
});

/** A model double whose `find({_id:{$in}})` answers from a fixed list. */
const model = (rows: Record<string, unknown>[]) => ({
  find: (filter: { _id: { $in: string[] } }) => ({
    lean: () => ({
      exec: async () => rows.filter((r) => filter._id.$in.includes(String(r._id))),
    }),
  }),
});

function make(rows: Record<string, unknown>[], memberships: unknown[] = []) {
  const audit = { findForTenant: jest.fn(async () => rows) };
  const members = {
    byIdsAnywhereForAudit: jest.fn(async (ids: string[]) =>
      (memberships as { _id: string }[]).filter((m) => ids.includes(m._id))),
  };
  const service = new AuditReadService(
    audit as never,
    model([
      { _id: ROOT, fullName: 'Root Operator' },
      { _id: OWNER, fullName: 'Rangga Wibisono' },
    ]) as never,
    members as never,
    model([{ _id: KPM, code: '0417', branchName: 'Surabaya Branch' }]) as never,
    model([{ _id: CO, name: 'Prudential' }]) as never,
  );
  return { service, audit, members };
}

/**
 * Reading the audit log with the people and the things named (client feedback, 2026-09-24).
 *
 * Every row said `memberships 68f3c1a9…`, so answering *"who suspended Surabaya?"* meant three
 * lookups in a database shell — which is the question this screen exists to answer.
 */
describe('AuditReadService', () => {
  it('names the actor and the office', async () => {
    const { service } = make([row()]);

    const [entry] = await service.findForTenant(null);

    expect(entry).toMatchObject({
      actorName: 'Root Operator',
      targetLabel: '0417 · Surabaya Branch',
      targetId: KPM,
    });
  });

  it('names both people for an impersonated action', async () => {
    // Under impersonation both are recorded. Naming only one would attribute the action to
    // the wrong person.
    const { service } = make([row({ effectiveUserId: OWNER })]);

    const [entry] = await service.findForTenant(null);

    expect(entry).toMatchObject({ actorName: 'Root Operator', effectiveName: 'Rangga Wibisono' });
  });

  it('names a company', async () => {
    const { service } = make([row({ targetCollection: 'companies', targetId: CO })]);

    expect((await service.findForTenant(null))[0].targetLabel).toBe('Prudential');
  });

  it('names a membership through the person it belongs to', async () => {
    const { service } = make(
      [row({ targetCollection: 'memberships', targetId: MEM })],
      [{ _id: MEM, userId: OWNER, agentCode: 'AG-1' }],
    );

    expect((await service.findForTenant(null))[0].targetLabel).toBe('Rangga Wibisono · AG-1');
  });

  it('reads memberships through the repository’s named cross-tenant method', async () => {
    // Invariant §1: a Super Admin's cross-tenant read is an explicitly named method, never
    // an absent filter. `repositories.tenancy.spec.ts` enforces the other half.
    const { service, members } = make(
      [row({ targetCollection: 'memberships', targetId: MEM })],
      [{ _id: MEM, userId: OWNER, agentCode: null }],
    );

    await service.findForTenant(null);

    expect(members.byIdsAnywhereForAudit).toHaveBeenCalledWith([MEM]);
  });

  it('keeps the id when nothing names it', async () => {
    // A collection nobody has taught the resolver about is *this is all we know*, not
    // *nothing happened* — so the screen is given the id rather than a blank.
    const { service } = make([row({ targetCollection: 'goals', targetId: 'g-9' })]);

    const [entry] = await service.findForTenant(null);

    expect(entry).toMatchObject({ targetLabel: null, targetId: 'g-9' });
  });

  it('survives an id that is not an ObjectId, rather than failing the page', async () => {
    // `$in` throws a CastError on a malformed id, which would take every row down with it.
    const { service } = make([row({ targetCollection: 'kpms', targetId: 'not-an-id' })]);

    const [entry] = await service.findForTenant(null);

    expect(entry).toMatchObject({ targetLabel: null, targetId: 'not-an-id' });
  });

  it('carries the mutation through unchanged', async () => {
    const { service } = make([row({ before: { status: 'active' }, after: { status: 'suspended' } })]);

    const [entry] = await service.findForTenant(null);

    expect(entry).toMatchObject({
      before: { status: 'active' }, after: { status: 'suspended' },
    });
  });

  it('asks each collection once, however many rows name it', async () => {
    // A hundred rows cost a handful of reads, not two hundred.
    const { service, audit } = make([row(), row({ _id: 'a-2' }), row({ _id: 'a-3' })]);

    const rows = await service.findForTenant(null);

    expect(rows).toHaveLength(3);
    expect(audit.findForTenant).toHaveBeenCalledTimes(1);
    expect(rows.every((r) => r.targetLabel === '0417 · Surabaya Branch')).toBe(true);
  });
});
