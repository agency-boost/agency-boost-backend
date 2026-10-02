import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  CoachingActionItemSchema, CoachingLastWeekItemSchema, CoachingLastWeekSchema, CoachingLeadActionSchema,
  CoachingSession, CoachingSessionCorrectionSchema, CoachingSessionSchema, CoachingSnapshotSchema,
  CoachingTipSchema,
} from './coaching-session.schema';

const NOW = new Date('2026-10-02T03:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const AB = '66f00000000000000000ab01';
const AAB = '66f00000000000000000aa01';
const AGENT = '66f00000000000000000a901';

const member = (kpmId: string, membershipId = AB) => new RequestContext('u1', 'none', {
  membershipId, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 1,
} as never);

/**
 * **The `coachingSessions` record** (P11-T5 AC-9, AC-1; `erd.md` *`coachingSessions`*).
 *
 * What the record is, not what the lifecycle does with it — Start, the draft save, finalize and reopen
 * ship with the workspace that calls them. Here: the indexes `erd.md` declares and nothing else, the
 * database holding one open draft per coach and coachee, the tenant boundary, soft delete, and ADR-0042's
 * correction shape.
 */
describe('the coaching session record (P11-T5)', () => {
  let wired: ReturnType<typeof configModule>;
  const sessions = () => wired.coachingSessions;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    // The one-draft rule is a **database** guarantee, so the database has to have built it.
    await mongoose.model(CoachingSession.name).syncIndexes();
  });

  const draft = (ctx: RequestContext, over: Record<string, unknown> = {}) => sessions().create(ctx, {
    coachMembershipId: AB, coacheeMembershipId: AGENT, ...over,
  } as never);

  describe('AC-9: the indexes are erd.md’s, and kpmId leads every one', () => {
    it('P11-T5 AC-9 declares exactly the history index, the coach’s own (P11-T10) and the one-draft index', () => {
      expect(CoachingSessionSchema.indexes()).toEqual([
        [{ kpmId: 1, coacheeMembershipId: 1, date: -1, frozenAt: -1 }, expect.anything()],
        // P11-T10: the sessions a coach led, newest first — a former coach's list on `/coaching/me` (ADR-0088).
        [{ kpmId: 1, coachMembershipId: 1, date: -1, frozenAt: -1 }, expect.anything()],
        [
          { kpmId: 1, coachMembershipId: 1, coacheeMembershipId: 1 },
          expect.objectContaining({ unique: true, partialFilterExpression: { status: 'draft', deletedAt: null } }),
        ],
      ]);
    });

    it('P11-T5 AC-9 builds no index on the database that does not lead with kpmId', async () => {
      const built = await mongoose.connection.db!.collection('coachingSessions').indexes();
      const keys = built.filter((index) => index.name !== '_id_').map((index) => Object.keys(index.key));
      expect(keys).toHaveLength(3);
      for (const key of keys) expect(key[0]).toBe('kpmId');
    });
  });

  describe('AC-1, ADR-0081: at most one open draft per coach and coachee', () => {
    it('P11-T5 AC-1 refuses a second draft for the same pair at the database', async () => {
      await draft(member(KPM_A));
      await expect(draft(member(KPM_A))).rejects.toMatchObject({ code: 11000 });
      expect(await sessions().count(member(KPM_A))).toBe(1);
    });

    it('P11-T5 AC-1 a finalized or a reopened session is not the pair’s open draft', async () => {
      await draft(member(KPM_A), { status: 'finalized', date: '2026-09-28', frozenAt: NOW, version: 3 });
      await draft(member(KPM_A), { status: 'reopened', date: '2026-09-21', frozenAt: NOW, version: 4 });
      await draft(member(KPM_A));
      expect(await sessions().count(member(KPM_A), { coachMembershipId: AB, coacheeMembershipId: AGENT })).toBe(3);
    });

    it('P11-T5 AC-1 an AAB and the AB above them may each have one open with the same agent', async () => {
      await draft(member(KPM_A));
      await draft(member(KPM_A, AAB), { coachMembershipId: AAB });
      expect(await sessions().count(member(KPM_A), { status: 'draft' })).toBe(2);
    });

    it('P11-T5 AC-1 a soft-deleted draft releases the pair, and the key is per office', async () => {
      const first = await draft(member(KPM_A));
      await sessions().softDeleteById(member(KPM_A), String(first._id), NOW);
      await draft(member(KPM_A));
      await draft(member(KPM_B));
      expect(await sessions().count(member(KPM_A), { status: 'draft' })).toBe(1);
      expect(await sessions().count(member(KPM_B), { status: 'draft' })).toBe(1);
    });
  });

  describe('AC-9: one office cannot reach another’s sessions', () => {
    it('P11-T5 AC-9 office B reads none of office A’s, by id, by list, by count or by rollup', async () => {
      const a = await draft(member(KPM_A), { status: 'finalized', date: '2026-09-30', frozenAt: NOW });
      const asB = member(KPM_B);

      expect(await sessions().findById(asB, String(a._id))).toBeNull();
      expect(await sessions().find(asB, { coacheeMembershipId: AGENT })).toEqual([]);
      expect(await sessions().count(asB)).toBe(0);
      expect(await sessions().aggregate(asB, [{ $match: { coacheeMembershipId: AGENT } }])).toEqual([]);
      expect(await wired.coachingReadings.lastOneOnOnes(asB, [AGENT])).toEqual(new Map());
      // And office A, which holds it, does.
      expect(await sessions().findById(member(KPM_A), String(a._id))).not.toBeNull();
    });

    it('P11-T5 AC-9 office B cannot soft-delete office A’s session either', async () => {
      const a = await draft(member(KPM_A));
      expect(await sessions().softDeleteById(member(KPM_B), String(a._id), NOW)).toBeNull();
      expect((await sessions().findById(member(KPM_A), String(a._id)))?.deletedAt).toBeNull();
    });

    it('P11-T5 AC-9 a read with no office is refused, never answered from every office', async () => {
      const noOffice = new RequestContext('u9', 'none', null);
      await expect(sessions().find(noOffice)).rejects.toThrow(/coachingSessions/);
    });
  });

  describe('AC-9: nothing is hard-deleted', () => {
    it('P11-T5 AC-9 a deleted session stays in the collection, out of every read', async () => {
      const row = await draft(member(KPM_A));
      await sessions().softDeleteById(member(KPM_A), String(row._id), NOW);

      expect(await sessions().findById(member(KPM_A), String(row._id))).toBeNull();
      const stored = await mongoose.connection.db!.collection('coachingSessions').findOne({ _id: row._id });
      expect(stored).toMatchObject({ deletedAt: NOW });
    });
  });

  describe('ADR-0042’s correction shape, as erd.md writes it', () => {
    it('P11-T5 a new session is a draft at version 1: never finalized, nothing frozen, nothing corrected', async () => {
      const row = await draft(member(KPM_A));
      expect(row.toObject()).toMatchObject({
        kpmId: KPM_A, status: 'draft', date: null, lastWeek: null, lastWeekItems: [], actionItems: [], tips: [],
        leadActions: [], snapshot: null, finalizedAt: null, finalizedByMembershipId: null, version: 1,
        frozenAt: null, corrections: [], deletedAt: null, createdBy: AB, updatedBy: AB,
      });
    });

    it('P11-T5 the domain version is the record’s own, not Mongoose’s counter', async () => {
      const row = await draft(member(KPM_A));
      await sessions().updateById(member(KPM_A), String(row._id), { $set: { tips: [{ tipId: 't1', text: 'Listen first.' }] } });
      expect((await sessions().findById(member(KPM_A), String(row._id)))?.version).toBe(1);
      await sessions().updateById(member(KPM_A), String(row._id), { $inc: { version: 1 } });
      expect((await sessions().findById(member(KPM_A), String(row._id)))?.version).toBe(2);
    });

    it('P11-T5 keeps a whole finalized state in corrections[], with who reopened it, when and why', async () => {
      const row = await draft(member(KPM_A), {
        status: 'reopened', date: '2026-09-28', frozenAt: NOW, version: 4,
        corrections: [{
          version: 3, lastWeekItems: [], actionItems: [{ itemId: 'i1', text: 'Book two presentations', dueDate: '2026-10-01', carriedFromItemId: null }],
          tips: [{ tipId: 't1', text: 'Listen first.', carriedFromTipId: null }],
          leadActions: [{ leadId: 'l1', leadName: 'Pak Hendro Gunawan', dueDate: '2026-09-30', text: 'Follow up with Pak Hendro Gunawan' }],
          finalizedAt: NOW, finalizedByMembershipId: AB, at: NOW, byMembershipId: AB, reason: '  The date was wrong.  ',
        }],
      });
      expect(row.toObject().corrections[0]).toMatchObject({ version: 3, reason: 'The date was wrong.', byMembershipId: AB });
    });

    it('P11-T5 refuses a status the lifecycle does not have', async () => {
      await expect(draft(member(KPM_A), { status: 'archived' })).rejects.toThrow(/status/);
    });

    it('ADR-0073: no part of the record has a field for a leader note, at any depth it declares', () => {
      const paths = [
        CoachingSessionSchema, CoachingLastWeekSchema, CoachingLastWeekItemSchema, CoachingActionItemSchema,
        CoachingTipSchema, CoachingLeadActionSchema, CoachingSessionCorrectionSchema, CoachingSnapshotSchema,
      ].flatMap((schema) => Object.keys(schema.paths));
      expect(paths.filter((path) => /note/i.test(path))).toEqual([]);
    });
  });
});
