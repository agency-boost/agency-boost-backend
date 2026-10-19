import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { configModule } from '../../../test/config-module';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { CalendarEvent, CalendarEventSchema } from './calendar-event.schema';
import { CalendarEventRepository } from './calendar-event.repository';

const NOW = new Date('2026-09-14T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const SARI = '66f0000000000000000000c1';
const RINA = '66f0000000000000000000c2';
const BUDI = '66f0000000000000000000c3';
const as = (kpmId: string, membershipId: string) => new RequestContext('u', 'none', {
  membershipId, kpmId, orgLevelCode: 'AAB', hierarchyRole: 'aab', status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 1,
} as never);

/**
 * **The calendar's writes, at the chokepoint** (invariant §1; P12-T2 AC-8, P12-T4 AC-5): each pinned to
 * its office, its organiser and its version; an answer touching one attendance and nothing else; an edit
 * whose typed text can never be read as an operator; and a race between two writers answered by
 * the service as the contract says.
 */
describe('calendarEvents, written through the tenant repository', () => {
  let repo: CalendarEventRepository;
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    repo = new CalendarEventRepository(mongoose.model(CalendarEvent.name, CalendarEventSchema) as never);
    wired = configModule(NOW);
  });
  afterAll(stopMongo);
  beforeEach(clearCollections);

  const seed = (kpmId = KPM_A, attendees: unknown[] = [
    { membershipId: RINA, placed: false, answer: 'pending', answeredAt: null, addedAt: NOW },
    { membershipId: BUDI, placed: true, answer: null, answeredAt: null, addedAt: NOW },
  ]) => repo.create(as(kpmId, SARI), {
    organiserMembershipId: SARI, type: 'meeting', title: 'Standup', notes: '',
    startsAt: new Date('2026-09-15T02:00:00Z'), endsAt: new Date('2026-09-15T02:30:00Z'), startsOn: null, endsOn: null,
    attendees,
    version: 1,
  } as never);
  /** Office A, for the service's day: its zone is all the race needs. */
  const office = () => (wired.kpms as mongoose.Model<unknown>).create({
    _id: KPM_A, companyId: 'c', code: '0417', branchName: 'A', timezone: 'Asia/Jakarta',
  });
  const fields = (title: string) => ({
    type: 'meeting' as const, title, notes: '$attendees', startsAt: new Date('2026-09-15T03:00:00Z'),
    endsAt: new Date('2026-09-15T04:00:00Z'), startsOn: null, endsOn: null,
  });

  it('P12-T2 AC-8 an edit lands only at its version, for its organiser, in its office; text stays text', async () => {
    const entry = await seed();
    const id = String(entry._id);
    const pin = { organiserMembershipId: SARI, version: 1 };
    expect(await repo.editIfAt(as(KPM_A, SARI), 'not-an-id', pin, fields('x'), { removed: [], added: [] }, NOW)).toBeNull();
    expect(await repo.editIfAt(as(KPM_A, SARI), id, { ...pin, version: 2 }, fields('x'), { removed: [], added: [] }, NOW)).toBeNull();
    expect(await repo.editIfAt(as(KPM_A, RINA), id, { ...pin, organiserMembershipId: RINA }, fields('x'), { removed: [], added: [] }, NOW)).toBeNull();
    expect(await repo.editIfAt(as(KPM_B, SARI), id, pin, fields('x'), { removed: [], added: [] }, NOW)).toBeNull();

    const edited = await repo.editIfAt(as(KPM_A, SARI), id, pin, fields('$title'), { removed: [RINA, BUDI], added: [] }, NOW);
    // A title and notes that look like field paths are stored as typed; the placed member is never dropped.
    expect(edited).toMatchObject({ title: '$title', notes: '$attendees', version: 2, updatedBy: SARI });
    expect(edited!.attendees.map((a) => a.membershipId)).toEqual([BUDI]);
  });

  it('P12-T2 AC-9 a delete lands only at its version, for its organiser', async () => {
    const entry = await seed();
    const id = String(entry._id);
    expect(await repo.deleteIfAt(as(KPM_A, SARI), 'not-an-id', { organiserMembershipId: SARI, version: 1 }, NOW)).toBeNull();
    expect(await repo.deleteIfAt(as(KPM_A, SARI), id, { organiserMembershipId: SARI, version: 3 }, NOW)).toBeNull();
    expect(await repo.deleteIfAt(as(KPM_A, SARI), id, { organiserMembershipId: SARI, version: 1 }, NOW))
      .toMatchObject({ deletedAt: NOW });
  });

  it('P12-T4 AC-5 an answer is an invitee’s own attendance: never the placed member’s, and nothing else moves', async () => {
    const entry = await seed();
    const id = String(entry._id);
    expect(await repo.answer(as(KPM_A, RINA), 'not-an-id', RINA, 'accepted', NOW)).toBeNull();
    expect(await repo.answer(as(KPM_A, BUDI), id, BUDI, 'accepted', NOW)).toBeNull();
    expect(await repo.answer(as(KPM_B, RINA), id, RINA, 'accepted', NOW)).toBeNull();
    const answered = await repo.answer(as(KPM_A, RINA), id, RINA, 'declined', NOW);
    expect(answered).toMatchObject({ version: 1, updatedBy: SARI });
    expect(answered!.attendees[0]).toMatchObject({ answer: 'declined', answeredAt: NOW });
    expect(answered!.get('updatedAt')).toEqual(entry.get('updatedAt'));
  });

  it('N3 D-leave a pull takes a member off the future entries of its own office alone, and off no entry that has ended', async () => {
    const inA = await seed();
    const inB = await seed(KPM_B);
    const ended = await repo.create(as(KPM_A, SARI), {
      organiserMembershipId: SARI, type: 'meeting', title: 'Yesterday', notes: '',
      startsAt: new Date('2026-09-13T02:00:00Z'), endsAt: new Date('2026-09-13T03:00:00Z'), startsOn: null, endsOn: null,
      attendees: [{ membershipId: RINA, placed: false, answer: 'pending', answeredAt: null, addedAt: NOW }],
      version: 1,
    } as never);
    const attendeesOf = async (doc: { _id: unknown }) => ((await mongoose.connection.db!.collection('calendarEvents')
      .findOne({ _id: doc._id as mongoose.Types.ObjectId }))!.attendees as { membershipId: string }[]).map((a) => a.membershipId);

    // Office A's pull of Rina: its own future entry alone — never office B's under the same id, nor a past one.
    expect(await repo.pullFromFuture(as(KPM_A, SARI), RINA, NOW)).toBe(1);
    expect(await attendeesOf(inA)).toEqual([BUDI]);
    expect(await attendeesOf(inB)).toEqual([RINA, BUDI]);
    expect(await attendeesOf(ended)).toEqual([RINA]);
    // And from office B's side, a placed member too: office A's entry is not touched.
    expect(await repo.pullFromFuture(as(KPM_B, SARI), BUDI, NOW)).toBe(1);
    expect(await attendeesOf(inB)).toEqual([RINA]);
    expect(await attendeesOf(inA)).toEqual([BUDI]);
    // An office with nothing of theirs writes nothing.
    expect(await repo.pullFromFuture(as(KPM_B, SARI), 'nobody', NOW)).toBe(0);
  });

  it('P12-T2 AC-8 an edit that loses a race is answered 409 when the entry moved on, and 404 when it is gone', async () => {
    await office();
    // Nobody on it: an edit of a future entry checks everybody on it (N1), and the race is about the version.
    const entry = await seed(KPM_A, []);
    const id = String(entry._id);
    const original = wired.calendarEntries.editIfAt.bind(wired.calendarEntries);
    // Another device saves first, between the read and this write.
    jest.spyOn(wired.calendarEntries, 'editIfAt').mockImplementationOnce(async (...args) => {
      await mongoose.connection.db!.collection('calendarEvents').updateOne({ _id: entry._id }, { $set: { version: 2 } });
      return original(...args);
    });
    await expect(wired.calendar.update(as(KPM_A, SARI), id, { version: 1, title: 'Late' }))
      .rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT', details: { expectedVersion: 1, actualVersion: 2 } } });
    jest.spyOn(wired.calendarEntries, 'editIfAt').mockImplementationOnce(async (...args) => {
      await mongoose.connection.db!.collection('calendarEvents').updateOne({ _id: entry._id }, { $set: { deletedAt: NOW } });
      return original(...args);
    });
    await expect(wired.calendar.update(as(KPM_A, SARI), id, { version: 2, title: 'Late' }))
      .rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });

  it('P12-T2 AC-9 a delete that loses a race is answered 409', async () => {
    await office();
    const entry = await seed();
    const original = wired.calendarEntries.deleteIfAt.bind(wired.calendarEntries);
    jest.spyOn(wired.calendarEntries, 'deleteIfAt').mockImplementationOnce(async (...args) => {
      await mongoose.connection.db!.collection('calendarEvents').updateOne({ _id: entry._id }, { $set: { version: 2 } });
      return original(...args);
    });
    await expect(wired.calendar.remove(as(KPM_A, SARI), String(entry._id), 1))
      .rejects.toMatchObject({ response: { code: 'VERSION_CONFLICT' } });
  });

  it('P12-T4 AC-6 an answer that loses a race with the organiser taking them off is 404', async () => {
    await office();
    const entry = await seed();
    const original = wired.calendarEntries.answer.bind(wired.calendarEntries);
    jest.spyOn(wired.calendarEntries, 'answer').mockImplementationOnce(async (...args) => {
      await mongoose.connection.db!.collection('calendarEvents').updateOne({ _id: entry._id }, { $pull: { attendees: { membershipId: RINA } } } as never);
      return original(...args);
    });
    await expect(wired.calendar.answer(as(KPM_A, RINA), String(entry._id), 'accepted'))
      .rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });

  it('a caller in no office is told so, on every service route', async () => {
    const nobody = new RequestContext('u', 'none', null);
    for (const call of [
      () => wired.calendar.read(nobody, {}),
      () => wired.calendar.readOne(nobody, 'x'),
      () => wired.calendar.create(nobody, { type: 'task' }),
      () => wired.calendar.update(nobody, 'x', { version: 1 }),
      () => wired.calendar.remove(nobody, 'x', 1),
      () => wired.calendar.answer(nobody, 'x', 'accepted'),
      () => wired.calendar.block(nobody, { type: 'task', membershipId: 'x' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ response: { code: 'TENANT_NO_MEMBERSHIP' } });
    }
  });
});
