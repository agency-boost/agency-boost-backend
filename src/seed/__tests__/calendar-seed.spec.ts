import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { addDays } from '@/common/time/local-day';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import type { CalendarEntryView, CalendarPeriodView } from '@/modules/calendar/calendar-view';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { CALENDAR_WORDS as T } from '../calendar-fixture';
import { seedDemo, type SeedResult } from '../demo';

/**
 * **The calendar's demo week and month** (Phase 12, *Seed*; `calendar-fixture.ts`), run as the command
 * runs it and read back through the calendar's own service — so what is asserted is what each account
 * sees on `/calendar`, not what a row holds.
 *
 * Run on two dates: 03:00 on a Monday in Jakarta, while it is still Sunday in UTC — the day the office's
 * zone and the server's disagree about the week — and 10:00 on a Friday.
 */
const RUN_MS = 240_000;
const TZ = 'Asia/Jakarta';
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

async function memberOf(email: string) {
  const kpm = await col('kpms').findOne({ code: '0417' });
  const account = await col('users').findOne({ email });
  return (await col('memberships').findOne({ kpmId: String(kpm!._id), userId: String(account!._id), status: 'active' }))!;
}

async function as(email: string): Promise<RequestContext> {
  const member = await memberOf(email);
  const directs = await col('memberships').countDocuments({ leaderId: String(member._id), status: 'active' });
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
    status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: directs,
  } as never);
}

const titles = (period: CalendarPeriodView) => period.entries.map((e) => ('title' in e ? e.title : 'Busy'));
const named = (period: CalendarPeriodView, title: string) =>
  period.entries.find((e): e is CalendarEntryView => 'title' in e && e.title === title);

