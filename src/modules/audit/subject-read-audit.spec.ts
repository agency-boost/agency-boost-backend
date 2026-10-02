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
  const audit = {
    record: jest.fn(async (ctx: RequestContext, entry: AuditEntry) => {
      recorded.push({ ctx, entry });
      return record(ctx, entry);
    }),
  };
  return { reads: new SubjectReadAudit(audit as never), recorded, audit };
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
});
