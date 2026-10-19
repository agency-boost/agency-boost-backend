import { AuditReadService } from './audit-read.service';

const KPM = '66f0000000000000000000a1';
const CO = '66f0000000000000000000c1';
const ROOT = '66f0000000000000000000e1';
const OWNER = '66f0000000000000000000e2';
const MEM = '66f0000000000000000000d1';
/** The person reading the log: an Owner, say, who is also an AB somebody above them coaches. */
const READER = '66f0000000000000000000e3';
/** Two of the reader's memberships — one now, one from before they left and rejoined — and somebody else's. */
const READER_NOW = '66f0000000000000000000d2';
const READER_BEFORE = '66f0000000000000000000d3';
const SOMEBODY = '66f0000000000000000000d4';

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

    const [entry] = await service.findForTenant(null, 100, READER);

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

    const [entry] = await service.findForTenant(null, 100, READER);

    expect(entry).toMatchObject({ actorName: 'Root Operator', effectiveName: 'Rangga Wibisono' });
  });

  it('names a company', async () => {
    const { service } = make([row({ targetCollection: 'companies', targetId: CO })]);

    expect((await service.findForTenant(null, 100, READER))[0].targetLabel).toBe('Prudential');
  });

  it('names a membership through the person it belongs to', async () => {
    const { service } = make(
      [row({ targetCollection: 'memberships', targetId: MEM })],
      [{ _id: MEM, userId: OWNER, agentCode: 'AG-1' }],
    );

    expect((await service.findForTenant(null, 100, READER))[0].targetLabel).toBe('Rangga Wibisono · AG-1');
  });

  it('reads memberships through the repository’s named cross-tenant method', async () => {
    // Invariant §1: a Super Admin's cross-tenant read is an explicitly named method, never
    // an absent filter. `repositories.tenancy.spec.ts` enforces the other half.
    const { service, members } = make(
      [row({ targetCollection: 'memberships', targetId: MEM })],
      [{ _id: MEM, userId: OWNER, agentCode: null }],
    );

    await service.findForTenant(null, 100, READER);

    expect(members.byIdsAnywhereForAudit).toHaveBeenCalledWith([MEM]);
  });

  it('keeps the id when nothing names it', async () => {
    // A collection nobody has taught the resolver about is *this is all we know*, not
    // *nothing happened* — so the screen is given the id rather than a blank.
    const { service } = make([row({ targetCollection: 'goals', targetId: 'g-9' })]);

    const [entry] = await service.findForTenant(null, 100, READER);

    expect(entry).toMatchObject({ targetLabel: null, targetId: 'g-9' });
  });

  it('survives an id that is not an ObjectId, rather than failing the page', async () => {
    // `$in` throws a CastError on a malformed id, which would take every row down with it.
    const { service } = make([row({ targetCollection: 'kpms', targetId: 'not-an-id' })]);

    const [entry] = await service.findForTenant(null, 100, READER);

    expect(entry).toMatchObject({ targetLabel: null, targetId: 'not-an-id' });
  });

  it('carries the mutation through unchanged', async () => {
    const { service } = make([row({ before: { status: 'active' }, after: { status: 'suspended' } })]);

    const [entry] = await service.findForTenant(null, 100, READER);

    expect(entry).toMatchObject({
      before: { status: 'active' }, after: { status: 'suspended' },
    });
  });

  describe('N1 a leader note’s rows are never served to the person it is about (ADR-0073)', () => {
    const noteRow = (id: string, action: string, coachee: string) => row({
      _id: id, action, targetCollection: 'leaderNotes', targetId: 'n-1', targetMembershipId: null,
      after: { authorMembershipId: 'm-coach', coacheeMembershipId: coachee },
    });
    const memberships = [
      { _id: READER_NOW, userId: READER, agentCode: 'AG-2' },
      { _id: READER_BEFORE, userId: READER, agentCode: 'AG-3' },
      { _id: SOMEBODY, userId: OWNER, agentCode: 'AG-4' },
    ];

    it('N1 drops leader_note.read and leader_note.saved about any membership of the reader’s, and serves the rest', async () => {
      const { service, members } = make([
        noteRow('n-read', 'leader_note.read', READER_NOW),
        noteRow('n-saved', 'leader_note.saved', READER_BEFORE),
        noteRow('n-other', 'leader_note.saved', SOMEBODY),
        row({ _id: 'kpm-row' }),
      ], memberships);

      const rows = await service.findForTenant('kpm-a', 100, READER);

      expect(rows.map((r) => r._id)).toEqual(['n-other', 'kpm-row']);
      // Matched by the person: the memberships the rows name are resolved to their users, once.
      expect(members.byIdsAnywhereForAudit).toHaveBeenCalledWith([READER_NOW, READER_BEFORE, SOMEBODY]);
    });

    it('N1 serves every note row to somebody they are not about', async () => {
      const { service } = make([
        noteRow('n-read', 'leader_note.read', READER_NOW), noteRow('n-other', 'leader_note.saved', SOMEBODY),
      ], memberships);

      expect((await service.findForTenant('kpm-a', 100, OWNER)).map((r) => r._id)).toEqual(['n-read']);
      expect((await service.findForTenant('kpm-a', 100, ROOT)).map((r) => r._id)).toEqual(['n-read', 'n-other']);
    });

    it('N1 a row about a membership nobody can resolve, or naming none, is served; a log with no note row asks nothing more', async () => {
      const { service, members } = make([
        noteRow('n-unknown', 'leader_note.read', '66f0000000000000000000dd'),
        noteRow('n-blank', 'leader_note.read', 'not-an-id'),
        row({ _id: 'n-none', action: 'leader_note.saved', after: null }),
      ], memberships);
      expect((await service.findForTenant('kpm-a', 100, READER)).map((r) => r._id)).toEqual(['n-unknown', 'n-blank', 'n-none']);
      expect(members.byIdsAnywhereForAudit).toHaveBeenCalledWith(['66f0000000000000000000dd']);

      const plain = make([row()], memberships);
      await plain.service.findForTenant(null, 100, READER);
      // The office's own label lookups only: no membership is resolved for a page with no note row.
      expect(plain.members.byIdsAnywhereForAudit).toHaveBeenCalledTimes(1);
      expect(plain.members.byIdsAnywhereForAudit).toHaveBeenCalledWith([]);
    });
  });

  it('asks each collection once, however many rows name it', async () => {
    // A hundred rows cost a handful of reads, not two hundred.
    const { service, audit } = make([row(), row({ _id: 'a-2' }), row({ _id: 'a-3' })]);

    const rows = await service.findForTenant(null, 100, READER);

    expect(rows).toHaveLength(3);
    expect(audit.findForTenant).toHaveBeenCalledTimes(1);
    expect(rows.every((r) => r.targetLabel === '0417 · Surabaya Branch')).toBe(true);
  });
});