describe.each([
  ['03:00 on Monday 5 October 2026 in Jakarta, still Sunday in UTC', '2026-10-04T20:00:00Z', '2026-10-05'],
  ['10:00 on Friday 2 October 2026 in Jakarta', '2026-10-02T03:00:00Z', '2026-09-28'],
])('the calendar seed, run at %s', (_when, instant, monday) => {
  const clock = new FixedClock(new Date(instant));
  const today = clock.localDateFor(TZ);
  let first: SeedResult;
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    first = await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
  }, RUN_MS);
  afterAll(stopMongo);

  it('Seed: dates are the office’s — this week is the Jakarta Monday holding the run’s Jakarta today', () => {
    expect(first.calendar.today).toBe(today);
    expect(first.calendar.monday).toBe(monday);
    expect(first.written.calendarEvents).toBe(first.calendar.entries.length);
  });

  it('Seed: Agus’s week in the prototype’s rhythm — two standups, the goal review, a task, a two-day trip, his client review', async () => {
    const week = await wired.calendar.read(await as('agus@kpm0417.test'), {});
    expect(week.from).toBe(monday);
    const standups = week.entries.filter((e) => 'title' in e && e.title === T.standup) as CalendarEntryView[];
    expect(standups.map((e) => [e.date, e.start, e.end])).toEqual([[monday, '09:00', '09:30'], [addDays(monday, 3), '09:00', '09:30']]);
    expect(titles(week)).toEqual(expect.arrayContaining([
      T.goalReview, T.prospecting, T.trip, T.clientReview,
      T.aabSync, T.pipeline, T.blockOnIndah, T.oneToOne('Indah Permatasari'),
    ]));
    expect(named(week, T.trip)).toMatchObject({ allDay: true, startsOn: addDays(monday, 4), endsOn: addDays(monday, 5) });
    expect(named(week, T.clientReview)!.notes).toContain('Jl. Sudirman No. 12');
    // His 1:1 with Indah is today, the day his draft with her is open; its chip opens her session.
    expect(named(week, T.oneToOne('Indah Permatasari'))).toMatchObject({ date: today, invitees: [expect.objectContaining({ readerCoaches: true })] });
  });

  it('Seed: invitations in every state — the standup accepted by Indah and Sari, the goal review pending for Sari, the huddle declined by Rina', async () => {
    const sari = await wired.calendar.read(await as('sari@kpm0417.test'), {});
    expect(named(sari, T.standup)).toMatchObject({ readerIs: 'invitee', myAnswer: 'accepted' });
    expect(named(sari, T.goalReview)).toMatchObject({ readerIs: 'invitee', myAnswer: 'pending' });
    const indah = await wired.calendar.read(await as('indah@kpm0417.test'), {});
    expect(named(indah, T.standup)).toMatchObject({ myAnswer: 'accepted' });

    const rinaCtx = await as('rina@kpm0417.test');
    const rina = await wired.calendar.read(rinaCtx, {});
    expect(titles(rina)).not.toContain(T.huddle);
    expect(titles(rina)).toEqual(expect.arrayContaining([T.clientMeeting, T.spaj]));
    await expect(wired.calendar.readOne(rinaCtx, first.calendar.marked.declinedHuddle)).resolves.toMatchObject({ myAnswer: 'declined' });
  });

  it('P18.7-T8 AC-2 Seed: Agus’s week holds a Zoom address and another meeting address, so Join Zoom and Join meeting can be walked', async () => {
    const week = await wired.calendar.read(await as('agus@kpm0417.test'), {});
    expect(named(week, T.standup)!.notes).toBe(T.zoom);
    expect(named(week, T.goalReview)!.notes).toBe(T.goalReviewNotes);
  });

  it('P18.7-T8 AC-2 Seed: Agus compares Sari’s month too — the same projection as her week, her client visit in full', async () => {
    const sari = await memberOf('sari@kpm0417.test');
    const month = await wired.calendar.read(await as('agus@kpm0417.test'), { view: 'month', for: String(sari._id) });
    expect(month.view).toBe('month');
    expect(named(month, T.clientVisit)).toMatchObject({ type: 'client', readerIs: 'ancestor' });
    expect(titles(month)).not.toContain(T.leadersReview);
  });

  it('Seed: Agus compares Sari — her client visit in full, address and all; the Owner’s review she attends is busy', async () => {
    const sari = await memberOf('sari@kpm0417.test');
    const pane = await wired.calendar.read(await as('agus@kpm0417.test'), { for: String(sari._id) });
    expect(named(pane, T.clientVisit)).toMatchObject({
      type: 'client', readerIs: 'ancestor', notes: T.clientVisitNotes,
    });
    expect(titles(pane)).not.toContain(T.leadersReview);
    expect(pane.entries.filter((e) => 'busy' in e)).toEqual([expect.objectContaining({ date: addDays(monday, 3), start: '15:00' })]);
  });

  it('Seed: Agus’s block on Indah is placed, read with Close alone, and announced once', async () => {
    const indah = await wired.calendar.read(await as('indah@kpm0417.test'), {});
    expect(named(indah, T.blockOnIndah)).toMatchObject({ readerIs: 'placed', myAnswer: null });
    const member = await memberOf('indah@kpm0417.test');
    const notices = await col('notifications').find({ userId: String(member.userId), templateId: NotificationTemplate.CALENDAR_BLOCK_PLACED }).toArray();
    expect(notices.map((n) => n.payload)).toEqual([{ entryId: first.calendar.marked.agusBlockOnIndah, date: addDays(monday, 2) }]);
  });

  it('Seed: Sari’s pending invitation has its notice; no notice holds anything typed', async () => {
    const member = await memberOf('sari@kpm0417.test');
    const notices = await col('notifications').find({ userId: String(member.userId), templateId: NotificationTemplate.CALENDAR_INVITATION }).toArray();
    expect(notices.map((n) => [n.payload, n.readAt])).toEqual([[{ entryId: first.calendar.marked.goalReview, date: addDays(monday, 2) }, null]]);
    const calendarNotices = await col('notifications').find({ templateId: { $regex: '^calendar\\.' } }).toArray();
    expect(JSON.stringify(calendarNotices.map((n) => n.payload))).not.toMatch(/Goal review|Tanjung|Hartono|Indah Permatasari/);
  });

  it('Seed: Rina’s declined huddle opens from its invitation notice, read when she answered it', async () => {
    const member = await memberOf('rina@kpm0417.test');
    const notices = await col('notifications').find({ userId: String(member.userId), templateId: NotificationTemplate.CALENDAR_INVITATION }).toArray();
    const huddle = first.calendar.entries.find((e) => e._id === first.calendar.marked.declinedHuddle)!;
    const declined = huddle.attendees.find((a) => a.membershipId === String(member._id))!;
    expect(declined).toMatchObject({ answer: 'declined' });
    expect(notices.map((n) => [n.payload, n.readAt, n.createdAt])).toEqual([[
      { entryId: first.calendar.marked.declinedHuddle, date: addDays(monday, 1) }, declined.answeredAt, huddle.createdAt,
    ]]);
  });

  it('Seed: Sari’s weekly 1:1s with Rina fall on the days of her seeded sessions; Rina’s chip links nowhere', async () => {
    const rina = await memberOf('rina@kpm0417.test');
    const sari = await memberOf('sari@kpm0417.test');
    const theirs = first.coaching.sessions
      .filter((s) => s.coachMembershipId === String(sari._id) && s.coacheeMembershipId === String(rina._id) && s.status === 'finalized')
      .map((s) => s.date as string)
      .sort();
    expect(theirs).toHaveLength(3);
    const oneToOnes = first.calendar.entries
      .filter((e) => e.title === T.oneToOne('Rina Wijaya'))
      .map((e) => clock.localDateFor(TZ, e.startsAt))
      .sort();
    expect(oneToOnes).toEqual(theirs);
    const rinaWeek = await wired.calendar.read(await as('rina@kpm0417.test'), { date: theirs.at(-1) });
    const entry = named(rinaWeek, T.oneToOne('Rina Wijaya'))!;
    expect(entry.invitees.every((i) => i.readerCoaches === false)).toBe(true);
  });

  it('Seed: the month shows a day with more than three lines, and a day of the next or last month with entries', async () => {
    const month = await wired.calendar.read(await as('agus@kpm0417.test'), { view: 'month' });
    const perDay = new Map<string, number>();
    for (const e of month.entries) {
      const date = 'date' in e && e.date ? e.date : null;
      if (date) perDay.set(date, (perDay.get(date) ?? 0) + 1);
    }
    expect(perDay.get(first.calendar.marked.busiestDay)).toBeGreaterThan(3);
    const padding = month.days.filter((d) => !d.inPeriod).map((d) => d.date);
    expect(padding.some((date) => (perDay.get(date) ?? 0) > 0)).toBe(true);
  });

  it('P19.8-T3 AC-9 Seed: Agus’s Agenda from today holds Kickoff tim 2026 four days on, 09:00 to 13:00; his week two events at 09:00', async () => {
    const agus = await as('agus@kpm0417.test');
    const agenda = await wired.calendar.read(agus, { view: 'agenda', date: today });
    const kickoff = named(agenda, T.kickoff)!;
    expect([kickoff.date, kickoff.start, kickoff.end]).toEqual([addDays(today, 4), '09:00', '13:00']);
    const week = await wired.calendar.read(agus, {});
    const atNine = week.entries.filter((e) => 'title' in e && e.title === T.standup && e.start === '09:00');
    expect(atNine).toHaveLength(2);
  });

  it('Seed: a second run on the same day writes nothing', async () => {
    const second = await seedDemo({ clock, log: quiet });
    expect(second.written).toEqual({});
    expect(second.calendar.entries.map((e) => e._id)).toEqual(first.calendar.entries.map((e) => e._id));
  }, RUN_MS);
});
