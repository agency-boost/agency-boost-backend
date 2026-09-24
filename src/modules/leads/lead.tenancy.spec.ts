import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

const NOW = new Date('2026-09-24T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';

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

      expect((await wired.leadRecords.listMine(A())).map((l) => l.name)).toEqual(['Ours']);
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
      expect(await wired.leadRecords.listMine(A())).toEqual([]);
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
});
