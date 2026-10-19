import { startCalendar, stopCalendar, timed, WEEK, type CalendarHarness } from '../../../test/calendar-office';

/**
 * **The Owner's and the Admin's own calendar, served by today's grants** (P13.2-T5 AC-5, ADR-0114).
 *
 * The view switch adds a link and no permission: an Owner or an Admin who opens their field view reads
 * every field screen by the grants of the rung they stand on (roles §1.1). This pins the read `/calendar`
 * opens on — the reader's own week — for both, over HTTP behind the real `PermissionsGuard`. The other
 * two screens the switch reaches are pinned where they live: the Owner's coaching roster in
 * `coaching.controller.int.spec.ts` (*P11-T6 AC-2 the Owner … is answered the whole office*) and the
 * Owner's new-hires roster in `new-hires.int.spec.ts` (*P13-T5 AC-2 … the Owner’s roster has an AB card
 * for Agus*). An Owner or Admin on no rung is refused every calendar route (`calendar.int.spec.ts`,
 * *calendar_office_roles_have_no_calendar*); nothing here changes that.
 *
 * The office is `test/coaching-office.ts`'s: the Owner, Wilson, an AB at the root leading three; the
 * Admin, Maya, an AB leading nobody.
 */
describe('the Owner’s and the Admin’s field view: their own calendar (P13.2-T5 AC-5)', () => {
  let h: CalendarHarness;

  beforeAll(async () => { h = await startCalendar(); }, 120_000);
  afterAll(() => stopCalendar(h));
  beforeEach(() => h.reset());

  it.each(['OWNER', 'ADMIN'] as const)('P13.2-T5 AC-5 %s reads their own week, as the AB they stand as', async (who) => {
    h.as(who);
    const res = await h.http().get('/calendar/entries').expect(200);
    expect(res.body).toMatchObject({
      view: 'week', from: WEEK.monday, to: WEEK.sunday,
      subject: { membershipId: h.id(who), rung: { code: 'AB' } },
      entries: [],
    });
    // The other reads the screen makes on opening.
    await h.http().get('/calendar/settings').expect(200);
    await h.http().get('/calendar/people').expect(200);
  });

  it('P13.2-T5 AC-5 the Owner reads an entry of their own in it, and the downline the compare offers', async () => {
    h.as('OWNER');
    const created = (await h.http().post('/calendar/entries').send(timed(1, '09:00', '10:00', { title: 'Branch review' })).expect(201)).body;
    const week = (await h.http().get('/calendar/entries').expect(200)).body;
    expect(week.entries.map((e: { entryId: string }) => e.entryId)).toEqual([created.entryId]);
    // Wilson stands at the root, so the people below him are his to compare: Agus's unit and Hendra's.
    const { people } = (await h.http().get('/calendar/downline').expect(200)).body;
    expect(people.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining([
      'Agus Salim', 'Indah Permatasari', 'Sari Puspita', 'Hendra Gunawan',
    ]));
    // Office B's people are never on it.
    expect(people.map((p: { name: string }) => p.name)).not.toEqual(expect.arrayContaining(['Bayu Saputra']));
  });

  it('P13.2-T5 AC-5 a read-only support session impersonating the Owner reads the same week', async () => {
    h.as(h.supporting('OWNER'));
    const res = await h.http().get('/calendar/entries').expect(200);
    expect(res.body.subject.membershipId).toBe(h.id('OWNER'));
  });
});
