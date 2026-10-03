import { Logger } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { CalendarNotices } from './calendar-notices';

const KPM = '66f0000000000000000000a1';
const ENTRY = '66f0000000000000000000e1';
const RINA = '66f0000000000000000000c1';
const BUDI = '66f0000000000000000000c2';
const ctx = RequestContext.forJob(KPM, 'spec');

/** A member as the recipients' lookup answers one. */
const member = (id: string) => ({ _id: id, userId: `u-${id}` });

/**
 * **A notice never fails the write that caused it** (ADR-0095; `functional/calendar.md`, *Notifications*):
 * every way a send can go wrong — one recipient's send, the lookup of who they are, the held email's
 * release, thrown or rejected — is caught and logged at error level, and the others still go.
 */
describe('CalendarNotices', () => {
  let logged: jest.SpyInstance;
  beforeEach(() => {
    logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => logged.mockRestore());

  function build(over: { send?: jest.Mock; sendCoalesced?: jest.Mock; releaseHeld?: jest.Mock; find?: jest.Mock } = {}) {
    const notifications = {
      send: over.send ?? jest.fn(async () => undefined),
      sendCoalesced: over.sendCoalesced ?? jest.fn(async () => undefined),
      releaseHeld: over.releaseHeld ?? jest.fn(async () => undefined),
    };
    const memberships = { find: over.find ?? jest.fn(async (_ctx: unknown, filter: { _id: { $in: string[] } }) => filter._id.$in.map(member)) };
    return { notices: new CalendarNotices(notifications as never, memberships as never), notifications, memberships };
  }

  it('P12-T4 AC-7 an invitation goes to each member, by their account, with ids and a date and nothing else', async () => {
    const { notices, notifications } = build();
    await notices.invited(ctx, ENTRY, '2026-09-15', [RINA, BUDI, RINA]);
    expect(notifications.send.mock.calls.map(([request]) => request)).toEqual([
      { userId: `u-${RINA}`, membershipId: RINA, kpmId: KPM, templateId: NotificationTemplate.CALENDAR_INVITATION, payload: { entryId: ENTRY, date: '2026-09-15' } },
      { userId: `u-${BUDI}`, membershipId: BUDI, kpmId: KPM, templateId: NotificationTemplate.CALENDAR_INVITATION, payload: { entryId: ENTRY, date: '2026-09-15' } },
    ]);
  });

  it('P12-T5 AC-7 a block goes to its member once', async () => {
    const { notices, notifications } = build();
    await notices.placed(ctx, ENTRY, '2026-09-16', RINA);
    expect(notifications.send).toHaveBeenCalledTimes(1);
    expect(notifications.send.mock.calls[0][0]).toMatchObject({ templateId: NotificationTemplate.CALENDAR_BLOCK_PLACED, membershipId: RINA });
  });

  it('P12-T4 AC-7 a change coalesces by entry, member and kind, then releases its held email once', async () => {
    const { notices, notifications } = build();
    await notices.changed(ctx, ENTRY, '2026-09-17', 'moved', [RINA]);
    expect(notifications.sendCoalesced.mock.calls[0][0]).toEqual({
      userId: `u-${RINA}`, membershipId: RINA, kpmId: KPM, templateId: NotificationTemplate.CALENDAR_ENTRY_CHANGED,
      coalesceKey: `calendar:${ENTRY}:${RINA}:moved`, payload: { entryId: ENTRY, date: '2026-09-17', change: 'moved' },
    });
    expect(notifications.releaseHeld).toHaveBeenCalledWith(KPM, `calendar:${ENTRY}:${RINA}:moved`, NotificationTemplate.CALENDAR_ENTRY_CHANGED);
  });

  it('sends nothing, and looks nobody up, for nobody', async () => {
    const { notices, notifications, memberships } = build();
    await notices.invited(ctx, ENTRY, '2026-09-15', []);
    expect(memberships.find).not.toHaveBeenCalled();
    expect(notifications.send).not.toHaveBeenCalled();
  });

  it('leaves a malformed id out of the lookup rather than failing it', async () => {
    const { notices, memberships } = build();
    await notices.invited(ctx, ENTRY, '2026-09-15', ['not-an-id', RINA]);
    expect(memberships.find.mock.calls[0][1]).toEqual({ _id: { $in: [RINA] }, status: 'active' });
  });

  it('a send that fails is logged, and the others still go', async () => {
    const send = jest.fn(async (request: { membershipId: string }) => {
      if (request.membershipId === RINA) throw new Error('database down');
    });
    const { notices } = build({ send });
    await expect(notices.invited(ctx, ENTRY, '2026-09-15', [RINA, BUDI])).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ templateId: NotificationTemplate.CALENDAR_INVITATION }), 'failed to send a calendar notice');
  });

  it('a lookup that fails is logged, and nothing is thrown', async () => {
    const { notices, notifications } = build({ find: jest.fn(async () => { throw new Error('down'); }) });
    await expect(notices.placed(ctx, ENTRY, '2026-09-16', RINA)).resolves.toBeUndefined();
    expect(notifications.send).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(expect.anything(), 'failed to address calendar notices');
  });

  it('a held email whose release rejects, or throws before it can, is a log line and never the write’s failure', async () => {
    const rejecting = build({ releaseHeld: jest.fn(() => Promise.reject(new Error('smtp timeout'))) });
    await expect(rejecting.notices.changed(ctx, ENTRY, '2026-09-17', 'cancelled', [RINA])).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    const throwing = build({ releaseHeld: jest.fn(() => { throw new Error('no adapter'); }) });
    await expect(throwing.notices.changed(ctx, ENTRY, '2026-09-17', 'moved', [RINA])).resolves.toBeUndefined();
    expect(logged.mock.calls.filter(([, message]) => message === 'failed to send a calendar notice’s email')).toHaveLength(2);
  });
});
