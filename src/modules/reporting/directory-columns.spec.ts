import { RequestContext } from '@/common/context/request-context';
import { COACHING_STATUS } from '@/domain/constants/coaching-status';
import { USAGE } from '@/domain/constants/usage';
import type { DirectoryPage } from '@/modules/org/directory.service';
import { DirectoryColumns } from './directory-columns';

const CTX = new RequestContext('u-owner', 'none', {
  membershipId: 'm-owner', kpmId: 'k', orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: true, isKpmAdmin: false, directCount: 1,
} as never);

/** Five members: logged today, at the 14-day edge, one day past it, never; and one pending. */
function page(): DirectoryPage {
  const row = (membershipId: string, status = 'active') => ({ membershipId, status }) as never;
  return { members: [row('today'), row('edge'), row('past'), row('never'), row('waiting', 'pending')], nextCursor: null, counts: { directory: 4, pending: 1, removed: 0 } };
}

describe('P19.20-T1 AC-2 All members’ two pills, the server’s buckets (ADR-0267 §4, §5)', () => {
  const days: Record<string, number | null> = { today: 0, edge: USAGE.RECENT_MAX_DAYS, past: USAGE.RECENT_MAX_DAYS + 1, never: null };
  const coached: Record<string, number | null> = { today: 1, edge: COACHING_STATUS.RECENT_MAX_DAYS, past: COACHING_STATUS.RECENT_MAX_DAYS + 1, never: null };
  const columns = new DirectoryColumns(
    { lastLoggedOnMany: async (_c: unknown, ids: string[]) => new Map(ids.map((id) => [id, days[id] === null ? null : `d-${days[id]}`]).filter(([, v]) => v !== null) as [string, string][]) } as never,
    { recencyOf: async (_c: unknown, ids: string[]) => new Map(ids.map((id) => [id, { daysSinceLastCoaching: coached[id] }])) } as never,
    { for: async () => ({ today: '2026-11-20', timezone: 'Asia/Jakarta' }) } as never,
    { daysBetween: (_z: string, last: string) => Number(last.slice(2)) } as never,
    { recordMany: async () => undefined } as never,
  );

  it('P19.20-T1 AC-2 Aktivitas terakhir: green within 14 days, yellow after, red never', async () => {
    const out = await columns.decorate(CTX, page());
    const status = new Map(out.members.map((m) => [m.membershipId, m.lastActivityStatus]));

    expect(Object.fromEntries(status)).toEqual({ today: 'recent', edge: 'recent', past: 'lapsed', never: 'never', waiting: undefined });
  });

  it('P19.20-T1 AC-2 Coaching terakhir: green within 14 days, yellow after, red never', async () => {
    const out = await columns.decorate(CTX, page());

    expect(out.members.map((m) => m.lastCoachedStatus)).toEqual(['recent', 'recent', 'lapsed', 'never', undefined]);
  });
});
