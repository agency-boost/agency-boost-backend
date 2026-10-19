import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { CalendarService } from './calendar.service';

const ctx = new RequestContext('u', 'none', {
  membershipId: 'me', kpmId: '66f0000000000000000000a1', orgLevelCode: 'MANAGER', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never);

/**
 * **The period read's own fallbacks**, with the collaborators stubbed: an office with no company has no
 * ladder, so a rung is labelled by its code; a reader whose name cannot be read is answered an empty one.
 * The HTTP specs read the office as it is; this pins what a gap in it answers, rather than an error.
 */
describe('CalendarService, at the edges of what it reads', () => {
  it('labels the subject’s rung by its code with no ladder, and an unreadable name as empty', async () => {
    const service = new CalendarService(
      { overlapping: async () => [] } as never,
      {} as never,
      {} as never,
      { byMembershipId: async () => new Map() } as never,
      { list: async () => { throw new Error('no ladder to read'); } } as never,
      { office: async () => ({ today: '2026-09-14', month: '2026-09', timezone: 'Asia/Jakarta', companyId: null }) } as never,
      {} as never,
      {} as never,
      {} as never,
      new FixedClock(new Date('2026-09-14T03:00:00Z')),
    );
    const read = await service.read(ctx, {});
    expect(read.subject).toEqual({ membershipId: 'me', name: '', rung: { code: 'MANAGER', label: 'MANAGER' } });
    expect(read.entries).toEqual([]);
  });

  it('m2 an empty `for` is nobody, refused as naming oneself is — never read as the reader’s own calendar', async () => {
    const subject = jest.fn();
    const service = new CalendarService(
      {} as never,
      {} as never,
      { subject } as never,
      {} as never,
      {} as never,
      { office: async () => ({ today: '2026-09-14', month: '2026-09', timezone: 'Asia/Jakarta', companyId: null }) } as never,
      {} as never,
      {} as never,
      {} as never,
      new FixedClock(new Date('2026-09-14T03:00:00Z')),
    );
    for (const named of ['', 'me']) {
      await expect(service.read(ctx, { for: named })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(subject).not.toHaveBeenCalled();
  });
});
