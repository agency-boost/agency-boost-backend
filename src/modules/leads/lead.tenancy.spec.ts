import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import type { LeadRepository } from './lead.repository';

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
  beforeEach(async () => {
    await clearCollections();
    // A real office row per tenant, because `TenantDay` reads `kpms.timezone` rather than a
    // constant (invariant §9). Without these it falls back to the platform default and the
    // zone tests below would be asserting the fallback.
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
  });

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

    /*
     * P11-T4 AC-3: the write that carries its own version check. Scoped like every write on the
     * repository — the tenant in the filter, the caller as `updatedBy` — so a version that matches is
     * still nothing found in another office.
     */
    describe('P11-T4 — `updateAtVersion`, the version check and the write in one', () => {
      const repository = () => (wired.leadRecords as unknown as { leads: LeadRepository }).leads;

      it('writes at the version it names, and stamps the caller', async () => {
        const ours = await create(A());
        const written = await repository().updateAtVersion(A(), ours.id, ours.version, { $inc: { version: 1 } });
        expect(written).toMatchObject({ version: ours.version + 1, updatedBy: 'mem-a1' });
      });

      it('finds nothing at a version the lead has moved past', async () => {
        const ours = await create(A());
        await wired.leadRecords.update(A(), ours.id, { remarks: 'Moved on.' });
        expect(await repository().updateAtVersion(A(), ours.id, ours.version, { $set: { remarks: 'Stale.' } }))
          .toBeNull();
      });

      it('finds nothing in another office, the right version notwithstanding', async () => {
        const theirs = await create(B(), { name: 'Theirs' });
        expect(await repository().updateAtVersion(A(), theirs.id, theirs.version, { $set: { name: 'Ours now' } }))
          .toBeNull();
        expect((await wired.leadRecords.read(B(), theirs.id)).name).toBe('Theirs');
      });
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

  /**
   * The prototype's four header sorts, on the server (P10.1-T4 AC-3, ADR-0063 §3).
   *
   * **Two of them need the office's ladders beside the row**, so they are ordered in the service
   * rather than by the database — over the whole filtered set, before the page is cut, because
   * `/leads` asks for every page in turn and a set ordered page by page would interleave.
   */
  describe('P10.1-T4 — Type and Status sort on the server', () => {
    // Published, as provisioning publishes a real office's first copy: the ranks are what agents
    // were given, not the rows the Owner is editing.
    beforeEach(async () => {
      await provisionOffice(wired, KPM_A, COMPANY);
      await wired.config.publish(A());
    });
    afterEach(() => (wired.clock as FixedClock).set(NOW));

    /** Registered on `day` of September, then moved to `stage` if one is named. */
    const lead = async (
      name: string, type: 'sales' | 'recruitment' | null, stage: string | null, day: number,
    ) => {
      (wired.clock as FixedClock).set(new Date(`2026-09-${String(day).padStart(2, '0')}T02:00:00Z`));
      const made = await create(A(), { name, type });
      if (stage) await wired.leadRecords.setStatus(A(), made.id, stage);
      return made;
    };

    /*
     * Created in an order that matches none of the expected ones, so neither the insertion order
     * nor the id can pass for the rule. *Sales, Sep 15* is created after *Sales, Sep 22* and
     * registered before it: only the registration tie-break puts it first.
     */
    const office = async () => {
      await lead('Sales, Sep 22', 'sales', 'FOLLOW_UP', 22);
      await lead('Recruit, Sep 5', 'recruitment', 'MEETING_SCHEDULED', 5);
      await lead('Sales new, Sep 24', 'sales', 'NOT_YET_APPROACHED', 24);
      await lead('Sales blank, Sep 1', 'sales', null, 1);
      await lead('Recruit late, Sep 2', 'recruitment', 'AAJI_LICENSED', 2);
      await lead('No type, Sep 10', null, null, 10);
      await lead('Sales, Sep 15', 'sales', 'FOLLOW_UP', 15);
      (wired.clock as FixedClock).set(NOW);
    };

    const names = async (query: Record<string, unknown>) =>
      (await wired.leadRecords.list(A(), { pageSize: 200, ...query })).rows.map((l) => l.name);

    /*
     * Blank first — the lead with no type, then the sales lead with no stage. Then rank 1, then
     * the three on rank 2: FOLLOW_UP is sales rank 2 and MEETING_SCHEDULED recruitment rank 2, so
     * the tie goes to sales, and inside sales to the earlier registration. Rank 5 last.
     */
    const STATUS_ASC = [
      'No type, Sep 10', 'Sales blank, Sep 1', 'Sales new, Sep 24',
      'Sales, Sep 15', 'Sales, Sep 22', 'Recruit, Sep 5', 'Recruit late, Sep 2',
    ];

    it('orders status by the stage’s rank in its own ladder, blank first', async () => {
      await office();

      expect(await names({ sort: 'status', dir: 'asc' })).toEqual(STATUS_ASC);
    });

    it('breaks a tie on rank by type, then by registration — D-06’s objection, answered', async () => {
      await office();
      const rankTwo = (await names({ sort: 'status', dir: 'asc' }))
        .filter((n) => ['Sales, Sep 15', 'Sales, Sep 22', 'Recruit, Sep 5'].includes(n));

      // A sales rank 2 is not a recruitment rank 2. The recruitment lead is the oldest of the
      // three, so registration alone would have put it first.
      expect(rankTwo).toEqual(['Sales, Sep 15', 'Sales, Sep 22', 'Recruit, Sep 5']);
    });

    it('reverses the whole comparison for desc, tie-breaks included', async () => {
      await office();

      expect(await names({ sort: 'status', dir: 'desc' })).toEqual([...STATUS_ASC].reverse());
    });

    it('orders type blank, Sales, Recruitment, each by registration', async () => {
      await office();

      expect(await names({ sort: 'type', dir: 'asc' })).toEqual([
        'No type, Sep 10',
        'Sales blank, Sep 1', 'Sales, Sep 15', 'Sales, Sep 22', 'Sales new, Sep 24',
        'Recruit late, Sep 2', 'Recruit, Sep 5',
      ]);
      expect(await names({ sort: 'type', dir: 'desc' })).toEqual([
        'Recruit, Sep 5', 'Recruit late, Sep 2',
        'Sales new, Sep 24', 'Sales, Sep 22', 'Sales, Sep 15', 'Sales blank, Sep 1',
        'No type, Sep 10',
      ]);
    });

    it('sorts before it pages, so page 2 carries on where page 1 stopped', async () => {
      await office();

      const pages = await Promise.all([1, 2, 3].map((page) =>
        wired.leadRecords.list(A(), { sort: 'status', dir: 'asc', pageSize: 3, page })));

      expect(pages[1].rows.map((l) => l.name)).toEqual(['Sales, Sep 15', 'Sales, Sep 22', 'Recruit, Sep 5']);
      expect(pages.flatMap((p) => p.rows.map((l) => l.name))).toEqual(STATUS_ASC);
      expect(pages.map((p) => p.total)).toEqual([7, 7, 7]);
    });

    it('ranks by the published ladder the Status dropdown lists, so a reorder moves the sort when it is published', async () => {
      // Invariant §4: the rank is presentation, and the Owner's settings screen reorders it. The
      // screen's options and tints come from `/kpm/config`, the published copy, so the sort does too:
      // read from the live rows, it moved while every dropdown still showed the old order.
      await office();
      const [sales] = await wired.leads.list(A());
      await wired.leads.reorder(A(), 'sales', [...sales.statuses].reverse().map((s) => s.id));

      expect(await names({ sort: 'status', dir: 'asc' })).toEqual(STATUS_ASC);

      await wired.config.publish(A());

      // Sales now reads PAID … FOLLOW_UP (4th), NOT_YET_APPROACHED (5th). MEETING_SCHEDULED is 2nd
      // on its own ladder, AAJI_LICENSED 5th, and the sales lead takes the tie on 5th.
      expect(await names({ sort: 'status', dir: 'asc' })).toEqual([
        'No type, Sep 10', 'Sales blank, Sep 1', 'Recruit, Sep 5',
        'Sales, Sep 15', 'Sales, Sep 22', 'Sales new, Sep 24', 'Recruit late, Sep 2',
      ]);
    });

    it('sorts a lead on a stage retired and published since with the blanks, as its row shows it', async () => {
      // Invariant §3: the lead keeps the code. The published ladder no longer lists the stage, so
      // the row shows the code marked *(retired)*, untinted, and the prototype's `indexOf` gives -1.
      await office();
      const [sales] = await wired.leads.list(A());
      await wired.leads.archive(A(), sales.statuses.find((s) => s.code === 'FOLLOW_UP')!.id);

      // Until it is published, agents still have the stage, in its place.
      expect(await names({ sort: 'status', dir: 'asc' })).toEqual(STATUS_ASC);

      await wired.config.publish(A());

      expect(await names({ sort: 'status', dir: 'asc' })).toEqual([
        'No type, Sep 10', 'Sales blank, Sep 1', 'Sales, Sep 15', 'Sales, Sep 22',
        'Sales new, Sep 24', 'Recruit, Sep 5', 'Recruit late, Sep 2',
      ]);
    });

    it('reads this office’s published ladder and never another’s', async () => {
      // The snapshot comes through the tenant-scoped repository. Another office reversing its own
      // sales ladder and publishing it changes nothing here.
      await provisionOffice(wired, KPM_B, COMPANY);
      await office();
      const [theirs] = await wired.leads.list(B());
      await wired.leads.reorder(B(), 'sales', [...theirs.statuses].reverse().map((s) => s.id));
      await wired.config.publish(B());

      expect(await names({ sort: 'status', dir: 'asc' })).toEqual(STATUS_ASC);
    });

    it('sorts only the filtered set, and the filters still apply', async () => {
      await office();

      expect(await names({ sort: 'status', dir: 'asc', type: 'recruitment' }))
        .toEqual(['Recruit, Sep 5', 'Recruit late, Sep 2']);
    });

    it('leaves registration and next action to the database', async () => {
      await office();
      const id = new Map((await wired.leadRecords.list(A())).rows.map((l) => [l.name, l.id]));
      await wired.leadRecords.update(A(), id.get('Sales new, Sep 24')!, { nextActionDate: '2026-10-01' });
      await wired.leadRecords.update(A(), id.get('Sales blank, Sep 1')!, { nextActionDate: '2026-09-30' });

      // Newest registration first when nothing is asked for — the prototype's default (`:5432`).
      expect((await names({})).slice(0, 2)).toEqual(['Sales new, Sep 24', 'Sales, Sep 22']);
      expect((await names({ sort: 'nextActionDate', dir: 'desc' })).slice(0, 2))
        .toEqual(['Sales new, Sep 24', 'Sales blank, Sep 1']);
    });

    it('sorts names without regard to case or accents, as the prototype’s lowercase `localeCompare`', async () => {
      // A name is stored as typed (D-12). In byte order *budi* and *Émile* came after *Zed*.
      for (const name of ['Zed', 'budi', 'Émile', 'Adi', 'Fikri']) await create(A(), { name });

      expect(await names({ sort: 'name', dir: 'asc' })).toEqual(['Adi', 'budi', 'Émile', 'Fikri', 'Zed']);
      expect(await names({ sort: 'name', dir: 'desc' })).toEqual(['Zed', 'Fikri', 'Émile', 'budi', 'Adi']);
    });

    /*
     * **Ties are the ordinary case, not the edge.** Leads added in one sitting share a registration
     * date to the minute, most have no next action, and names repeat. `/leads` reads 200 at a time,
     * and MongoDB promises no order among equal keys, so without a last key a tie across a page
     * boundary may fall one way for page 1 and the other for page 2: one lead twice, another never.
     */
    it.each([
      ['dateRegistered', 'asc'], ['dateRegistered', 'desc'],
      ['nextActionDate', 'asc'], ['nextActionDate', 'desc'],
      ['name', 'asc'], ['name', 'desc'],
    ] as const)('pages a tie on %s %s by the id, never repeating or skipping a lead', async (sort, dir) => {
      // Nine leads at one instant, with one name and no next action: every key ties.
      const made: string[] = [];
      for (let i = 0; i < 9; i += 1) made.push((await create(A(), { name: 'Pak Budi' })).id);
      const byId = [...made].sort();

      const pages = await Promise.all([1, 2, 3, 4, 5].map((page) =>
        wired.leadRecords.list(A(), { sort, dir, pageSize: 2, page })));
      const paged = pages.flatMap((p) => p.rows.map((l) => l.id));

      expect(new Set(paged).size).toBe(9);
      expect(paged).toEqual(dir === 'asc' ? byId : byId.reverse());
    });
  });

  /**
   * Triage (P7-T4).
   *
   * **The flags are derived on every read and stored nowhere.** A stored flag is one that is
   * wrong at midnight — and *which* midnight is the rest of this block.
   */
  describe('P7-T4 — what is asking to be picked up', () => {
    beforeEach(() => provisionOffice(wired, KPM_A, COMPANY));
    afterEach(() => (wired.clock as FixedClock).set(NOW));

    const at = (instant: string) => (wired.clock as FixedClock).set(new Date(instant));
    const zone = (kpmId: string, timezone: string) =>
      mongoose.connection.db!.collection('kpms')
        .updateOne({ _id: new mongoose.Types.ObjectId(kpmId) }, { $set: { timezone } });

    it('AC-1: derives the three flags and stores none of them', async () => {
      const lead = await create(A(), { nextActionDate: '2026-09-01' });

      const stored = await mongoose.connection.db!.collection('leads')
        .findOne({ _id: new mongoose.Types.ObjectId(lead.id) });
      expect(stored).not.toHaveProperty('flags');
      expect((await wired.leadRecords.read(A(), lead.id)).flags)
        .toEqual(['overdue', 'no-remarks']);
    });

    it('AC-4: forgetting a date and missing one are different flags', async () => {
      const forgotten = await create(A(), { name: 'No date', remarks: 'Talked on Friday.' });
      const missed = await create(A(), { name: 'Late', remarks: 'Talked on Friday.', nextActionDate: '2026-09-01' });

      expect((await wired.leadRecords.read(A(), forgotten.id)).flags).toEqual(['no-next-action']);
      expect((await wired.leadRecords.read(A(), missed.id)).flags).toEqual(['overdue']);
    });

    it('AC-3: overdue is the office’s day, not the server’s', async () => {
      /*
       * 2026-09-25T17:30Z is already the 26th in Jakarta and still the 25th in UTC. A lead due
       * on the 25th is late for an office in Jakarta and not late for one reading the server's
       * clock — which is the whole of invariant §9 in one row.
       */
      await zone(KPM_A, 'Asia/Jakarta');
      const lead = await create(A(), { remarks: 'Talked on Friday.', nextActionDate: '2026-09-25' });
      at('2026-09-25T17:30:00Z');

      expect((await wired.leadRecords.read(A(), lead.id)).flags).toEqual(['overdue']);
      expect(new Date('2026-09-25T17:30:00Z').toISOString().slice(0, 10)).toBe('2026-09-25');
    });

    it('AC-3: and the same instant is not overdue for an office further west', async () => {
      // v1 runs every office on Asia/Jakarta (ADR-0016). The column is real all the same, and
      // this is the test that fails the moment somebody replaces it with the constant.
      await zone(KPM_A, 'America/New_York');
      const lead = await create(A(), { remarks: 'Talked on Friday.', nextActionDate: '2026-09-25' });
      at('2026-09-25T17:30:00Z');

      expect((await wired.leadRecords.read(A(), lead.id)).flags).toEqual([]);
    });

    it('counts how late in whole office days, not in epoch arithmetic', async () => {
      await zone(KPM_A, 'Asia/Jakarta');
      const lead = await create(A(), { remarks: 'Talked on Friday.', nextActionDate: '2026-09-11' });

      // NOW is 2026-09-25T02:00Z — 09:00 on the 25th in Jakarta. Fourteen days.
      const read = await wired.leadRecords.read(A(), lead.id);
      expect(read.overdueDays).toBe(14);
    });

    it('carries no day count on a lead that is not overdue', async () => {
      const onTime = await create(A(), { remarks: 'Talked on Friday.', nextActionDate: '2026-10-02' });
      const undated = await create(A(), { name: 'No date', remarks: 'Talked on Friday.' });

      expect((await wired.leadRecords.read(A(), onTime.id)).overdueDays).toBeNull();
      expect((await wired.leadRecords.read(A(), undated.id)).overdueDays).toBeNull();
    });

    it('AC-2: a commitment for the month hides nothing', async () => {
      // The prototype shows only the green chip on a lead that is also two weeks overdue,
      // which hides exactly the leads most needing attention. Registered as I-103.
      const lead = await create(A(), { thisMonth: true, nextActionDate: '2026-09-11' });

      const read = await wired.leadRecords.read(A(), lead.id);
      expect(read.thisMonth).toBe(true);
      expect(read.flags).toEqual(['overdue', 'no-remarks']);
      expect(read.overdueDays).toBe(14);
    });

    it('a closed lead is asking for nothing', async () => {
      const lead = await create(A(), { nextActionDate: '2026-09-01' });
      await wired.leadRecords.setOutcome(A(), lead.id, 'lost');

      const read = await wired.leadRecords.read(A(), lead.id);
      expect(read.flags).toEqual([]);
      expect(read.overdueDays).toBeNull();
    });
  });


  /**
   * The monthly rollover (P7-T5).
   *
   * **There is nothing to run, and that is the design.** `thisMonth` is derived from the month the
   * promise names, so it is right on the first of the month for an agent who has not opened the app
   * since March — with no job, no scheduler, and nothing to have missed them.
   */
  describe('P7-T5 — the commitment, and the month it was made for', () => {
    beforeEach(() => provisionOffice(wired, KPM_A, COMPANY));
    afterEach(() => (wired.clock as FixedClock).set(NOW));

    const at = (instant: string) => (wired.clock as FixedClock).set(new Date(instant));
    const commit = (id: string, thisMonth: boolean) =>
      wired.leadRecords.update(A(), id, { thisMonth });

    it('AC-1: rolls over for an agent who never opens the app', async () => {
      // The prototype clears the flag from `localStorage` when the agent loads the screen, so
      // somebody who does not open it in October is still promising September's lead in December.
      const lead = await create(A(), { thisMonth: true });
      expect(lead.thisMonth).toBe(true);

      at('2026-10-01T02:00:00Z');

      // Nothing has run. Nothing needed to.
      expect((await wired.leadRecords.read(A(), lead.id)).thisMonth).toBe(false);
    });

    it('AC-3: and what was promised is still there afterwards', async () => {
      const lead = await create(A(), { thisMonth: true });

      at('2026-10-01T02:00:00Z');

      // *Did they do what they said in September* is answerable in October, which a cleared
      // boolean could not do. The promise was written down when it was made.
      expect((await wired.leadRecords.read(A(), lead.id)).committedMonths).toEqual(['2026-09']);
    });

    it('AC-2: the month boundary is the office’s, not the server’s', async () => {
      /*
       * 2026-09-30T18:00Z is already October in Jakarta and still September in New York. One
       * instant, two offices, two answers — and the commitment was made in September either way.
       */
      const lead = await create(A(), { thisMonth: true });
      await mongoose.connection.db!.collection('kpms').updateOne(
        { _id: new mongoose.Types.ObjectId(KPM_A) }, { $set: { timezone: 'Asia/Jakarta' } },
      );
      at('2026-09-30T18:00:00Z');

      expect((await wired.leadRecords.read(A(), lead.id)).thisMonth).toBe(false);

      await mongoose.connection.db!.collection('kpms').updateOne(
        { _id: new mongoose.Types.ObjectId(KPM_A) }, { $set: { timezone: 'America/New_York' } },
      );
      expect((await wired.leadRecords.read(A(), lead.id)).thisMonth).toBe(true);
    });

    it('AC-4: promising a lead twice in one month writes nothing the second time', async () => {
      const lead = await create(A());
      const once = await commit(lead.id, true);
      const again = await commit(lead.id, true);

      expect(once.committedMonths).toEqual(['2026-09']);
      expect(again.committedMonths).toEqual(['2026-09']);
    });

    it('records the month again when the agent promises it a second month', async () => {
      const lead = await create(A(), { thisMonth: true });
      at('2026-10-05T02:00:00Z');

      const carried = await commit(lead.id, true);

      expect(carried.committedMonths).toEqual(['2026-09', '2026-10']);
      expect(carried.thisMonth).toBe(true);
    });

    it('un-ticking inside the month corrects today’s promise rather than erasing a past one', async () => {
      const lead = await create(A(), { thisMonth: true });
      at('2026-10-05T02:00:00Z');
      await commit(lead.id, true);

      const retracted = await commit(lead.id, false);

      expect(retracted.thisMonth).toBe(false);
      // September is untouched: it is a thing that was said, not a thing being decided.
      expect(retracted.committedMonths).toEqual(['2026-09']);
    });

    it('stores no boolean at all — the flag is read, never written', async () => {
      const lead = await create(A(), { thisMonth: true });

      const stored = await mongoose.connection.db!.collection('leads')
        .findOne({ _id: new mongoose.Types.ObjectId(lead.id) });
      expect(stored).not.toHaveProperty('thisMonth');
      expect(stored!.commitments).toHaveLength(1);
    });

    it('drops only this month’s promise when the ladder changes', async () => {
      // *Close this month* and *recruit this month* are different promises (I-105). The months
      // before this one are not the patch's to touch.
      const lead = await create(A(), { thisMonth: true });
      at('2026-10-05T02:00:00Z');
      await commit(lead.id, true);

      const moved = await wired.leadRecords.update(A(), lead.id, { type: 'recruitment' });

      expect(moved.thisMonth).toBe(false);
      expect(moved.committedMonths).toEqual(['2026-09']);
    });
  });

});
