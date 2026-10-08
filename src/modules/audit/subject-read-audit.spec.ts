import { Logger } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import type { AuditEntry } from './audit.service';
import { SUBJECT_READ_ACTION, SubjectReadAudit } from './subject-read-audit';

const leader = new RequestContext('u-leader', 'none', {
  membershipId: 'mem-leader', kpmId: 'kpm-a', orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 3,
});

/** An `AuditService` that keeps what it is handed, or refuses it. */
function seam(record: (ctx: RequestContext, entry: AuditEntry) => Promise<void> = async () => undefined) {
  const recorded: { ctx: RequestContext; entry: AuditEntry }[] = [];
  const inserts: AuditEntry[][] = [];
  const audit = {
    record: jest.fn(async (ctx: RequestContext, entry: AuditEntry) => {
      recorded.push({ ctx, entry });
      return record(ctx, entry);
    }),
    // Phase 15: many entries, one insert — refused the way `record` is told to refuse.
    recordMany: jest.fn(async (ctx: RequestContext, entries: AuditEntry[]) => {
      inserts.push(entries);
      for (const entry of entries) await record(ctx, entry);
    }),
  };
  return { reads: new SubjectReadAudit(audit as never), recorded, audit, inserts };
}

/**
 * **The §3.5 read audit, as one seam** (P11-T3 AC-8). The behaviour through the activity reads is
 * `activity-read-audit.tenancy.spec.ts`'s; this is the seam's own contract.
 */
describe('SubjectReadAudit (P11-T3 AC-8)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('P11-T3 AC-8: writes the entry — the actor, the subject, the range and the surface', async () => {
    const { reads, recorded } = seam();

    await reads.record(leader, { membershipId: 'mem-agent' }, 'summary', { from: '2026-09-26', to: '2026-10-02' });

    expect(recorded).toEqual([{
      ctx: leader,
      entry: {
        action: 'activity_log.read_raw',
        targetCollection: 'memberships',
        targetId: 'mem-agent',
        targetMembershipId: 'mem-agent',
        after: { surface: 'summary', from: '2026-09-26', to: '2026-10-02' },
      },
    }]);
    expect(SUBJECT_READ_ACTION).toBe('activity_log.read_raw');
  });

  it('P11-T3 AC-8: a self-read writes none', async () => {
    const { reads, audit } = seam();

    await reads.record(leader, { membershipId: 'mem-leader' }, 'log', { from: '2026-10-02', to: '2026-10-02' });

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('P11-T3 AC-8 D-failopen: an entry that cannot be written fails open, logged at error level', async () => {
    const { reads } = seam(async () => { throw new Error('write concern timed out'); });
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(reads.record(leader, { membershipId: 'mem-agent' }, 'compliance', { from: null, to: '2026-10-02' }))
      .resolves.toBeUndefined();

    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'activity_log.read_raw', surface: 'compliance' }),
      'failed to write audit entry',
    );
  });

  describe('recordMany — one insert for a read of many members (Phase 15, D-audit)', () => {
    const week = { from: '2026-09-08', to: '2026-09-14' } as const;

    it('P15-T1 AC-7 writes one entry per member other than the reader, all in one insert', async () => {
      const { reads, inserts, audit } = seam();

      await reads.recordMany(
        leader,
        [{ membershipId: 'mem-leader' }, { membershipId: 'mem-a' }, { membershipId: 'mem-b' }, { membershipId: 'mem-a' }],
        'unit_dashboard',
        week,
      );

      expect(audit.recordMany).toHaveBeenCalledTimes(1);
      expect(audit.record).not.toHaveBeenCalled();
      expect(inserts[0]).toEqual(['mem-a', 'mem-b'].map((id) => ({
        action: 'activity_log.read_raw', targetCollection: 'memberships', targetId: id, targetMembershipId: id,
        after: { surface: 'unit_dashboard', ...week },
      })));
    });

    it('P15-T1 AC-7 the reader’s own row alone writes nothing', async () => {
      const { reads, audit } = seam();
      await reads.recordMany(leader, [{ membershipId: 'mem-leader' }], 'unit_dashboard', week);
      await reads.recordMany(leader, [], 'unit_dashboard', week);
      expect(audit.recordMany).not.toHaveBeenCalled();
    });

    it('P15-T1 AC-7 D-failopen: entries that cannot be written fail open, logged at error level', async () => {
      const { reads } = seam(async () => { throw new Error('write concern timed out'); });
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(reads.recordMany(leader, [{ membershipId: 'mem-a' }], 'unit_dashboard', week)).resolves.toBeUndefined();

      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'activity_log.read_raw', surface: 'unit_dashboard' }),
        'failed to write audit entries',
      );
    });
  });
});
