import { INestApplication, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import mongoose from 'mongoose';
import request from 'supertest';
import { PermissionsGuard } from '@/common/auth/permissions.guard';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { AuditService } from '@/modules/audit/audit.service';
import { HierarchyService } from '@/modules/org/hierarchy.service';
import { MemberDeparture } from '@/modules/org/member-departure.port';
import { MembershipHistory, MembershipHistorySchema } from '@/modules/org/membership-history.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { MembershipHistoryRepository } from '@/modules/org/org.repositories';
import { REMOVAL_CONFIRMATION, RemovalService } from '@/modules/org/removal.service';
import { RoleChangeService } from '@/modules/org/role-change.service';
import { NotificationTemplate } from '@/modules/notifications/notification.types';
import { CompanyOrgLevel, CompanyOrgLevelSchema } from '@/modules/tenants/company-org-level.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, seedLadder, startMongo, stopMongo, syncIndexes } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { productionPipe, session, StubAuth } from '../../../test/http-permissions';
import { listenOnLoopback } from '../../../test/listen';
import { CalendarController } from './calendar.controller';
import { CalendarPeopleService } from './calendar-people.service';
import { CalendarService, type CalendarEntryInput } from './calendar.service';

/** 10:00 on Friday 2 October 2026 in Jakarta. */
const NOW = new Date('2026-10-02T03:00:00Z');
const KPM_A = new mongoose.Types.ObjectId().toString();
const KPM_B = new mongoose.Types.ObjectId().toString();

type Rung = 'AB' | 'AAB' | 'AGENT';
type Name = 'ROOT' | 'AB' | 'AB2' | 'AAB' | 'AGENT' | 'AGENT2';

/**
 * **What leaving does to a calendar, and what a closed edge does to compare** (D-leave, confirmed
 * 2026-10-03; P12-T4 AC-8, P12-T5 AC-5; `functional/calendar.md`, *The entry's life*).
 *
 * The office is built through `HierarchyService.create`, and the member leaves through
 * `RemovalService.remove` — with the calendar's `MemberDeparture` handed to it as the application wires
 * it — and an edge closes through `HierarchyService.reparent`, so each happens exactly as it does in the
 * product. Office A:
 *
 * ```
 * ROOT (AB, the Owner)
 * ├── AB ── AAB ─┬── AGENT
 * │              └── AGENT2
 * └── AB2
 * ```
 */
describe('a member who leaves, and an edge that closes (D-leave)', () => {
  let wired: ReturnType<typeof configModule>;
  let hierarchy: HierarchyService;
  let members: MembershipRepository;
  let history: MembershipHistoryRepository;
  let roles: RoleChangeService;
  let audit: AuditService;
  let removals: RemovalService;
  let app: INestApplication;
  let m: Record<Name, string>;
  let seq = 0;
  const col = (name: string) => mongoose.connection.db!.collection(name);
  const rung: Record<Name, Rung> = { ROOT: 'AB', AB: 'AB', AB2: 'AB', AAB: 'AAB', AGENT: 'AGENT', AGENT2: 'AGENT' };
  const as = (who: Name) => new RequestContext(`u-${who}`, 'none', {
    membershipId: m[who], kpmId: KPM_A, orgLevelCode: rung[who], hierarchyRole: rung[who].toLowerCase(),
    status: 'active', isKpmOwner: who === 'ROOT', isKpmAdmin: false, directCount: 1,
  } as never);
  const entry = (day: string, over: Partial<CalendarEntryInput> = {}): CalendarEntryInput => ({
    type: 'meeting', title: `Meeting on ${day}`, date: day, start: '09:00', end: '10:00', ...over,
  });
  const stored = (entryId: string) => col('calendarEvents').findOne({ _id: new mongoose.Types.ObjectId(entryId) });

  beforeAll(async () => {
    await startMongo();
    const clock = new FixedClock(NOW);
    audit = new AuditService(mongoose.model(AuditLog.name, AuditLogSchema) as never);
    const kpms = mongoose.model(Kpm.name, KpmSchema);
    const users = mongoose.model(User.name, UserSchema);
    history = new MembershipHistoryRepository(mongoose.model(MembershipHistory.name, MembershipHistorySchema) as never);
    members = new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never);
    const orgLevels = new OrgLevelService(
      mongoose.model(CompanyOrgLevel.name, CompanyOrgLevelSchema) as never,
      mongoose.model(Company.name, CompanySchema) as never, kpms as never, audit, clock,
    );
    hierarchy = new HierarchyService(members, kpms as never, users as never, history, clock, orgLevels);
    const notifications = { send: async () => undefined };
    roles = new RoleChangeService(members, hierarchy, history, users as never, audit, notifications as never, clock);
    wired = configModule(NOW);
    // As the application wires it: the calendar's departure behind the org module's port.
    removals = new RemovalService(members, hierarchy, roles, history, audit, notifications as never, clock, wired.calendarLeave);
    await syncIndexes();

    // The calendar's routes over HTTP, behind the real guard and the production pipe, for what an
    // organiser's save answers once somebody on the entry has left.
    const moduleRef = await Test.createTestingModule({
      controllers: [CalendarController],
      providers: [
        { provide: CalendarService, useValue: wired.calendar },
        { provide: CalendarPeopleService, useValue: wired.calendarPeople },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(productionPipe());
    app.useGlobalFilters(new DomainExceptionFilter());
    app.useGlobalGuards(new StubAuth(), new PermissionsGuard(app.get(Reflector)));
    await app.init();
    await listenOnLoopback(app);
  });
  afterAll(async () => {
    await app?.close();
    await stopMongo();
  });

  beforeEach(async () => {
    await clearCollections();
    wired.sentNotifications.length = 0;
    wired.releasedNotifications.length = 0;
    seq += 1;
    const company = await mongoose.model(Company.name).create({ name: 'Prudential', slug: `pru-cal-${seq}` });
    const companyId = String(company._id);
    await seedLadder(companyId);
    await mongoose.model(Kpm.name).create({
      _id: KPM_A, companyId, code: '0417', branchName: 'Branch 0417', timezone: 'Asia/Jakarta',
      counters: { nextMemberSeq: 1 }, status: 'active',
    });
    const join = async (role: 'ab' | 'aab' | 'agent', leaderId: string | null, name: string) => {
      seq += 1;
      const user = await mongoose.model(User.name).create({
        email: `cal${seq}@kpm.test`, passwordHash: 'x', fullName: name, status: 'active',
        platformRole: 'none', companyId, agentCode: `PRU-${8000 + seq}`,
      });
      const placed = await hierarchy.create(new RequestContext('u-placer', 'none', {
        membershipId: 'mem-placer', kpmId: KPM_A, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
        isKpmOwner: true, isKpmAdmin: false, directCount: 0,
      } as never), { userId: String(user._id), role, leaderId, status: 'active' });
      return String(placed._id);
    };
    const root = await join('ab', null, 'Wilson Tanoto');
    const ab = await join('ab', root, 'Agus Salim');
    const aab = await join('aab', ab, 'Sari Puspita');
    m = {
      ROOT: root, AB: ab, AB2: await join('ab', root, 'Hendra Gunawan'), AAB: aab,
      AGENT: await join('agent', aab, 'Rina Wijaya'), AGENT2: await join('agent', aab, 'Budi Santoso'),
    };
  });

  const removeSari = () => removals.remove(as('AB'), m.AAB, {
    confirmation: REMOVAL_CONFIRMATION, reason: 'Left the company', subtree: { action: 'reassign', toMembershipId: m.AB },
  });

  it('P12-T4 AC-8 the future entries a leaver organised are deleted, softly, and each attendee who had not declined is told', async () => {
    const future = await wired.calendar.create(as('AAB'), entry('2026-10-05', { inviteeIds: [m.AGENT, m.AGENT2, m.AB] }));
    await wired.calendar.answer(as('AGENT2'), future.entryId, 'declined');
    // One already running — it has not ended, so it is future too.
    const running = await wired.calendar.create(as('AAB'), entry('2026-10-02', { start: '09:30', end: '11:00', inviteeIds: [m.AGENT] }));
    wired.sentNotifications.length = 0;

    await removeSari();

    for (const id of [future.entryId, running.entryId]) {
      expect(await stored(id)).toMatchObject({ deletedAt: NOW, updatedBy: m.AB });
    }
    const cancelled = wired.sentNotifications.filter((n) => n.templateId === NotificationTemplate.CALENDAR_ENTRY_CHANGED);
    // Rina for both; Budi declined; Agus removed her, and is not told of his own action.
    const byDate = (a: { payload: unknown }, b: { payload: unknown }) =>
      String((a.payload as { date: string }).date).localeCompare(String((b.payload as { date: string }).date));
    expect([...cancelled].sort(byDate as never).map((n) => [n.membershipId, n.payload])).toEqual([
      [m.AGENT, { entryId: running.entryId, date: '2026-10-02', change: 'cancelled' }],
      [m.AGENT, { entryId: future.entryId, date: '2026-10-05', change: 'cancelled' }],
    ]);
    expect(cancelled.every((n) => String(n.coalesceKey).endsWith(':cancelled'))).toBe(true);
    await wired.calendar.readOne(as('AGENT'), future.entryId).then(() => { throw new Error('read a deleted entry'); }, (err) => {
      expect(err.code ?? err.response?.code).toBe('NOT_FOUND');
    });
  });

  it('P12-T4 AC-8 past entries are untouched, theirs and those they were on, and keep their name', async () => {
    const theirs = await wired.calendar.create(as('AAB'), entry('2026-10-01', { inviteeIds: [m.AGENT] }));
    const onIt = await wired.calendar.create(as('AB'), entry('2026-09-30', { inviteeIds: [m.AAB] }));

    await removeSari();

    expect(await stored(theirs.entryId)).toMatchObject({ deletedAt: null, organiserMembershipId: m.AAB });
    expect((await stored(onIt.entryId))!.attendees.map((a: { membershipId: string }) => a.membershipId)).toEqual([m.AAB]);
    // Rina still reads Sari's past entry, Sari's name on it.
    const read = await wired.calendar.readOne(as('AGENT'), theirs.entryId);
    expect(read.organiser).toEqual({ membershipId: m.AAB, name: 'Sari Puspita' });
    expect((await wired.calendar.readOne(as('AB'), onIt.entryId)).invitees[0]).toMatchObject({ name: 'Sari Puspita' });
  });

  it('P12-T4 AC-8 a leaver is taken off every future entry’s attendee list, placed or invited; nobody else moves', async () => {
    const invited = await wired.calendar.create(as('ROOT'), entry('2026-10-06', { inviteeIds: [m.AAB, m.AB] }));
    const placed = await wired.calendar.block(as('AB'), { ...entry('2026-10-07'), membershipId: m.AAB, inviteeIds: [m.AGENT] });

    await removeSari();

    const invitedNow = (await stored(invited.entryId))!;
    expect(invitedNow.attendees.map((a: { membershipId: string }) => a.membershipId)).toEqual([m.AB]);
    expect(invitedNow).toMatchObject({ deletedAt: null, version: 1, updatedBy: m.AB });
    // The block stays the leader's, with its other invitee.
    expect((await stored(placed.entryId))!.attendees.map((a: { membershipId: string }) => a.membershipId)).toEqual([m.AGENT]);
    expect(await stored(placed.entryId)).toMatchObject({ deletedAt: null, organiserMembershipId: m.AB });
    expect(wired.sentNotifications.filter((n) => n.templateId === NotificationTemplate.CALENDAR_ENTRY_CHANGED)).toEqual([]);
  });

  it('M1 a past entry keeps a member who left: its organiser saves it with the list they read, and adding a leaver is still 404', async () => {
    const past = await wired.calendar.create(as('AB'), entry('2026-09-30', { inviteeIds: [m.AAB, m.AGENT] }));

    await removeSari();

    session.current = as('AB');
    const patch = (body: Record<string, unknown>) => request(app.getHttpServer()).patch(`/calendar/entries/${past.entryId}`).send(body);
    // The organiser edits the notes with the whole list as they read it, Sari on it: 200, Sari still by name.
    const saved = (await patch({ version: 1, notes: 'Minutes filed', inviteeIds: [m.AAB, m.AGENT] }).expect(200)).body;
    expect(saved).toMatchObject({ version: 2, notes: 'Minutes filed' });
    expect(saved.invitees.map((i: { membershipId: string; name: string }) => [i.membershipId, i.name])).toEqual([
      [m.AAB, 'Sari Puspita'], [m.AGENT, 'Rina Wijaya'],
    ]);
    // Dropping her is an edit like any other; adding her back is not: one who left is never invited.
    await patch({ version: 2, inviteeIds: [m.AGENT] }).expect(200);
    const refused = await patch({ version: 3, inviteeIds: [m.AGENT, m.AAB] }).expect(404);
    expect(refused.body.error).toMatchObject({ code: 'NOT_FOUND', details: { inviteeIds: [m.AAB] } });
    expect(await stored(past.entryId)).toMatchObject({ version: 3, notes: 'Minutes filed' });
    expect((await stored(past.entryId))!.attendees.map((a: { membershipId: string }) => a.membershipId)).toEqual([m.AGENT]);
  });

  /** `PATCH /calendar/entries/:entryId` as `who`, over HTTP. */
  const patchAs = (who: Name, entryId: string, body: Record<string, unknown>) => {
    session.current = as(who);
    return request(app.getHttpServer()).patch(`/calendar/entries/${entryId}`).send(body);
  };

  it('N1 a past entry moved into the future has everybody on it checked: a member who left is refused there, kept or not', async () => {
    const past = await wired.calendar.create(as('AB'), entry('2026-09-30', { inviteeIds: [m.AAB, m.AGENT] }));

    await removeSari();

    // Moved to Monday the 5th with the list as read, Sari on it: she would be on a future entry, which
    // leaving takes everybody off. The same with no list sent, which is the list as stored.
    for (const body of [{ inviteeIds: [m.AAB, m.AGENT] }, {}]) {
      const refused = await patchAs('AB', past.entryId, { version: 1, date: '2026-10-05', ...body }).expect(404);
      expect(refused.body.error).toMatchObject({ code: 'NOT_FOUND', details: { inviteeIds: [m.AAB] } });
    }
    // Moved to a later day that has also ended, she is kept, as M1 keeps her.
    await patchAs('AB', past.entryId, { version: 1, date: '2026-10-01', inviteeIds: [m.AAB, m.AGENT] }).expect(200);
    expect(await stored(past.entryId)).toMatchObject({ version: 2, startsAt: new Date('2026-10-01T02:00:00Z') });
    // Dropped as it moves into the future, it saves; Rina, still a member, is checked and kept.
    const moved = (await patchAs('AB', past.entryId, { version: 2, date: '2026-10-05', inviteeIds: [m.AGENT] }).expect(200)).body;
    expect(moved).toMatchObject({ version: 3, date: '2026-10-05' });
    expect(moved.invitees.map((i: { membershipId: string }) => i.membershipId)).toEqual([m.AGENT]);
  });

  it('N1 a past block moved into the future has the member it is placed on checked; within the past it keeps them', async () => {
    const placed = await wired.calendar.block(as('AB'), { ...entry('2026-09-30'), membershipId: m.AAB, inviteeIds: [m.AGENT] });

    await removeSari();

    const refused = await patchAs('AB', placed.entryId, { version: 1, date: '2026-10-05' }).expect(404);
    expect(refused.body.error).toMatchObject({ code: 'NOT_FOUND', details: { inviteeIds: [m.AAB] } });
    expect(await stored(placed.entryId)).toMatchObject({ version: 1, startsAt: new Date('2026-09-30T02:00:00Z') });
    // An edit that leaves it in the past saves, Sari still placed on it by name.
    const saved = (await patchAs('AB', placed.entryId, { version: 1, notes: 'Done' }).expect(200)).body;
    expect(saved.invitees.map((i: { membershipId: string; name: string; placed: boolean }) => [i.membershipId, i.name, i.placed])).toEqual([
      [m.AAB, 'Sari Puspita', true], [m.AGENT, 'Rina Wijaya', false],
    ]);
  });

  it('N3 another office’s entries under the leaver’s membership id — organised by it, inviting it, placed on it — stay untouched', async () => {
    // Office B files entries under ids that happen to be Sari's: invariant §1 says office A's removal never reaches them.
    const asB = new RequestContext('u-b', 'none', {
      membershipId: 'b-organiser', kpmId: KPM_B, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
      isKpmOwner: false, isKpmAdmin: false, directCount: 1,
    } as never);
    const inB = async (organiser: string, attendees: { membershipId: string; placed: boolean }[]) => String((await wired.calendarEntries.create(asB, {
      organiserMembershipId: organiser, type: 'meeting', title: 'Office B planning', notes: '',
      startsAt: new Date('2026-10-05T02:00:00Z'), endsAt: new Date('2026-10-05T03:00:00Z'), startsOn: null, endsOn: null,
      attendees: attendees.map((a) => ({ ...a, answer: a.placed ? null : 'pending', answeredAt: null, addedAt: NOW })),
      version: 1,
    } as never))._id);
    const organisedInB = await inB(m.AAB, [{ membershipId: m.AGENT, placed: false }]);
    const invitedInB = await inB('b-organiser', [{ membershipId: m.AAB, placed: false }, { membershipId: m.AGENT, placed: false }]);
    const placedInB = await inB('b-organiser', [{ membershipId: m.AAB, placed: true }]);
    const before = await col('calendarEvents').find({ kpmId: KPM_B }).sort({ _id: 1 }).toArray();

    await removeSari();

    expect(await col('calendarEvents').find({ kpmId: KPM_B }).sort({ _id: 1 }).toArray()).toEqual(before);
    expect(before.map((e) => [String(e._id), e.deletedAt, e.version, e.attendees.length])).toEqual([
      [organisedInB, null, 1, 1], [invitedInB, null, 1, 2], [placedInB, null, 1, 1],
    ]);
    // Nobody is told of a cancellation in office B.
    expect(wired.sentNotifications.filter((n) => n.templateId === NotificationTemplate.CALENDAR_ENTRY_CHANGED)).toEqual([]);
  });

  it('m8 an entry that fails to delete is logged; the leaver’s others are still cancelled, and they still leave every future entry', async () => {
    const failing = await wired.calendar.create(as('AAB'), entry('2026-10-05', { inviteeIds: [m.AGENT] }));
    const settled = await wired.calendar.create(as('AAB'), entry('2026-10-06', { inviteeIds: [m.AGENT2] }));
    const invited = await wired.calendar.create(as('ROOT'), entry('2026-10-07', { inviteeIds: [m.AAB, m.AB] }));
    wired.sentNotifications.length = 0;
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const softDelete = wired.calendarEntries.softDeleteById.bind(wired.calendarEntries);
    const failingDelete = jest.spyOn(wired.calendarEntries, 'softDeleteById').mockImplementation(async (ctx, id, at) => {
      if (id === failing.entryId) throw new Error('write conflict');
      return softDelete(ctx, id, at);
    });
    try {
      await removeSari();

      expect(await stored(failing.entryId)).toMatchObject({ deletedAt: null });
      expect(await stored(settled.entryId)).toMatchObject({ deletedAt: NOW, updatedBy: m.AB });
      // Budi is told of the cancellation that happened; Rina of none that did not.
      expect(wired.sentNotifications
        .filter((n) => n.templateId === NotificationTemplate.CALENDAR_ENTRY_CHANGED)
        .map((n) => [n.membershipId, (n.payload as { entryId: string }).entryId])).toEqual([[m.AGENT2, settled.entryId]]);
      // The pull ran all the same.
      expect((await stored(invited.entryId))!.attendees.map((a: { membershipId: string }) => a.membershipId)).toEqual([m.AB]);
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ entryId: failing.entryId, organiserMembershipId: m.AAB }),
        'failed to cancel a departing member’s future calendar entry',
      );
      expect(await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(m.AAB) })).toMatchObject({ status: 'removed' });
    } finally {
      failingDelete.mockRestore();
      logged.mockRestore();
    }
  });

  it('m8 a lookup of the leaver’s entries that fails still takes them off every future entry, and never fails the removal', async () => {
    const theirs = await wired.calendar.create(as('AAB'), entry('2026-10-05', { inviteeIds: [m.AGENT] }));
    const invited = await wired.calendar.create(as('ROOT'), entry('2026-10-07', { inviteeIds: [m.AAB, m.AB] }));
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const failingFind = jest.spyOn(wired.calendarEntries, 'find').mockRejectedValueOnce(new Error('calendar down'));
    try {
      await removeSari();

      expect((await stored(invited.entryId))!.attendees.map((a: { membershipId: string }) => a.membershipId)).toEqual([m.AB]);
      expect(await stored(theirs.entryId)).toMatchObject({ deletedAt: null });
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({ membershipId: m.AAB }), 'failed to settle a departing member’s records');
    } finally {
      failingFind.mockRestore();
      logged.mockRestore();
    }
  });

  it('P12-T4 AC-8 a departure that fails is logged and never fails the removal', async () => {
    class Broken extends MemberDeparture {
      async left(): Promise<void> { throw new Error('calendar down'); }
    }
    const clock = new FixedClock(NOW);
    const breaking = new RemovalService(
      members, hierarchy, roles, history, audit, { send: async () => undefined } as never, clock, new Broken(),
    );
    const team = await breaking.remove(as('AB'), m.AAB, {
      confirmation: REMOVAL_CONFIRMATION, subtree: { action: 'reassign', toMembershipId: m.AB },
    });
    expect(Array.isArray(team)).toBe(true);
    expect(await col('memberships').findOne({ _id: new mongoose.Types.ObjectId(m.AAB) })).toMatchObject({ status: 'removed' });
  });

  it('P12-T5 AC-5 a closed leader edge ends compare and Block time at once; a block already placed stays the leader’s', async () => {
    const placed = await wired.calendar.block(as('AB'), { ...entry('2026-10-05'), membershipId: m.AAB });
    await expect(wired.calendar.read(as('AB'), { for: m.AAB })).resolves.toMatchObject({ subject: { membershipId: m.AAB } });

    // Sari moves from Agus to Hendra.
    await hierarchy.reparent(as('ROOT'), m.AAB, m.AB2, 'Moved to the other unit');

    await expect(wired.calendar.read(as('AB'), { for: m.AAB })).rejects.toMatchObject({ status: 404 });
    await expect(wired.calendar.read(as('AB'), { for: m.AGENT })).rejects.toMatchObject({ status: 404 });
    await expect(wired.calendar.block(as('AB'), { ...entry('2026-10-06'), membershipId: m.AAB })).rejects.toMatchObject({ status: 404 });
    expect((await wired.calendarPeople.downline(as('AB'))).people).toEqual([]);
    // Hendra reaches her now.
    await expect(wired.calendar.read(as('AB2'), { for: m.AAB })).resolves.toMatchObject({ subject: { name: 'Sari Puspita' } });

    // The block placed before is Agus's still: he edits it, and she reads it as placed.
    const edited = await wired.calendar.update(as('AB'), placed.entryId, { version: 1, end: '10:30' });
    expect(edited).toMatchObject({ readerIs: 'organiser', end: '10:30' });
    expect(await wired.calendar.readOne(as('AAB'), placed.entryId)).toMatchObject({ readerIs: 'placed' });
  });

  it('P12-T6 AC-4 a closed edge takes the 1:1 chip’s link away', async () => {
    const oneToOne = await wired.calendar.create(as('AB'), entry('2026-10-05', { type: 'coaching', inviteeIds: [m.AAB] }));
    expect(oneToOne.invitees[0]).toMatchObject({ membershipId: m.AAB, readerCoaches: true });
    await hierarchy.reparent(as('ROOT'), m.AAB, m.AB2, 'Moved to the other unit');
    expect((await wired.calendar.readOne(as('AB'), oneToOne.entryId)).invitees[0]).toMatchObject({ readerCoaches: false });
  });
});
