import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import {
  startActivationHarness, stopActivationHarness, KPM_B, type ActivationHarness, type Who,
} from '../../../test/activation-office';

type Item = {
  code: string; done: boolean; source: string | null; waiting: boolean; doneBy: { membershipId: string } | null;
  record: { collection: string; id: string } | null; note: string | null; date: string | null;
  link: { kind: string; label: string; live: boolean; form: string | null; route: string | null } | null;
};
type View = { pct: number; done: number; aspects: { items: Item[] }[] };
const item = (view: View, code: string) => view.aspects.flatMap((a) => a.items).find((i) => i.code === code)!;

/**
 * **P18.8-T4 — the first sale and the data-backed checklist items, over HTTP** (ADR-0171 §1, §3). The activation's
 * routes, the leads' and — through the services — the production file's corrections and the coaching sessions, with
 * the permission guard in front of the real services. The clock is Monday 14 September 2026, 10:00 in Jakarta.
 */
describe('P18.8-T4 — the first sale and the data-backed checklist items (ADR-0171)', () => {
  let h: ActivationHarness;
  const id = (who: Who) => h.id(who);
  const kpmOf = (who: Who) => h.office.as(who).kpmId!;
  const member = async (who: Who) => h.col('memberships').findOne({ _id: new mongoose.Types.ObjectId(id(who)) });
  const firstSale = async (who: Who) => {
    const row = await member(who);
    return {
      date: row?.firstSaleDate ?? null, source: row?.firstSaleSource ?? null,
      collection: row?.firstSaleRecordCollection ?? null, id: row?.firstSaleRecordId ?? null,
    };
  };
  const stored = async (who: Who, code: string) => {
    const doc = await h.col('activationProgress').findOne({ membershipId: id(who) });
    return (doc!.items as Record<string, unknown>[]).find((i) => i.code === code)!;
  };
  /** A sales lead of `who`'s, walked to `path`'s last stage through the leads routes, each move at `at`. */
  const walked = async (who: Who, name: string, path: string[], at?: string, type = 'sales') => {
    h.as(who);
    const created = (await h.http().post('/leads').send({ name, type }).expect(201)).body;
    for (const code of path) {
      if (at) h.clock.set(new Date(at));
      await h.http().patch(`/leads/${created.id}/status`).send({ statusCode: code }).expect(200);
    }
    h.clock.set(new Date('2026-09-14T03:00:00Z'));
    return created.id as string;
  };
  const SALE = ['NOT_YET_APPROACHED', 'POLICY_SUBMITTED', 'PAID_AND_ISSUED'];
  /** A 1:1 with `coachee`, finalized on `date`, by `coach` — as the coaching workspace writes one. */
  const oneOnOne = (coach: Who, coachee: Who, date: string) => h.wired.coachingSessions.create(h.office.as(coach), {
    coachMembershipId: id(coach), coacheeMembershipId: id(coachee), status: 'finalized', date,
    frozenAt: new Date(`${date}T04:00:00Z`), finalizedAt: new Date(`${date}T04:00:00Z`), finalizedByMembershipId: id(coach),
    version: 2, tips: [{ tipId: `${date}-${coachee}`, text: 'Keep going', carriedFromTipId: null }],
  } as never);
  /** The production file's policies for `who` in `month`, as a correction by the Owner writes them. */
  const policies = async (who: Who, month: string, value: number) => {
    const owner = h.office.as('OWNER');
    // A month past its window is reopened first, as the Owner would before correcting it.
    const state = await h.wired.productionMonths.reopen(owner, month);
    return h.wired.productionCorrections.correct(owner, {
      month, membershipId: id(who), kode: 'POLICY_COUNT', ytd: false, value, revision: state.revision,
      reason: 'The carrier confirmed the policy',
    });
  };
  const mine = async (who: Who): Promise<View> => { h.as(who); return (await h.http().get('/activation/me').expect(200)).body; };
  const detail = async (leader: Who, who: Who): Promise<View> => {
    h.as(leader);
    return (await h.http().get(`/new-hires/${id(who)}`).expect(200)).body;
  };

  beforeAll(async () => { h = await startActivationHarness(); });
  afterAll(async () => { await stopActivationHarness(h); });
  beforeEach(async () => { await h.reset(); });

  // ------------------------------------------------------------------ AC-1

  describe('AC-1 the first sale is kept on the membership — the earliest, never later', () => {
    it('P18.8-T4 AC-1 a sales lead reaching Paid and issued is the first sale, from the lead, on its office day', async () => {
      await h.start('BUDI', '2026-07-15');
      const lead = await walked('BUDI', 'Ibu Ratna', SALE, '2026-08-20T03:00:00Z');
      expect(await firstSale('BUDI')).toEqual({ date: '2026-08-20', source: 'lead', collection: 'leads', id: lead });
    });

    it('P18.8-T4 AC-1 counts the office’s day, not the server’s: a move at 23:30 UTC is the next day in Jakarta', async () => {
      await h.start('BUDI', '2026-07-15');
      await walked('BUDI', 'Ibu Ratna', SALE, '2026-08-20T23:30:00Z');
      expect((await firstSale('BUDI')).date).toBe('2026-08-21');
    });

    it('P18.8-T4 AC-1 a recruitment lead never counts, and nor does a sales lead short of Paid and issued', async () => {
      await h.start('BUDI', '2026-07-15');
      await walked('BUDI', 'Sdri. Maya', ['NOT_APPROACHED', 'MEETING_SCHEDULED'], '2026-08-20T03:00:00Z', 'recruitment');
      await walked('BUDI', 'Pak Hendro', ['NOT_YET_APPROACHED', 'POLICY_SUBMITTED', 'APPROVED_NOT_PAID'], '2026-08-21T03:00:00Z');
      expect(await firstSale('BUDI')).toEqual({ date: null, source: null, collection: null, id: null });
    });

    it('P18.8-T4 AC-1 an earlier sale moves it earlier, a later one never moves it, and deleting the lead does not clear it', async () => {
      await h.start('BUDI', '2026-07-15');
      const later = await walked('BUDI', 'Ibu Ratna', SALE, '2026-08-25T03:00:00Z');
      expect((await firstSale('BUDI')).date).toBe('2026-08-25');
      const earlier = await walked('BUDI', 'Pak Yusuf', SALE, '2026-08-10T03:00:00Z');
      expect(await firstSale('BUDI')).toEqual({ date: '2026-08-10', source: 'lead', collection: 'leads', id: earlier });
      await walked('BUDI', 'Ibu Lestari', SALE, '2026-09-01T03:00:00Z');
      expect((await firstSale('BUDI')).date).toBe('2026-08-10');
      // Gone from the leads, and the day stays where it was (ADR-0171 §1: never later).
      h.as('BUDI');
      await h.http().delete(`/leads/${earlier}`).expect(200);
      await h.http().patch(`/leads/${later}/status`).send({ statusCode: 'FOLLOW_UP' }).expect(200);
      await h.wired.firstSale.refresh(h.office.as('BUDI'), [id('BUDI')]);
      expect((await firstSale('BUDI')).date).toBe('2026-08-10');
    });

    it('P18.8-T4 AC-1 a closing logged by a checklist tick is a first sale marked manual, on the day it names', async () => {
      await h.start('BUDI', '2026-07-15');
      h.as('SARI');
      await h.http().put(`/new-hires/${id('BUDI')}/items/FIRST_CASE_CLOSED`)
        .send({ done: true, record: { kind: 'closing', name: 'Ibu Ratna', date: '2026-09-03' } }).expect(200);
      const logged = await h.col('leads').findOne({ ownerMembershipId: id('BUDI'), name: 'Ibu Ratna' });
      expect(logged).toMatchObject({
        type: 'sales', statusCode: 'PAID_AND_ISSUED', outcome: 'won', loggedFrom: 'activation_checklist', createdBy: id('SARI'),
      });
      expect(await firstSale('BUDI')).toEqual({ date: '2026-09-03', source: 'manual', collection: 'leads', id: String(logged!._id) });
    });

    it('P18.8-T4 AC-1 failing both, the production file’s first month with a policy, from the monthly file — never before the join date', async () => {
      await h.start('BUDI', '2026-07-15');
      await policies('BUDI', '2026-08', 1);
      expect(await firstSale('BUDI')).toMatchObject({ date: '2026-08-01', source: 'monthly_file', collection: 'monthlyAgentData' });

      // A hire who joined in the month the file shows reads the join date itself.
      await h.start('DODI', '2026-09-03');
      await policies('DODI', '2026-09', 2);
      expect(await firstSale('DODI')).toMatchObject({ date: '2026-09-03', source: 'monthly_file' });
    });

    it('P18.8-T4 AC-1 the file is the fallback: a lead after it does not move it later, an earlier lead does', async () => {
      await h.start('BUDI', '2026-07-15');
      await policies('BUDI', '2026-09', 1);
      expect((await firstSale('BUDI')).date).toBe('2026-09-01');
      await walked('BUDI', 'Ibu Ratna', SALE, '2026-09-05T03:00:00Z');
      expect(await firstSale('BUDI')).toMatchObject({ date: '2026-09-01', source: 'monthly_file' });
      await walked('BUDI', 'Pak Yusuf', SALE, '2026-08-28T03:00:00Z');
      expect(await firstSale('BUDI')).toMatchObject({ date: '2026-08-28', source: 'lead' });
    });

    it('P18.8-T4 AC-1 evidence before the join date is not this hire’s first sale', async () => {
      await h.start('BUDI', '2026-08-15');
      await walked('BUDI', 'Ibu Ratna', SALE, '2026-08-01T03:00:00Z');
      await policies('BUDI', '2026-07', 1);
      expect((await firstSale('BUDI')).date).toBeNull();
    });

    it('P18.8-T4 AC-1 is tenant-safe: another office’s sale never names this office’s member', async () => {
      await h.start('BUDI', '2026-07-15');
      await h.col('leads').insertOne({
        kpmId: KPM_B, ownerMembershipId: id('BUDI'), name: 'Elsewhere', type: 'sales', statusCode: 'PAID_AND_ISSUED',
        transitions: [{ fromStatusCode: null, toStatusCode: 'PAID_AND_ISSUED', at: new Date('2026-08-02T03:00:00Z'), byMembershipId: id('BUDI') }],
        loggedFrom: null, deletedAt: null, version: 1,
      });
      await h.wired.firstSale.refresh(h.office.as('BUDI'), [id('BUDI')]);
      expect((await firstSale('BUDI')).date).toBeNull();
    });
  });

  // ------------------------------------------------------------------ AC-2

  describe('AC-2 the three items tick themselves from the data, bound by code', () => {
    it('P18.8-T4 AC-2 Close first case independently ticks from a sales lead’s Paid and issued, in the write, naming the lead', async () => {
      await h.start('BUDI', '2026-07-15');
      const lead = await walked('BUDI', 'Ibu Ratna', SALE, '2026-08-20T03:00:00Z');
      expect(await stored('BUDI', 'FIRST_CASE_CLOSED')).toMatchObject({
        done: true, source: 'link', doneByMembershipId: id('BUDI'), recordCollection: 'leads', recordId: lead,
      });
      const row = item(await mine('BUDI'), 'FIRST_CASE_CLOSED');
      expect(row).toMatchObject({
        done: true, source: 'link', waiting: false, record: { collection: 'leads', id: lead },
        link: { kind: 'sales:first', label: 'Sales data', live: true, form: 'closing', route: null },
      });
      expect((await mine('BUDI'))).toMatchObject({ firstCaseClosed: true });
    });

    it('P18.8-T4 AC-2 …and from the production file, when the leads hold none', async () => {
      await h.start('BUDI', '2026-07-15');
      await policies('BUDI', '2026-08', 1);
      expect(await stored('BUDI', 'FIRST_CASE_CLOSED')).toMatchObject({
        done: true, source: 'link', doneByMembershipId: null, recordCollection: 'monthlyAgentData',
      });
    });

    it('P18.8-T4 AC-2 Reach Independent Agent milestone waits for the third closing since joining, and ticks on it', async () => {
      await h.start('BUDI', '2026-07-15');
      // One before the join date, which is not this activation's.
      await walked('BUDI', 'Before', SALE, '2026-07-10T03:00:00Z');
      await walked('BUDI', 'One', SALE, '2026-08-01T03:00:00Z');
      await walked('BUDI', 'Two', SALE, '2026-08-10T03:00:00Z');
      expect(item(await mine('BUDI'), 'INDEPENDENT_AGENT_MILESTONE')).toMatchObject({ done: false });
      const third = await walked('BUDI', 'Three', SALE, '2026-09-01T03:00:00Z');
      expect(await stored('BUDI', 'INDEPENDENT_AGENT_MILESTONE')).toMatchObject({
        done: true, source: 'link', recordCollection: 'leads', recordId: third,
      });
    });

    it('P18.8-T4 AC-2 …from the leads alone: policies in the production file never make it', async () => {
      await h.start('BUDI', '2026-07-15');
      await walked('BUDI', 'One', SALE, '2026-08-01T03:00:00Z');
      await walked('BUDI', 'Two', SALE, '2026-08-10T03:00:00Z');
      await policies('BUDI', '2026-08', 4);
      expect(item(await mine('BUDI'), 'INDEPENDENT_AGENT_MILESTONE').done).toBe(false);
    });

    it('P18.8-T4 AC-2 Weekly 1-on-1 check-in waits for the fourth 1:1 since joining; one before the join date is not counted', async () => {
      await h.start('DODI', '2026-08-01');
      await oneOnOne('NINA', 'DODI', '2026-07-28');
      for (const date of ['2026-08-03', '2026-08-10', '2026-08-17']) await oneOnOne('NINA', 'DODI', date);
      expect(item(await mine('DODI'), 'WEEKLY_CHECK_IN')).toMatchObject({ done: false, waiting: false });
      const fourth = await oneOnOne('SARI', 'DODI', '2026-08-24');
      const row = item(await mine('DODI'), 'WEEKLY_CHECK_IN');
      expect(row).toMatchObject({
        done: true, source: 'link', doneBy: { membershipId: id('SARI') }, record: { collection: 'coachingSessions', id: String(fourth._id) },
        link: { kind: 'coaching:weekly:4', label: 'Coaching sessions', form: 'one_on_one' },
      });
    });

    it('P18.8-T4 AC-2 a draft is no 1:1: three finalized and a draft leave it waiting', async () => {
      await h.start('DODI', '2026-08-01');
      for (const date of ['2026-08-03', '2026-08-10', '2026-08-17']) await oneOnOne('NINA', 'DODI', date);
      await h.wired.coachingSessions.create(h.office.as('NINA'), {
        coachMembershipId: id('NINA'), coacheeMembershipId: id('DODI'), status: 'draft', version: 1,
      } as never);
      expect(item(await mine('DODI'), 'WEEKLY_CHECK_IN').done).toBe(false);
    });

    it('P18.8-T4 AC-2 binds by code, so an office that renamed the item’s label keeps the link, and its own item keeps its own', async () => {
      const doc = await h.start('BUDI', '2026-07-15');
      await h.col('activationTemplates').updateOne(
        { kpmId: kpmOf('BUDI'), version: doc.templateVersion, 'aspects.items.code': 'FIRST_CASE_CLOSED' },
        { $set: { 'aspects.$[].items.$[it].label': 'First case, on your own' } },
        { arrayFilters: [{ 'it.code': 'FIRST_CASE_CLOSED' }] },
      );
      const row = item(await mine('BUDI'), 'FIRST_CASE_CLOSED');
      expect(row).toMatchObject({ label: 'First case, on your own', link: { kind: 'sales:first' } });
      // The published row still stores no link: a read gives it, a write never did.
      const template = await h.col('activationTemplates').findOne({ kpmId: kpmOf('BUDI'), version: doc.templateVersion });
      const storedItem = (template!.aspects as { items: { code: string; autoLink: string | null }[] }[])
        .flatMap((a) => a.items).find((i) => i.code === 'FIRST_CASE_CLOSED')!;
      expect(storedItem.autoLink).toBeNull();
    });
  });

  // ------------------------------------------------------------------ AC-3

  describe('AC-3 a hand tick opens its form, and the tick and the record are saved together', () => {
    it('P18.8-T4 AC-3 refuses a bare tick of a data-backed item, 422 naming the form, and writes nothing', async () => {
      await h.start('BUDI', '2026-07-15');
      h.as('BUDI');
      for (const [code, form] of [['FIRST_CASE_CLOSED', 'closing'], ['INDEPENDENT_AGENT_MILESTONE', 'closing'], ['WEEKLY_CHECK_IN', 'one_on_one']]) {
        const res = await h.http().put(`/activation/me/items/${code}`).send({ done: true }).expect(422);
        expect(res.body.error).toMatchObject({ code: 'ACTIVATION_RECORD_REQUIRED', details: { code, form } });
      }
      h.as('SARI');
      expect((await h.http().put(`/new-hires/${id('BUDI')}/items/FIRST_CASE_CLOSED`).send({ done: true }).expect(422)).body.error.code)
        .toBe('ACTIVATION_RECORD_REQUIRED');
      expect(await stored('BUDI', 'FIRST_CASE_CLOSED')).toMatchObject({ done: false });
      expect(await h.col('auditLog').countDocuments({ action: 'activation.item_ticked' })).toBe(0);
    });

    it('P18.8-T4 AC-3 refuses a record on an item that takes none, and one of the wrong kind', async () => {
      await h.start('BUDI', '2026-07-15');
      h.as('BUDI');
      await h.http().put('/activation/me/items/CRM_SETUP')
        .send({ done: true, record: { kind: 'closing', name: 'X', date: '2026-09-01' } }).expect(400);
      await h.http().put('/activation/me/items/FIRST_CASE_CLOSED')
        .send({ done: true, record: { kind: 'one_on_one', date: '2026-09-01', note: 'x' } }).expect(400);
      expect(await h.col('leads').countDocuments({ ownerMembershipId: id('BUDI') })).toBe(0);
    });

    it('P18.8-T4 AC-3 a new closing logged by the hire: one lead in their pipeline, the tick naming it, both audited', async () => {
      await h.start('BUDI', '2026-07-15');
      h.as('BUDI');
      const view = (await h.http().put('/activation/me/items/FIRST_CASE_CLOSED')
        .send({ done: true, record: { kind: 'closing', name: 'Ibu Ratna', date: '2026-09-03' } }).expect(200)).body;
      const lead = await h.col('leads').findOne({ ownerMembershipId: id('BUDI'), loggedFrom: 'activation_checklist' });
      expect(item(view, 'FIRST_CASE_CLOSED')).toMatchObject({
        done: true, source: 'hire', waiting: true, record: { collection: 'leads', id: String(lead!._id) },
      });
      const audits = await h.col('auditLog').find({ action: { $in: ['lead.created', 'activation.item_ticked'] } }).toArray();
      expect(audits.map((a) => a.action).sort()).toEqual(['activation.item_ticked', 'lead.created']);
      expect(audits.find((a) => a.action === 'activation.item_ticked')!.after).toEqual({
        code: 'FIRST_CASE_CLOSED', record: { collection: 'leads', id: String(lead!._id) },
      });
      expect(audits.find((a) => a.action === 'lead.created')!.after).toMatchObject({ loggedFrom: 'activation_checklist', outcome: 'won' });
    });

    it('P18.8-T4 AC-3 the record fails, and the tick does not stick: a day before the join date, a missing name, nothing written', async () => {
      await h.start('BUDI', '2026-07-15');
      h.as('SARI');
      for (const record of [
        { kind: 'closing', name: 'Ibu Ratna', date: '2026-07-01' },
        { kind: 'closing', name: '  ', date: '2026-09-01' },
        { kind: 'closing', name: 'Ibu Ratna', date: '2026-09-15' },
      ]) {
        await h.http().put(`/new-hires/${id('BUDI')}/items/FIRST_CASE_CLOSED`).send({ done: true, record }).expect(400);
      }
      expect(await h.col('leads').countDocuments({ ownerMembershipId: id('BUDI') })).toBe(0);
      expect(await stored('BUDI', 'FIRST_CASE_CLOSED')).toMatchObject({ done: false, source: null });
    });

    it('P18.10-T5 AC-7 refuses a record in Indonesian: every field’s sentence, the join date and today in the reader’s figures', async () => {
      const doc = await h.start('BUDI', '2026-08-01');
      /** An item's label as the office stored it — typed by the office, so interpolated as typed in either language. */
      const labelOf = async (code: string) => {
        const template = await h.col('activationTemplates').findOne({ kpmId: kpmOf('BUDI'), version: doc.templateVersion });
        return (template!.aspects as { items: { code: string; label: string }[] }[])
          .flatMap((a) => a.items).find((i) => i.code === code)!.label;
      };
      h.as('SARI');
      const record = { kind: 'closing', name: '  ', date: '2026-07-20' };
      const english = (await h.http().put(`/new-hires/${id('BUDI')}/items/FIRST_CASE_CLOSED`)
        .send({ done: true, record }).expect(400)).body.error;
      expect(english).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { violations: [
          'record.name is who the case was sold to, and is required for a new closing.',
          // The English reader's figures (`test/setup.ts`), as the default is live.
          'record.date, the day it was paid and issued, is a day from the join date, 1 Aug 2026, to today, 14 Sep 2026.',
        ] },
      });
      const indonesian = (await h.http().put(`/new-hires/${id('BUDI')}/items/FIRST_CASE_CLOSED`).set('Accept-Language', 'id')
        .send({ done: true, record }).expect(400)).body.error;
      const said = [
        'record.name adalah nama orang yang membeli case ini, dan wajib diisi untuk closing baru.',
        'record.date, hari case ini dibayar dan diterbitkan, harus berupa hari dari tanggal bergabung, 1 Agu 2026, sampai '
          + 'hari ini, 14 Sep 2026.',
      ];
      expect(indonesian).toMatchObject({ code: 'VALIDATION_FAILED', message: said.join('; '), details: { violations: said } });
      // A day not written as one: the pipe's own sentence, under the record's path, in either language.
      const shape = (language: string) => h.http().put(`/new-hires/${id('BUDI')}/items/WEEKLY_CHECK_IN`)
        .set('Accept-Language', language).send({ done: true, record: { kind: 'one_on_one', date: '20 Agu', note: 'x' } });
      expect((await shape('en').expect(400)).body.error.details.violations).toEqual(['record.date must be a day, written YYYY-MM-DD.']);
      expect((await shape('id').expect(400)).body.error.details.violations)
        .toEqual(['record.date harus berupa tanggal dengan format YYYY-MM-DD.']);
      // A 1:1 on a day that is none, and with no note: the service's own two sentences.
      const oneOnOne = (await h.http().put(`/new-hires/${id('BUDI')}/items/WEEKLY_CHECK_IN`).set('Accept-Language', 'id')
        .send({ done: true, record: { kind: 'one_on_one', date: '2026-02-30', note: ' ' } }).expect(400)).body.error;
      expect(oneOnOne.details.violations).toEqual([
        'record.date, hari 1:1 diadakan, harus berupa tanggal dengan format YYYY-MM-DD.',
        'record.note harus 1 sampai 500 karakter, tanpa spasi di awal dan akhir.',
      ]);
      // A record on an item that takes none, and one of the wrong kind, naming the office's own label as typed.
      const wrong = (await h.http().put(`/new-hires/${id('BUDI')}/items/CRM_SETUP`).set('Accept-Language', 'id')
        .send({ done: true, record }).expect(400)).body.error;
      expect(wrong.message).toBe('record hanya untuk item yang selesai dari data penjualan dan coaching, bukan untuk '
        + `${await labelOf('CRM_SETUP')}.`);
      const kind = (await h.http().put(`/new-hires/${id('BUDI')}/items/FIRST_CASE_CLOSED`).set('Accept-Language', 'id')
        .send({ done: true, record: { kind: 'one_on_one', date: '2026-09-01', note: 'x' } }).expect(400)).body.error;
      expect(kind.message).toBe(`record.kind harus closing untuk ${await labelOf('FIRST_CASE_CLOSED')}.`);
      expect(await h.col('leads').countDocuments({ ownerMembershipId: id('BUDI') })).toBe(0);
    });

    it('P18.8-T4 AC-3 the tick does not stick when the leads module refuses the closing: an office with no Paid and issued stage', async () => {
      await h.start('BUDI', '2026-07-15');
      jest.spyOn(h.wired.leadRecords, 'logClosing').mockRejectedValueOnce(new Error('the closing could not be written'));
      h.as('BUDI');
      await h.http().put('/activation/me/items/FIRST_CASE_CLOSED')
        .send({ done: true, record: { kind: 'closing', name: 'Ibu Ratna', date: '2026-09-01' } }).expect(500);
      expect(await stored('BUDI', 'FIRST_CASE_CLOSED')).toMatchObject({ done: false });
      jest.restoreAllMocks();
    });

    it('P18.8-T4 AC-3 names an existing closing: the hire’s own, listed by GET …/closings; another member’s is 404', async () => {
      await h.start('BUDI', '2026-08-15');
      // Before the join date, so the link does not complete it: the tick names it by hand.
      const lead = await walked('BUDI', 'Ibu Ratna', SALE, '2026-08-01T03:00:00Z');
      const other = await walked('RINA', 'Pak Bayu', SALE, '2026-08-01T03:00:00Z');
      h.as('BUDI');
      expect((await h.http().get('/activation/me/closings').expect(200)).body).toEqual({
        closings: [{ leadId: lead, name: 'Ibu Ratna', date: '2026-08-01' }],
      });
      h.as('SARI');
      expect((await h.http().get(`/new-hires/${id('BUDI')}/closings`).expect(200)).body.closings).toEqual([
        { leadId: lead, name: 'Ibu Ratna', date: '2026-08-01' },
      ]);
      await h.http().put(`/new-hires/${id('BUDI')}/items/FIRST_CASE_CLOSED`)
        .send({ done: true, record: { kind: 'closing', leadId: other } }).expect(404);
      const view = (await h.http().put(`/new-hires/${id('BUDI')}/items/FIRST_CASE_CLOSED`)
        .send({ done: true, record: { kind: 'closing', leadId: lead } }).expect(200)).body;
      expect(item(view, 'FIRST_CASE_CLOSED')).toMatchObject({
        done: true, source: 'leader', doneBy: { membershipId: id('SARI') }, record: { collection: 'leads', id: lead },
      });
      // A leader's read of the hire's closings is a read of their leads (§3.5).
      expect(await h.col('auditLog').countDocuments({ action: 'activity_log.read_raw', targetMembershipId: id('BUDI'), 'after.surface': 'leads' }))
        .toBeGreaterThanOrEqual(1);
    });

    it('P18.8-T4 AC-3 a leader’s Log 1:1 is a coaching session with the hire, finalized on the day given, counted at once', async () => {
      await h.start('DODI', '2026-08-01');
      for (const date of ['2026-08-03', '2026-08-10', '2026-08-17']) await oneOnOne('NINA', 'DODI', date);
      h.as('NINA');
      const view = (await h.http().put(`/new-hires/${id('DODI')}/items/WEEKLY_CHECK_IN`)
        .send({ done: true, record: { kind: 'one_on_one', date: '2026-08-31', note: 'Went through his two presentations.' } })
        .expect(200)).body;
      const session = await h.col('coachingSessions').findOne({ coacheeMembershipId: id('DODI'), date: '2026-08-31' });
      expect(session).toMatchObject({
        coachMembershipId: id('NINA'), status: 'finalized', finalizedByMembershipId: id('NINA'), snapshot: null,
        tips: [expect.objectContaining({ text: 'Went through his two presentations.' })], actionItems: [],
      });
      // The fourth 1:1: the data completes it in the same answer, attributed to the session.
      expect(item(view, 'WEEKLY_CHECK_IN')).toMatchObject({
        done: true, source: 'link', waiting: false, record: { collection: 'coachingSessions', id: String(session!._id) },
      });
      expect(await h.col('auditLog').countDocuments({ action: 'coaching_session.logged', targetMembershipId: id('DODI') })).toBe(1);
    });

    it('P18.8-T4 AC-3 the hire’s own Log 1:1 is their date and note on the item — a coachee writes no session about themselves', async () => {
      await h.start('BUDI', '2026-07-15');
      h.as('BUDI');
      const view = (await h.http().put('/activation/me/items/WEEKLY_CHECK_IN')
        .send({ done: true, record: { kind: 'one_on_one', date: '2026-09-07', note: 'Checked in with Sari.' } }).expect(200)).body;
      expect(item(view, 'WEEKLY_CHECK_IN')).toMatchObject({
        done: true, source: 'hire', waiting: true, record: null, note: 'Checked in with Sari.', date: '2026-09-07',
      });
      expect(await h.col('coachingSessions').countDocuments({ coacheeMembershipId: id('BUDI'), date: '2026-09-07' })).toBe(0);
    });

    /*
     * Was *an Agent who leads cannot log a 1:1 (403) nor read the hire's closings (404)*: P19.9-T6 (ADR-0234) gave the
     * Agent rung the coach's grants over their downline, so Lukas does for Tari what Nina does for Dodi above.
     */
    it('P19.9-T6 AC-1 an Agent who leads logs a 1:1 for their hire, reads her closings and logs one — as any coach (ADR-0234)', async () => {
      await h.start('TARI', '2026-08-01');
      h.as('LUKAS');
      await h.http().put(`/new-hires/${id('TARI')}/items/WEEKLY_CHECK_IN`)
        .send({ done: true, record: { kind: 'one_on_one', date: '2026-09-01', note: 'Check-in.' } }).expect(200);
      expect(await h.col('coachingSessions').findOne({ coacheeMembershipId: id('TARI'), date: '2026-09-01' })).toMatchObject({
        coachMembershipId: id('LUKAS'), status: 'finalized', finalizedByMembershipId: id('LUKAS'),
      });
      await h.http().get(`/new-hires/${id('TARI')}/closings`).expect(200);
      await h.http().put(`/new-hires/${id('TARI')}/items/FIRST_CASE_CLOSED`)
        .send({ done: true, record: { kind: 'closing', name: 'Ibu Ratna', date: '2026-09-01' } }).expect(200);
      expect(await h.col('leads').countDocuments({ ownerMembershipId: id('TARI'), createdBy: id('LUKAS') })).toBe(1);
    });

    it('P19.9-T6 AC-1 an Agent who leads reaches no hire outside their downline: 404, and nothing is written', async () => {
      await h.start('DODI', '2026-08-01');
      h.as('LUKAS');
      await h.http().put(`/new-hires/${id('DODI')}/items/WEEKLY_CHECK_IN`)
        .send({ done: true, record: { kind: 'one_on_one', date: '2026-09-01', note: 'Check-in.' } }).expect(404);
      await h.http().get(`/new-hires/${id('DODI')}/closings`).expect(404);
      expect(await stored('DODI', 'WEEKLY_CHECK_IN')).toMatchObject({ done: false });
      expect(await h.col('coachingSessions').countDocuments({ coacheeMembershipId: id('DODI') })).toBe(0);
    });

    it('P18.8-T4 AC-3 unticks a hand tick freely, leaving its record where it is; an item its data completed is nobody’s to untick', async () => {
      await h.start('BUDI', '2026-07-15');
      h.as('BUDI');
      await h.http().put('/activation/me/items/INDEPENDENT_AGENT_MILESTONE')
        .send({ done: true, record: { kind: 'closing', name: 'Ibu Ratna', date: '2026-09-03' } }).expect(200);
      const view = (await h.http().put('/activation/me/items/INDEPENDENT_AGENT_MILESTONE').send({ done: false }).expect(200)).body;
      expect(item(view, 'INDEPENDENT_AGENT_MILESTONE')).toMatchObject({ done: false, source: null, record: null, waiting: false });
      expect(await h.col('leads').countDocuments({ ownerMembershipId: id('BUDI'), loggedFrom: 'activation_checklist' })).toBe(1);

      await walked('BUDI', 'Pak Yusuf', SALE, '2026-09-04T03:00:00Z');
      h.as('BUDI');
      expect((await h.http().put('/activation/me/items/FIRST_CASE_CLOSED').send({ done: false }).expect(409)).body.error.code)
        .toBe('ACTIVATION_ITEM_AUTOMATIC');
    });

    it('P18.8-T4 AC-3 any AB or AAB above the hire may record for them: Agus, two rungs up, logs a closing for Budi', async () => {
      await h.start('BUDI', '2026-07-15');
      h.as('AGUS');
      const view = (await h.http().put(`/new-hires/${id('BUDI')}/items/FIRST_CASE_CLOSED`)
        .send({ done: true, record: { kind: 'closing', name: 'Ibu Ratna', date: '2026-09-01' } }).expect(200)).body;
      expect(item(view, 'FIRST_CASE_CLOSED')).toMatchObject({ source: 'leader', doneBy: { membershipId: id('AGUS') }, waiting: true });
      expect(await h.col('leads').findOne({ ownerMembershipId: id('BUDI'), name: 'Ibu Ratna' })).toMatchObject({ createdBy: id('AGUS') });
    });

    it('P18.8-T4 AC-3 a read-only support session writes neither the tick nor the record', async () => {
      await h.start('BUDI', '2026-07-15');
      h.as(h.supporting('BUDI'));
      await h.http().put('/activation/me/items/FIRST_CASE_CLOSED')
        .send({ done: true, record: { kind: 'closing', name: 'Ibu Ratna', date: '2026-09-01' } }).expect(403);
      expect(await h.col('leads').countDocuments({ ownerMembershipId: id('BUDI') })).toBe(0);
    });

    it('P18.8-T4 AC-3 a leader outside the hire’s reach, and another office’s, are 404 on the tick and the closings; nothing written', async () => {
      await h.start('BUDI', '2026-07-15');
      for (const who of ['PEER_AB', 'B_AB', 'DEWI'] as const) {
        h.as(who);
        await h.http().get(`/new-hires/${id('BUDI')}/closings`).expect(404);
        await h.http().put(`/new-hires/${id('BUDI')}/items/FIRST_CASE_CLOSED`)
          .send({ done: true, record: { kind: 'closing', name: 'Ibu Ratna', date: '2026-09-01' } }).expect(404);
      }
      expect(await h.col('leads').countDocuments({ ownerMembershipId: id('BUDI') })).toBe(0);
      expect(await stored('BUDI', 'FIRST_CASE_CLOSED')).toMatchObject({ done: false });
    });
  });

  // ------------------------------------------------------------------ AC-4, AC-5

  describe('AC-4 waiting for data, then the data · AC-5 the leader and the hire read the same', () => {
    it('P18.8-T4 AC-4 a tick with a logged closing waits for data, and switches to the file’s month when it shows a policy', async () => {
      await h.start('BUDI', '2026-07-15');
      h.as('SARI');
      await h.http().put(`/new-hires/${id('BUDI')}/items/FIRST_CASE_CLOSED`)
        .send({ done: true, record: { kind: 'closing', name: 'Ibu Ratna', date: '2026-09-03' } }).expect(200);
      expect(item(await detail('SARI', 'BUDI'), 'FIRST_CASE_CLOSED')).toMatchObject({
        done: true, source: 'leader', waiting: true, doneBy: { membershipId: id('SARI') },
      });
      await policies('BUDI', '2026-09', 1);
      const switched = item(await detail('SARI', 'BUDI'), 'FIRST_CASE_CLOSED');
      expect(switched).toMatchObject({ done: true, source: 'link', waiting: false, record: { collection: 'monthlyAgentData' } });
      // The first sale is still the manual closing's day: the file counts only failing a closing (ADR-0171 §1).
      expect(await firstSale('BUDI')).toMatchObject({ date: '2026-09-03', source: 'manual' });
    });

    it('P18.8-T4 AC-4 …or to a closing of the leads flow', async () => {
      await h.start('BUDI', '2026-07-15');
      h.as('BUDI');
      await h.http().put('/activation/me/items/FIRST_CASE_CLOSED')
        .send({ done: true, record: { kind: 'closing', name: 'Ibu Ratna', date: '2026-09-03' } }).expect(200);
      const lead = await walked('BUDI', 'Pak Yusuf', SALE, '2026-09-08T03:00:00Z');
      expect(item(await mine('BUDI'), 'FIRST_CASE_CLOSED')).toMatchObject({
        source: 'link', waiting: false, record: { collection: 'leads', id: lead },
      });
    });

    it('P18.8-T4 AC-4 a leader’s 1:1 short of four waits, and the fourth switches it', async () => {
      await h.start('DODI', '2026-08-01');
      h.as('NINA');
      await h.http().put(`/new-hires/${id('DODI')}/items/WEEKLY_CHECK_IN`)
        .send({ done: true, record: { kind: 'one_on_one', date: '2026-08-03', note: 'First check-in.' } }).expect(200);
      expect(item(await mine('DODI'), 'WEEKLY_CHECK_IN')).toMatchObject({ source: 'leader', waiting: true, record: { collection: 'coachingSessions' } });
      for (const date of ['2026-08-10', '2026-08-17', '2026-08-24']) await oneOnOne('NINA', 'DODI', date);
      expect(item(await mine('DODI'), 'WEEKLY_CHECK_IN')).toMatchObject({ source: 'link', waiting: false });
    });

    it('P18.8-T4 AC-5 the leader’s detail and the hire’s page show the same state, item by item', async () => {
      await h.start('BUDI', '2026-07-15');
      h.as('SARI');
      await h.http().put(`/new-hires/${id('BUDI')}/items/INDEPENDENT_AGENT_MILESTONE`)
        .send({ done: true, record: { kind: 'closing', name: 'Ibu Ratna', date: '2026-09-03' } }).expect(200);
      await walked('BUDI', 'Pak Yusuf', SALE, '2026-08-20T03:00:00Z');
      const strip = (view: View) => view.aspects.flatMap((a) => a.items)
        .map(({ code, done, source, waiting, record, doneBy }) => ({ code, done, source, waiting, record, doneBy }));
      const own = await mine('BUDI');
      const leader = await detail('SARI', 'BUDI');
      expect(strip(leader)).toEqual(strip(own));
      expect([own.pct, own.done]).toEqual([leader.pct, leader.done]);
      expect(item(own, 'FIRST_CASE_CLOSED')).toMatchObject({ source: 'link' });
      expect(item(own, 'INDEPENDENT_AGENT_MILESTONE')).toMatchObject({ source: 'leader', waiting: true });
    });

    it('P18.8-T4 AC-4 a read-only support session writes nothing: the data met in memory, the row untouched', async () => {
      await h.start('BUDI', '2026-07-15');
      await h.col('leads').insertOne({
        kpmId: kpmOf('BUDI'), ownerMembershipId: id('BUDI'), name: 'Ibu Ratna', type: 'sales', statusCode: 'PAID_AND_ISSUED',
        transitions: [{ fromStatusCode: null, toStatusCode: 'PAID_AND_ISSUED', at: new Date('2026-08-20T03:00:00Z'), byMembershipId: id('BUDI') }],
        loggedFrom: null, deletedAt: null, version: 1, dateRegistered: new Date('2026-08-19T03:00:00Z'), createdBy: id('BUDI'),
      });
      h.as(h.supporting('BUDI'));
      expect(item((await h.http().get('/activation/me').expect(200)).body, 'FIRST_CASE_CLOSED')).toMatchObject({ done: true, source: 'link' });
      expect(await stored('BUDI', 'FIRST_CASE_CLOSED')).toMatchObject({ done: false });
    });
  });

  it('P18.8-T4 AC-2 the reads stay bounded: the roster asks the same queries for one hire as for three, closings and the file once', async () => {
    const queries = async () => {
      const seen: string[] = [];
      mongoose.set('debug', (collection: string, method: string) => { seen.push(`${collection}.${method}`); });
      try {
        h.as('SARI');
        await h.http().get('/new-hires').expect(200);
      } finally {
        mongoose.set('debug', false);
      }
      return seen.filter((q) => !q.startsWith('auditLog')).sort();
    };
    await h.start('BUDI', '2026-07-15');
    const one = await queries();
    await h.start('DODI', '2026-09-01');
    await h.start('NINA', '2026-08-15');
    expect(await queries()).toEqual(one);
    expect(one.filter((q) => q === 'leads.find')).toHaveLength(1);
    expect(one.filter((q) => q === 'monthlyAgentData.find')).toHaveLength(1);
    expect(one.filter((q) => q === 'coachingSessions.find')).toHaveLength(1);
  });

  it('P18.8-T4 AC-1 a job context of one office never reads another’s: the refresh is scoped', async () => {
    await h.start('BUDI', '2026-07-15');
    await walked('BUDI', 'Ibu Ratna', SALE, '2026-08-20T03:00:00Z');
    await h.col('memberships').updateOne({ _id: new mongoose.Types.ObjectId(id('BUDI')) }, { $unset: { firstSaleDate: '' } });
    // Office B's context names Budi's id and moves nothing: his row is office A's.
    expect(await h.wired.firstSale.refresh(RequestContext.forJob(KPM_B, 'spec'), [id('BUDI')])).toBe(0);
    expect((await firstSale('BUDI')).date).toBeNull();
  });
});
