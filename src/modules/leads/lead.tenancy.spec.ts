import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

const NOW = new Date('2026-09-25T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

const member = (kpmId: string, membershipId: string) => new RequestContext('u1', 'none', {
  membershipId, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never);

/** Somebody signed in who has joined no office yet. */
const noOffice = () => new RequestContext('u9', 'none', null);

/**
 * The lead record (P7-T1).
 *
 * **The first record in this product about somebody who is not a user of it.** Most of what is
 * asserted here is about that: the lawful basis, the soft delete, and an audit row that records
 * that contact details exist without recording them.
 */
describe('the lead record (P7-T1)', () => {
  let wired: ReturnType<typeof configModule>;
  const A = () => member(KPM_A, 'mem-a1');
  const B = () => member(KPM_B, 'mem-b1');

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);
  beforeEach(clearCollections);

  const create = (ctx: RequestContext, over: Record<string, unknown> = {}) =>
    wired.leadRecords.create(ctx, { name: 'Pak Budi', ...over });

  describe('AC-1 — what the document carries', () => {
    it('is owned by the membership that created it, never by a user id', async () => {
      // Invariant §2: a person who leaves and rejoins gets a new membership, and the leads they
      // worked stay with the office rather than following the person.
      const lead = await create(A());

      expect(lead.ownerMembershipId).toBe('mem-a1');
      const stored = await mongoose.connection.db!.collection('leads').findOne({});
      expect(stored).toMatchObject({ kpmId: KPM_A, ownerMembershipId: 'mem-a1', deletedAt: null });
      expect(stored!.createdBy).toBe('mem-a1');
    });

    it('leads every index with kpmId (invariant §1)', async () => {
      await create(A());
      await mongoose.model('Lead').syncIndexes();

      const indexes = await mongoose.connection.db!.collection('leads').indexes();
      const compound = indexes.filter((i) => Object.keys(i.key).length > 1);
      expect(compound.length).toBeGreaterThan(0);
      for (const index of compound) {
        expect(Object.keys(index.key)[0]).toBe('kpmId');
      }
    });

    it('refuses somebody who has joined no office, rather than writing a lead with no owner', async () => {
      await expect(create(noOffice())).rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
    });
  });

  describe('AC-2 — one office cannot reach another’s', () => {
    it('is 404, never 403, on read, update and delete', async () => {
      // A 403 would confirm the id exists, which is the thing a 404 refuses to say.
      const theirs = await create(B());

      await expect(wired.leadRecords.read(A(), theirs.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.leadRecords.update(A(), theirs.id, { name: 'Taken over' }))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(wired.leadRecords.remove(A(), theirs.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('does not list another office’s leads', async () => {
      await create(B(), { name: 'Theirs' });
      await create(A(), { name: 'Ours' });

      expect((await wired.leadRecords.list(A())).rows.map((l) => l.name)).toEqual(['Ours']);
    });

    it('leaves the other office’s row untouched by a refused write', async () => {
      const theirs = await create(B(), { name: 'Theirs' });
      await wired.leadRecords.update(A(), theirs.id, { name: 'Ours now' }).catch(() => undefined);

      expect((await wired.leadRecords.read(B(), theirs.id)).name).toBe('Theirs');
    });
  });

  describe('AC-3 — a ground before the details', () => {
    it('stores a lead with a name and nothing else', async () => {
      // An agent jotting down a name from a Thursday BOP has collected nothing the regulation
      // governs. A gate on creation would make the first thing they meet a compliance form.
      const lead = await create(A());

      expect(lead).toMatchObject({ name: 'Pak Budi', lawfulBasis: null, consentAt: null });
      expect(lead.contact).toEqual({ phone: null, email: null });
    });

    it.each([
      ['a phone number', { phone: '0812-3456-7890', email: null }],
      ['an email', { phone: null, email: 'budi@example.com' }],
    ])('refuses %s with no recorded ground', async (_what, contact) => {
      await expect(create(A(), { contact }))
        .rejects.toMatchObject({ code: 'LEAD_CONSENT_REQUIRED' });
    });

    it('takes them once a ground is recorded, and stamps when', async () => {
      const lead = await create(A(), {
        contact: { phone: '0812-3456-7890' }, lawfulBasis: 'consent',
      });

      expect(lead.contact.phone).toBe('0812-3456-7890');
      expect(lead.consentAt).toBe(NOW.toISOString());
    });

    it('refuses contact details added later to a lead that has no ground', async () => {
      const lead = await create(A());

      await expect(wired.leadRecords.update(A(), lead.id, { contact: { phone: '0812' } }))
        .rejects.toMatchObject({ code: 'LEAD_CONSENT_REQUIRED' });
    });

    it('refuses clearing the ground from a lead that still holds details', async () => {
      /*
       * Checked against the lead as it **will be**, not as the patch arrived. A rule that only
       * read the incoming fields would let the same thing happen in two steps: record a basis,
       * add the number, remove the basis.
       */
      const lead = await create(A(), { contact: { phone: '0812' }, lawfulBasis: 'consent' });

      await expect(wired.leadRecords.update(A(), lead.id, { lawfulBasis: null }))
        .rejects.toMatchObject({ code: 'LEAD_CONSENT_REQUIRED' });
    });

    it('allows the ground to be cleared once the details are gone', async () => {
      const lead = await create(A(), { contact: { phone: '0812' }, lawfulBasis: 'consent' });

      const cleared = await wired.leadRecords.update(A(), lead.id, {
        contact: null, lawfulBasis: null,
      });

      expect(cleared.contact).toEqual({ phone: null, email: null });
      expect(cleared.consentAt).toBeNull();
    });

    it('refuses a ground the regulation does not name', async () => {
      await expect(create(A(), { lawfulBasis: 'because I asked nicely' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('AC-4 — a lead starts on no rung', () => {
    it('writes no status, because the first one is a move', async () => {
      // `{ fromStatusCode: null, toStatusCode, … }` is a transition, and every transition belongs
      // to P7-T3 (ADR-0045). The line between the two tasks is exactly here.
      const lead = await create(A(), { type: 'sales' });

      expect(lead.statusCode).toBeNull();
      const stored = await mongoose.connection.db!.collection('leads').findOne({});
      expect(stored!.statusId).toBeNull();
      expect(stored!.transitions).toEqual([]);
    });

    it('takes a lead with no type at all, which is a real state', async () => {
      const lead = await create(A());
      expect(lead.type).toBeNull();
    });
  });

  describe('AC-5 — the version a later write will pin', () => {
    it('starts at 1 and moves on every write', async () => {
      const lead = await create(A());
      expect(lead.version).toBe(1);

      const once = await wired.leadRecords.update(A(), lead.id, { remarks: 'Hot button: golf' });
      const twice = await wired.leadRecords.update(A(), lead.id, { thisMonth: true });

      expect(once.version).toBe(2);
      expect(twice.version).toBe(3);
    });
  });

  describe('deleting is disabling', () => {
    it('sets deletedAt and removes nothing', async () => {
      const lead = await create(A());

      await wired.leadRecords.remove(A(), lead.id);

      expect(await mongoose.connection.db!.collection('leads').countDocuments()).toBe(1);
      expect((await mongoose.connection.db!.collection('leads').findOne({}))!.deletedAt)
        .not.toBeNull();
      expect((await wired.leadRecords.list(A())).rows).toEqual([]);
    });
  });

  describe('what the audit row may say', () => {
    it('records that contact details exist without recording them', async () => {
      /*
       * §3.7: the Owner and the Admin get counts, not rows. An audit row is read by an
       * administrator who has no right to the lead — putting the name or the phone number in it
       * would route around the thing that paragraph exists to protect.
       */
      await create(A(), { contact: { phone: '0812-3456-7890' }, lawfulBasis: 'consent' });

      const entry = await mongoose.connection.db!.collection('auditLog')
        .findOne({ action: 'lead.created' });
      const after = entry!.after as Record<string, unknown>;

      expect(after).toMatchObject({ hasContact: true, lawfulBasis: 'consent' });
      expect(JSON.stringify(entry)).not.toContain('Pak Budi');
      expect(JSON.stringify(entry)).not.toContain('0812');
    });
  });

  describe('P7-T3 — moving along the ladder', () => {
    beforeEach(() => provisionOffice(wired, KPM_A, COMPANY));

    const sales = () => create(A(), { type: 'sales' });

    it('AC-5: jumps from the first stage to the last in one write', async () => {
      /*
       * The test that distinguishes free jump from a forward-only rule. One that only proved the
       * refusals would pass under either, which is why ADR-0045 names this one specifically.
       */
      const lead = await sales();

      const moved = await wired.leadRecords.setStatus(A(), lead.id, 'PAID_AND_ISSUED');

      expect(moved.statusCode).toBe('PAID_AND_ISSUED');
      const stored = await mongoose.connection.db!.collection('leads').findOne({ _id: new mongoose.Types.ObjectId(lead.id) });
      expect(stored!.transitions).toHaveLength(1);
      expect(stored!.transitions[0]).toMatchObject({
        fromStatusCode: null, toStatusCode: 'PAID_AND_ISSUED', byMembershipId: 'mem-a1',
      });
    });

    it('AC-1: appends every move, oldest first, and never rewrites one', async () => {
      const lead = await sales();
      await wired.leadRecords.setStatus(A(), lead.id, 'FOLLOW_UP');
      await wired.leadRecords.setStatus(A(), lead.id, 'POLICY_SUBMITTED');

      const stored = await mongoose.connection.db!.collection('leads')
        .findOne({ _id: new mongoose.Types.ObjectId(lead.id) });
      expect((stored!.transitions as { fromStatusCode: string | null; toStatusCode: string }[])
        .map((tr) => [tr.fromStatusCode, tr.toStatusCode]))
        .toEqual([[null, 'FOLLOW_UP'], ['FOLLOW_UP', 'POLICY_SUBMITTED']]);
    });

    it('AC-2: refuses a stage from the other ladder, naming both', async () => {
      const lead = await sales();

      await expect(wired.leadRecords.setStatus(A(), lead.id, 'AAJI_LICENSED'))
        .rejects.toMatchObject({ code: 'LEAD_STATUS_WRONG_PIPELINE' });
    });

    it('AC-5b: refuses a retired stage, while a lead already on one keeps it', async () => {
      // Invariant §3: archived configuration stays readable so history renders, not writable.
      const [salesLadder] = await wired.leads.list(A());
      const followUp = salesLadder.statuses.find((s) => s.code === 'FOLLOW_UP')!;
      const lead = await sales();
      await wired.leadRecords.setStatus(A(), lead.id, 'FOLLOW_UP');
      await wired.leads.archive(A(), followUp.id);

      const second = await sales();
      await expect(wired.leadRecords.setStatus(A(), second.id, 'FOLLOW_UP'))
        .rejects.toMatchObject({ code: 'CONFIG_ARCHIVED' });
      expect((await wired.leadRecords.read(A(), lead.id)).statusCode).toBe('FOLLOW_UP');
    });

    it('refuses a stage before the agent has chosen a ladder', async () => {
      // The prototype disables the select until a type is picked, and it is right to: a stage
      // means nothing until we know which vocabulary it belongs to.
      const lead = await create(A());

      await expect(wired.leadRecords.setStatus(A(), lead.id, 'FOLLOW_UP'))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('refuses a stage this office does not have', async () => {
      const lead = await sales();
      await expect(wired.leadRecords.setStatus(A(), lead.id, 'INVENTED'))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('writes nothing when the lead is already there', async () => {
      const lead = await sales();
      const once = await wired.leadRecords.setStatus(A(), lead.id, 'FOLLOW_UP');
      const again = await wired.leadRecords.setStatus(A(), lead.id, 'FOLLOW_UP');

      expect(again.version).toBe(once.version);
    });

    it('clears the rung and the commitment when the ladder itself changes', async () => {
      /*
       * The two ladders share no stage, so a reclassified lead that kept its code would hold one
       * from a ladder it is not on — and `setOutcome('won')` would then read `isTerminal` off the
       * wrong pipeline's stage and let it close from nowhere.
       */
      const lead = await sales();
      await wired.leadRecords.setStatus(A(), lead.id, 'PAID_AND_ISSUED');
      await wired.leadRecords.update(A(), lead.id, { thisMonth: true });

      const moved = await wired.leadRecords.update(A(), lead.id, { type: 'recruitment' });

      expect(moved).toMatchObject({ type: 'recruitment', statusCode: null, thisMonth: false });
      await expect(wired.leadRecords.setOutcome(A(), lead.id, 'won'))
        .rejects.toMatchObject({ code: 'LEAD_STATUS_NOT_FINAL' });
    });

    it('leaves the rung alone when the patch names the type it already has', async () => {
      const lead = await sales();
      await wired.leadRecords.setStatus(A(), lead.id, 'FOLLOW_UP');

      const same = await wired.leadRecords.update(A(), lead.id, { type: 'sales' });

      expect(same.statusCode).toBe('FOLLOW_UP');
    });
  });

  describe('P7-T3 — closing, and reopening', () => {
    beforeEach(() => provisionOffice(wired, KPM_A, COMPANY));

    const atStage = async (code: string) => {
      const lead = await create(A(), { type: 'sales' });
      return wired.leadRecords.setStatus(A(), lead.id, code);
    };

    it('AC-3: refuses won below the stage that closes the pipeline', async () => {
      const lead = await atStage('FOLLOW_UP');

      await expect(wired.leadRecords.setOutcome(A(), lead.id, 'won'))
        .rejects.toMatchObject({ code: 'LEAD_STATUS_NOT_FINAL' });
    });

    it('AC-3: takes won at that stage', async () => {
      const lead = await atStage('PAID_AND_ISSUED');

      const won = await wired.leadRecords.setOutcome(A(), lead.id, 'won');

      expect(won.outcome).toBe('won');
    });

    it('AC-3: takes lost at any stage, including none at all', async () => {
      // §3.7 reconciles two prototype screens that disagree, by taking the stricter half of each:
      // the agent screen allows Lost anywhere and the coaching screen gates it.
      const early = await atStage('NOT_YET_APPROACHED');
      const unstaged = await create(A());

      expect((await wired.leadRecords.setOutcome(A(), early.id, 'lost')).outcome).toBe('lost');
      expect((await wired.leadRecords.setOutcome(A(), unstaged.id, 'lost')).outcome).toBe('lost');
    });

    it('AC-4: refuses a second outcome, and reopening is the way back', async () => {
      const lead = await atStage('NOT_YET_APPROACHED');
      await wired.leadRecords.setOutcome(A(), lead.id, 'lost');

      await expect(wired.leadRecords.setOutcome(A(), lead.id, 'won'))
        .rejects.toMatchObject({ code: 'LEAD_ALREADY_CLOSED' });

      const reopened = await wired.leadRecords.setOutcome(A(), lead.id, null);
      expect(reopened).toMatchObject({ outcome: null, statusCode: 'NOT_YET_APPROACHED' });
    });

    it('AC-4: reopening appends no transition — the lead has not moved', async () => {
      const lead = await atStage('NOT_YET_APPROACHED');
      await wired.leadRecords.setOutcome(A(), lead.id, 'lost');
      await wired.leadRecords.setOutcome(A(), lead.id, null);

      const stored = await mongoose.connection.db!.collection('leads')
        .findOne({ _id: new mongoose.Types.ObjectId(lead.id) });
      expect(stored!.transitions).toHaveLength(1);
    });

    it('refuses moving a closed lead, and says to reopen it', async () => {
      const lead = await atStage('FOLLOW_UP');
      await wired.leadRecords.setOutcome(A(), lead.id, 'lost');

      await expect(wired.leadRecords.setStatus(A(), lead.id, 'POLICY_SUBMITTED'))
        .rejects.toMatchObject({ code: 'LEAD_ALREADY_CLOSED' });
    });
  });

  describe('P7-T2 — the read the screen is built on', () => {
    beforeEach(() => provisionOffice(wired, KPM_A, COMPANY));

    const many = async () => {
      await create(A(), { name: 'Ibu Dewi', type: 'sales', remarks: 'Golf on Sundays.', nextActionDate: '2026-10-02' });
      await create(A(), { name: 'Pak Hendro', type: 'sales', remarks: 'Comparing quotes.', nextActionDate: '2026-09-01' });
      await create(A(), { name: 'Sdri. Maya', type: 'recruitment' });
    };

    it('searches the name and the remarks', async () => {
      await many();

      expect((await wired.leadRecords.list(A(), { search: 'dewi' })).rows.map((l) => l.name))
        .toEqual(['Ibu Dewi']);
      expect((await wired.leadRecords.list(A(), { search: 'golf' })).rows.map((l) => l.name))
        .toEqual(['Ibu Dewi']);
    });

    it('treats a search as text, not as a pattern', async () => {
      // A lead's name is user input, and `(` in a regular expression is not a bracket.
      await create(A(), { name: 'Pak Budi (referral)' });

      expect((await wired.leadRecords.list(A(), { search: '(referral)' })).rows)
        .toHaveLength(1);
    });

    it('filters by ladder, including the leads that have none', async () => {
      await many();
      await create(A(), { name: 'Unassigned one' });

      expect((await wired.leadRecords.list(A(), { type: 'recruitment' })).rows).toHaveLength(1);
      expect((await wired.leadRecords.list(A(), { type: 'unassigned' })).rows.map((l) => l.name))
        .toEqual(['Unassigned one']);
    });

    it('filters by attention, which is derived rather than stored', async () => {
      await many();

      const overdue = await wired.leadRecords.list(A(), { attention: 'overdue' });
      expect(overdue.rows.map((l) => l.name)).toEqual(['Pak Hendro']);

      const unplanned = await wired.leadRecords.list(A(), { attention: 'no-next-action' });
      expect(unplanned.rows.map((l) => l.name)).toEqual(['Sdri. Maya']);
    });

    it('P7-T4 AC-2: a commitment does not hide an overdue lead', async () => {
      /*
       * The prototype shows only the green *Closes this month* chip on a lead that is also two
       * weeks overdue, hiding exactly the leads most needing attention. Registered as an
       * Improvement.
       */
      const lead = await create(A(), {
        name: 'Committed and late', type: 'sales', nextActionDate: '2026-09-01', thisMonth: true,
      });

      expect(lead.flags).toContain('overdue');
      expect((await wired.leadRecords.list(A(), { attention: 'overdue' })).rows.map((l) => l.id))
        .toContain(lead.id);
    });

    it('carries no flags on a closed lead', async () => {
      const lead = await create(A(), { name: 'Done', type: 'sales' });
      await wired.leadRecords.setOutcome(A(), lead.id, 'lost');

      expect((await wired.leadRecords.read(A(), lead.id)).flags).toEqual([]);
    });

    it('sorts on one key, in the direction asked for', async () => {
      await many();

      const byName = await wired.leadRecords.list(A(), { sort: 'name', dir: 'asc' });
      expect(byName.rows.map((l) => l.name)).toEqual(['Ibu Dewi', 'Pak Hendro', 'Sdri. Maya']);
    });

    it('pages, and says how many there are to page through', async () => {
      await many();

      const page = await wired.leadRecords.list(A(), { pageSize: 2, page: 2, sort: 'name', dir: 'asc' });

      expect(page).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(page.rows.map((l) => l.name)).toEqual(['Sdri. Maya']);
    });
  });
});
