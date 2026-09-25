import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { CASCADE_ACTIVITY_CODES, GOAL_DEFAULTS } from '@/domain/constants';
import { GOAL_BOUNDS } from './goal-input';
import { Goal, GoalSchema } from './goal.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

const NOW = new Date('2026-09-25T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';

const member = (kpmId: string, membershipId: string) => new RequestContext('u1', 'none', {
  membershipId, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0,
} as never);

/** Somebody signed in who has joined no office yet. */
const noOffice = () => new RequestContext('u9', 'none', null);

/**
 * The goal record (P8-T1).
 *
 * **The task is what a goal *is*, not what its numbers mean together.** The cascade — five steps,
 * both entry modes, every constant — is P8-T2, and the line between them is visible here: this file
 * asserts that a stored snapshot and the inputs beside it are independent, and never that one
 * produces the other.
 */
describe('the goal record (P8-T1)', () => {
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
    // `clearCollections` empties the collections and leaves the indexes to Mongoose, which builds
    // them lazily. The uniqueness below is a **database** guarantee, so the database has to have it.
    await mongoose.model(Goal.name).syncIndexes();
  });

  /** A complete, plausible goal. Every test names only what it is about. */
  const plan = (over: Record<string, unknown> = {}) => ({
    period: '2026',
    mode: 'direct',
    annualApeTargetMinor: 500_000_000_00,
    savingsTargetMinor: 50_000_000_00,
    commissionRatePct: 10,
    monthsLeft: 3.2,
    apeAchievedMinor: 0,
    caseSizeMinor: 18_000_000_00,
    leadsToApptPct: 30,
    closingRatePct: 30,
    ...over,
  });

  const save = (ctx: RequestContext, over: Record<string, unknown> = {}) =>
    wired.goals.save(ctx, plan(over));

  const stored = (id: string) => mongoose.connection.db!.collection('goals')
    .findOne({ _id: new mongoose.Types.ObjectId(id) });

  describe('AC-1 — what the document carries', () => {
    it('is owned by the membership that saved it, never by a user id', async () => {
      // Invariant §2: a person who leaves and rejoins gets a new membership, and the plan they
      // agreed to stays with the office that agreed it rather than following them.
      const goal = await save(A());

      expect(goal.membershipId).toBe('mem-a1');
      const row = await stored(goal.id);
      expect(row).toMatchObject({ kpmId: KPM_A, membershipId: 'mem-a1', deletedAt: null });
      expect(row).not.toHaveProperty('userId');
      expect(row!.createdBy).toBe('mem-a1');
    });

    it('leads every index with kpmId (invariant §1)', () => {
      /*
       * Read off the **schema**, and only the **compound** indexes — which is what
       * `index-conventions.tenancy.spec.ts` checks for every collection in the product, and the
       * check `goals` is now registered for. A single-field index on `membershipId` is the
       * field's own, not a query path: nothing reads this collection without a tenant.
       */
      const compound = GoalSchema.indexes()
        .map(([key]) => key as Record<string, unknown>)
        .filter((key) => Object.keys(key).length > 1);

      expect(compound.length).toBeGreaterThan(0);
      for (const key of compound) {
        expect(Object.keys(key)[0]).toBe('kpmId');
      }
    });

    it('refuses somebody who has joined no office, rather than writing a goal with no owner', async () => {
      await expect(wired.goals.save(noOffice(), plan()))
        .rejects.toMatchObject({ code: 'TENANT_NO_MEMBERSHIP' });
    });
  });

  describe('AC-2 — one office cannot reach another’s', () => {
    it('is 404, never 403, on read', async () => {
      await save(A());

      await expect(wired.goals.read(B(), '2026')).rejects.toMatchObject({
        code: 'NOT_FOUND', status: 404,
      });
    });

    it('does not list another office’s goals', async () => {
      await save(A());

      expect(await wired.goals.list(B())).toEqual([]);
    });

    it('lets both offices hold a goal for the same person id and period', async () => {
      // The uniqueness key is `(kpmId, membershipId, period)`. Two offices are two keys.
      await wired.goals.save(member(KPM_A, 'mem-same'), plan());
      await wired.goals.save(member(KPM_B, 'mem-same'), plan());

      expect((await wired.goals.read(member(KPM_A, 'mem-same'), '2026')).period).toBe('2026');
      expect((await wired.goals.read(member(KPM_B, 'mem-same'), '2026')).period).toBe('2026');
    });
  });

  describe('AC-3 — money is integer minor units', () => {
    it('stores sen, so Rp 500,000,000 is not 500000000', async () => {
      const goal = await save(A());

      expect(goal.annualApeTargetMinor).toBe(500_000_000_00);
      expect((await stored(goal.id))!.annualApeTargetMinor).toBe(500_000_000_00);
    });

    it('refuses a fraction of a sen, which is a unit error rather than a rounding one', async () => {
      // Somebody handed major units to a field that stores minor ones. There is no amount of
      // rounding that makes that the number they meant.
      await expect(save(A(), { caseSizeMinor: 18_000_000.5 }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('refuses a target past the point integers stop being exact', async () => {
      // `Number.MAX_SAFE_INTEGER` is ≈9.007e15. A figure above it silently loses its last digits,
      // which on an annual target is a number nobody typed.
      expect(GOAL_BOUNDS.money.max).toBeLessThan(Number.MAX_SAFE_INTEGER);
      await expect(save(A(), { annualApeTargetMinor: Number.MAX_SAFE_INTEGER }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('takes a decimal rate, which the prototype cannot (I-108)', async () => {
      // `parseNum` strips every non-digit, so 12.5 becomes 125 — a plan built on a tenfold error.
      const goal = await save(A(), { commissionRatePct: 12.5 });

      expect(goal.commissionRatePct).toBe(12.5);
    });
  });

  describe('AC-4 — the snapshot is the agreed plan, not a display source', () => {
    it('keeps the snapshot and the inputs independent', async () => {
      /*
       * The two answer different questions: *what did we agree to* and *what does that mean today*.
       * `monthsLeft` shrinks every day, so a plan saved in January and displayed in June would
       * claim a year that no longer has eleven months left in it (client PRD §17).
       *
       * This asserts only that they **can** differ. That a read *recomputes* is P8-T2's, with the
       * formula — a test here would be asserting arithmetic this task does not contain.
       */
      const goal = await save(A());
      await mongoose.connection.db!.collection('goals').updateOne(
        { _id: new mongoose.Types.ObjectId(goal.id) },
        { $set: { 'snapshot.policiesPerMonth': 6, 'snapshot.leadsPerMonth': 67 } },
      );

      const read = await wired.goals.read(A(), '2026');

      expect(read.snapshot).toMatchObject({ policiesPerMonth: 6, leadsPerMonth: 67 });
      // The inputs are untouched by the snapshot, and would produce their own answer.
      expect(read.caseSizeMinor).toBe(18_000_000_00);
      expect(read.monthsLeft).toBe(3.2);
    });

    it('starts a new goal with no agreed figures, which is a real state', async () => {
      const goal = await save(A());

      expect(goal.snapshot).toEqual({
        monthlyApeTargetMinor: 0, policiesPerMonth: 0, appointmentsPerMonth: 0, leadsPerMonth: 0,
      });
    });
  });

  describe('AC-5 — the cascade binds to codes, never to positions', () => {
    it('stores three activity codes', async () => {
      const goal = await save(A());

      expect(goal.cascadeMapping).toEqual({
        leadsCode: 'LEADS_CONTACTED',
        appointmentsCode: 'SELL_PRESENTATION',
        closingsCode: 'SELL_SUBMISSION',
      });
      expect(goal.cascadeMapping).toEqual({ ...CASCADE_ACTIVITY_CODES });
    });

    it('holds no display position anywhere, so reordering the office’s list moves nothing', async () => {
      /*
       * The prototype's tip reads *"Maps to activities #3, #4, #6"*, and the Owner's settings screen
       * lets an office drag that list. A goal storing 3, 4 and 6 would silently rebind to three
       * different activities the moment somebody tidied their taxonomy (invariant §4).
       */
      const goal = await save(A());
      const row = await stored(goal.id);

      const mapping = row!.cascadeMapping as Record<string, unknown>;
      for (const value of Object.values(mapping)) {
        expect(typeof value).toBe('string');
        expect(Number.isFinite(Number(value))).toBe(false);
      }
    });
  });

  describe('AC-6 — one goal per membership per period, enforced by the database', () => {
    it('replaces rather than duplicating when the same period is saved again', async () => {
      const first = await save(A(), { annualApeTargetMinor: 300_000_000_00 });
      const second = await save(A(), { annualApeTargetMinor: 500_000_000_00 });

      expect(second.id).toBe(first.id);
      expect(second.annualApeTargetMinor).toBe(500_000_000_00);
      expect(await mongoose.connection.db!.collection('goals')
        .countDocuments({ kpmId: KPM_A, membershipId: 'mem-a1' })).toBe(1);
    });

    it('refuses a second row for the pair even when written around the service', async () => {
      // The index is the guarantee, not the upsert: two saves genuinely race — the agent on a
      // phone and their leader on a laptop in the same 1-on-1, both reading *no goal yet*.
      const goal = await save(A());
      const row = await stored(goal.id);

      await expect(mongoose.connection.db!.collection('goals').insertOne({
        ...row, _id: new mongoose.Types.ObjectId(),
      } as never)).rejects.toMatchObject({ code: 11000 });
    });

    it('keeps two periods apart for one person (ADR-0049)', async () => {
      await save(A(), { period: '2026' });
      await save(A(), { period: '2027' });

      expect((await wired.goals.list(A())).map((g) => g.period)).toEqual(['2027', '2026']);
    });

    it('refuses a period that is not a calendar year', async () => {
      await expect(save(A(), { period: '2026-Q1' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('versioning, and who saved it', () => {
    it('starts at 1 and moves on every save, ready for P8-T6', async () => {
      const first = await save(A());
      const second = await save(A(), { apeAchievedMinor: 12_000_000_00 });

      expect(first.version).toBe(1);
      expect(second.version).toBe(2);
    });

    it('records who saved it, which P8-T4 uses to name a leader', async () => {
      const goal = await save(A());

      expect(goal.savedByMembershipId).toBe('mem-a1');
      expect(goal.savedAt).toBe(NOW.toISOString());
    });

    it('spends `version` on the domain, so Mongoose keeps its own key elsewhere', async () => {
      const goal = await save(A());
      const row = await stored(goal.id);

      expect(row!.version).toBe(1);
      expect(row).toHaveProperty('__v');
    });
  });

  describe('what an office starts somebody on', () => {
    it('offers the registry’s defaults without writing anything', async () => {
      const offered = wired.goals.defaults('2026');

      expect(offered.annualApeTargetMinor).toBe(GOAL_DEFAULTS.ANNUAL_APE_TARGET_MINOR);
      expect(offered.caseSizeMinor).toBe(GOAL_DEFAULTS.CASE_SIZE_MINOR);
      expect(offered.leadsToApptPct).toBe(GOAL_DEFAULTS.LEADS_TO_APPOINTMENT_PCT);
      expect(offered.savedAt).toBeNull();
      expect(await mongoose.connection.db!.collection('goals').countDocuments()).toBe(0);
    });
  });

  describe('a row that predates a field', () => {
    it('reads a goal written without a snapshot or a mapping', async () => {
      /*
       * Both are `required` with a default, so the service never writes one without them — but a
       * row written by an earlier version, or by a migration, has neither.
       *
       * **Mongoose fills them in on hydration**, which is what makes a fallback in the view dead
       * code rather than prudence: the schema's default is the fallback, declared once. This is the
       * test that says so, through the door an old row comes in by.
       */
      await mongoose.connection.db!.collection('goals').insertOne({
        kpmId: KPM_A, membershipId: 'mem-a1', period: '2024', mode: 'direct',
        annualApeTargetMinor: 100_000_000_00, savingsTargetMinor: 0, commissionRatePct: 0,
        monthsLeft: 1, apeAchievedMinor: 0, caseSizeMinor: 10_000_000_00,
        leadsToApptPct: 30, closingRatePct: 30,
        savedAt: null, savedByMembershipId: null, version: 1, deletedAt: null,
      } as never);

      const read = await wired.goals.read(A(), '2024');

      expect(read.snapshot).toEqual({
        monthlyApeTargetMinor: 0, policiesPerMonth: 0, appointmentsPerMonth: 0, leadsPerMonth: 0,
      });
      expect(read.cascadeMapping).toEqual({ ...CASCADE_ACTIVITY_CODES });
      expect(read.savedAt).toBeNull();
    });

    it('fills both in when the schema writes them, so the fallback is never the ordinary path', async () => {
      // Written through the model with neither supplied: Mongoose's own defaults run.
      await mongoose.model(Goal.name).create({
        kpmId: KPM_A, membershipId: 'mem-a1', period: '2023', mode: 'direct',
      } as never);

      const read = await wired.goals.read(A(), '2023');

      expect(read.cascadeMapping.leadsCode).toBe('LEADS_CONTACTED');
      expect(read.snapshot.policiesPerMonth).toBe(0);
    });
  });

  describe('what the audit row may say', () => {
    it('records the period and who saved it, and no figures', async () => {
      // A goal is a person's own plan. An administrator reading the audit log has no business
      // learning what somebody's annual target is from it.
      const goal = await save(A());
      const rows = await mongoose.connection.db!.collection('auditLog')
        .find({ targetCollection: 'goals' }).toArray();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'goal.created', targetId: goal.id });
      expect(JSON.stringify(rows[0].after)).not.toContain('500000000');
    });
  });
});
