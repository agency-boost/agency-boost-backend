import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { checkFeedback, EventGuestService } from './event-guest.service';
import { checkRollCall, EventRollCallService, ROLL_CALL_MAX_ENTRIES } from './event-roll-call.service';
import { EventRsvpRepository } from './event.repository';

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    const response = (err as { getResponse: () => { code: string; details: { violations: string[] } } }).getResponse();
    return [response.code, response.details.violations];
  }
  throw new Error('expected a refusal');
};

/**
 * **The two bodies a member and a confirmer send**, read field by field (ADR-0030), and the answer's race — the paths
 * an HTTP spec reaches only by luck (P18.2-T5 AC-7, P18.2-T6 AC-3).
 */
describe('the answer and the roll call, read whole (P18.2-T5 AC-7, P18.2-T6 AC-3)', () => {
  describe('P18.2-T6 AC-3 checkFeedback', () => {
    it('P18.2-T6 AC-3 keeps a score and trims both texts, absent texts as empty', () => {
      expect(checkFeedback({ score: 0 })).toEqual({ score: 0, why: '', improve: '' });
      expect(checkFeedback({ score: 10, why: '  a  ', improve: '\nb\n' })).toEqual({ score: 10, why: 'a', improve: 'b' });
    });

    it('P18.2-T6 AC-3 collects every violation before refusing, a body that is not an object included', () => {
      expect(refusal(() => checkFeedback(null))).toEqual(['VALIDATION_FAILED', ['score is required.']]);
      expect(refusal(() => checkFeedback([1]))).toEqual([
        'VALIDATION_FAILED', ['The change must be an object of fields.', 'score is required.'],
      ]);
      expect(refusal(() => checkFeedback({ score: 12, why: 4, extra: true }))).toEqual(['VALIDATION_FAILED', [
        'property extra should not exist', 'why must be text.', 'score must be a whole number from 0 to 10.',
      ]]);
    });
  });

  describe('P18.2-T5 AC-7 checkRollCall', () => {
    const id = (n: number) => `66f00000000000000000${String(n).padStart(4, '0')}`;

    it('P18.2-T5 AC-7 reads true, false and null for each membership', () => {
      expect(checkRollCall({ entries: [{ membershipId: id(1), attended: true }, { membershipId: id(2), attended: false }, { membershipId: id(3), attended: null }] }))
        .toEqual([{ membershipId: id(1), attended: true }, { membershipId: id(2), attended: false }, { membershipId: id(3), attended: null }]);
    });

    it('P18.2-T5 AC-7 refuses a body that is not an object, a list that is not one, and each malformed row', () => {
      expect(refusal(() => checkRollCall('x'))).toEqual(['VALIDATION_FAILED', ['The change must be an object of fields.']]);
      expect(refusal(() => checkRollCall({ entries: {} }))).toEqual(['VALIDATION_FAILED', ['entries must be a list.']]);
      expect(refusal(() => checkRollCall({ entries: [7, { membershipId: '' , attended: true }, { membershipId: id(1), attended: 1 }] })))
        .toEqual(['VALIDATION_FAILED', [
          'entries[0] must be an object.', 'entries[1].membershipId is required.', 'entries[2].attended must be true, false or null.',
        ]]);
    });

    it('P18.2-T5 AC-7 refuses null, a list for a body, and a field beside entries', () => {
      expect(refusal(() => checkRollCall(null))).toEqual(['VALIDATION_FAILED', ['The change must be an object of fields.']]);
      expect(refusal(() => checkRollCall([]))).toEqual(['VALIDATION_FAILED', ['The change must be an object of fields.']]);
      expect(refusal(() => checkRollCall({ entries: [{ membershipId: id(1), attended: true }], note: 'x' })))
        .toEqual(['VALIDATION_FAILED', ['property note should not exist']]);
    });

    it('P18.2-T5 AC-7 holds 1 to 500 people, no membership twice', () => {
      const many = Array.from({ length: ROLL_CALL_MAX_ENTRIES + 1 }, (_, i) => ({ membershipId: id(i), attended: true }));
      expect(refusal(() => checkRollCall({ entries: many }))).toEqual(['VALIDATION_FAILED', ['entries must hold 1–500 people.']]);
      expect(checkRollCall({ entries: many.slice(0, ROLL_CALL_MAX_ENTRIES) })).toHaveLength(ROLL_CALL_MAX_ENTRIES);
    });
  });

  describe('P18.2-T6 AC-3 two submits racing', () => {
    const me = new RequestContext('u', 'none', {
      membershipId: 'mem-1', kpmId: 'kpm-1', orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
      isKpmOwner: false, isKpmAdmin: false, directCount: 0,
    });
    const event = {
      _id: 'evt-1', status: 'active', startsAt: new Date('2026-09-01T02:00:00Z'), endsAt: new Date('2026-09-01T04:00:00Z'),
      audience: { scope: 'all_agents', inviteeMembershipIds: [] },
    };
    /** The service over stubs: the event is visible and ended, the member RSVP'd, and `create` fails as given. */
    const service = (createError: unknown) => new EventGuestService(
      { findById: async () => event } as never,
      {} as never,
      { findOne: async () => ({ rsvpStatus: 'going', claimedAt: null, confirmedAttended: null }) } as never,
      { exists: async () => false, create: async () => { throw createError; } } as never,
      { read: async () => ({ holds: () => true }) } as never,
      { questionOf: () => ({}) } as never,
      {} as never,
      {} as never,
      { record: async () => undefined } as never,
      new FixedClock(new Date('2026-09-14T03:00:00Z')),
    );

    it('P18.2-T6 AC-3 the unique index refusing the second is the single-submit rule: 409, not a fault', async () => {
      await expect(service({ code: 11000 }).submitFeedback(me, 'evt-1', { score: 9 }))
        .rejects.toMatchObject({ response: { code: 'EVENT_FEEDBACK_ALREADY_SUBMITTED' } });
    });

    it('P18.2-T6 AC-3 any other failure is not dressed as one', async () => {
      await expect(service(new Error('disk full')).submitFeedback(me, 'evt-1', { score: 9 })).rejects.toThrow('disk full');
      await expect(service(null).submitFeedback(me, 'evt-1', { score: 9 })).rejects.toBeNull();
    });
  });

  describe('P18.2-T5 AC-5, AC-7 the member’s row, written once — the repository’s two writes', () => {
    const me = new RequestContext('u', 'none', {
      membershipId: 'mem-1', kpmId: 'kpm-1', orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
      isKpmOwner: false, isKpmAdmin: false, directCount: 0,
    });
    /**
     * A model answering each `findOneAndUpdate` in turn from `rows` (or failing with `fail` on the upsert), `exists`
     * with `there`, and `bulkWrite` with `bulk` or `fail` — recording what it was asked.
     */
    const repository = (answer: { rows?: unknown[]; there?: boolean; bulk?: unknown; fail?: unknown }) => {
      const asked: { filters: unknown[]; updates: unknown[]; options: unknown[]; ops?: unknown } = { filters: [], updates: [], options: [] };
      const rows = [...(answer.rows ?? [])];
      const model = {
        findOneAndUpdate: (filter: unknown, update: unknown, options: { upsert?: boolean }) => {
          asked.filters.push(filter);
          asked.updates.push(update);
          asked.options.push(options);
          return {
            exec: async () => {
              if (options.upsert && 'fail' in answer) throw answer.fail;
              return rows.shift() ?? null;
            },
          };
        },
        exists: async () => (answer.there ? { _id: 'row-x' } : null),
        bulkWrite: async (ops: unknown) => {
          asked.ops = ops;
          if ('fail' in answer) throw answer.fail;
          return answer.bulk;
        },
      };
      return { repo: new EventRsvpRepository(model as never), asked };
    };
    const write = (repo: EventRsvpRepository, upsert = true) =>
      repo.writeWhen(me, 'evt-1', 'mem-1', { claimedAt: null }, { claimedAt: new Date() }, upsert);

    it('P18.2-T5 AC-5 updates a row still as expected, answering it as it was; scoped to the office', async () => {
      const before = { _id: 'row-1', claimedAt: null };
      const { repo, asked } = repository({ rows: [before] });
      await expect(write(repo)).resolves.toEqual({ id: 'row-1', before });
      expect(asked.filters[0]).toMatchObject({ kpmId: 'kpm-1', deletedAt: null, eventId: 'evt-1', membershipId: 'mem-1', claimedAt: null });
      expect(asked.options).toEqual([{ new: false }]);
    });

    it('P18.2-T5 AC-5 creates a missing row, scoped on insert, answering no row before it', async () => {
      const { repo, asked } = repository({ rows: [null, { _id: 'row-2' }] });
      await expect(write(repo)).resolves.toEqual({ id: 'row-2', before: null });
      expect(asked.updates[1]).toMatchObject({ $setOnInsert: { kpmId: 'kpm-1', deletedAt: null, createdBy: 'mem-1' } });
    });

    it('P18.2-T5 AC-5 a row already changed answers null: no upsert, a row there in another state, or the index refusing a racing insert', async () => {
      await expect(write(repository({}).repo, false)).resolves.toBeNull();
      const there = repository({ there: true });
      await expect(write(there.repo)).resolves.toBeNull();
      expect(there.asked.filters).toHaveLength(1);
      await expect(write(repository({ fail: { code: 11000 } }).repo)).resolves.toBeNull();
    });

    it('P18.2-T5 AC-5 any other failure of the insert is not dressed as nothing done', async () => {
      await expect(write(repository({ fail: new Error('disk full') }).repo)).rejects.toThrow('disk full');
      await expect(write(repository({ fail: null }).repo)).rejects.toBeNull();
    });

    it('P18.2-T5 AC-7 the roll call’s rows in one unordered batch, each scoped; the rows it created by position', async () => {
      const { repo, asked } = repository({ bulk: { upsertedIds: { 1: 'new-row' } } });
      const result = await repo.setMany(me, 'evt-1', [
        { membershipId: 'a', set: { confirmedAttended: true } }, { membershipId: 'b', set: { confirmedAttended: false } },
      ]);
      expect(result).toEqual({ created: { 1: 'new-row' }, failed: [], error: null });
      expect((asked.ops as { updateOne: { filter: unknown; upsert: boolean } }[]).map((op) => [op.updateOne.filter, op.updateOne.upsert]))
        .toEqual([
          [{ kpmId: 'kpm-1', deletedAt: null, eventId: 'evt-1', membershipId: 'a' }, true],
          [{ kpmId: 'kpm-1', deletedAt: null, eventId: 'evt-1', membershipId: 'b' }, true],
        ]);
    });

    it('P18.2-T5 AC-7 a batch that fails part-way answers which rows failed and the error, never throwing', async () => {
      const error = { writeErrors: [{ index: 0 }], result: { upsertedIds: { 1: 'row-b' } } };
      const { repo } = repository({ fail: error });
      await expect(repo.setMany(me, 'evt-1', [{ membershipId: 'a', set: {} }, { membershipId: 'b', set: {} }]))
        .resolves.toEqual({ created: { 1: 'row-b' }, failed: [0], error });
      const single = { writeErrors: { index: 1 } };
      await expect(repository({ fail: single }).repo.setMany(me, 'evt-1', [{ membershipId: 'a', set: {} }]))
        .resolves.toEqual({ created: {}, failed: [1], error: single });
      const plain = new Error('network');
      await expect(repository({ fail: plain }).repo.setMany(me, 'evt-1', [{ membershipId: 'a', set: {} }]))
        .resolves.toEqual({ created: {}, failed: [], error: plain });
    });
  });

  describe('P18.2-T5 AC-7 a roll-call batch that fails part-way', () => {
    const owner = new RequestContext('u', 'none', {
      membershipId: 'owner', kpmId: 'kpm-1', orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
      isKpmOwner: true, isKpmAdmin: false, directCount: 0,
    });
    const row = (membershipId: string, rowId: string | null) => ({
      membershipId, orgLevelCode: 'AGENT', rowId, rsvp: null, claimed: true, confirmed: null,
      confirmedByMembershipId: null, confirmedAt: null, status: 'unconfirmed', gaveFeedback: false,
    });
    /** The service over stubs: three members, `a` with a row; the batch answers as given; audits recorded. */
    const service = (batch: { created: Record<number, string>; failed: number[]; error: unknown }) => {
      const audits: { targetId: unknown; targetMembershipId: unknown }[][] = [];
      const reading = {
        event: { id: 'evt-1', title: 'T', phase: 'past', ended: true, startsOn: '2026-09-01' },
        rows: [row('a', 'row-a'), row('b', null), row('c', null)], rate: 0,
        counts: { audience: 3, attended: 0, registered: 0, unconfirmed: 3, no_show: 0, not_registered: 0 },
      };
      const svc = new EventRollCallService(
        { attendance: async () => reading } as never,
        { setMany: async () => batch } as never,
        {} as never,
        { byMembershipId: async () => new Map() } as never,
        {} as never,
        { office: async () => ({ companyId: null }) } as never,
        { recordMany: async (_ctx: unknown, entries: never) => { audits.push(entries); } } as never,
        new FixedClock(new Date('2026-09-14T03:00:00Z')),
      );
      return { svc, audits };
    };
    const all = { entries: ['a', 'b', 'c'].map((membershipId) => ({ membershipId, attended: true })) };

    it('P18.2-T5 AC-7 audits exactly the rows written — the existing row, a created one, never a failed one — then fails', async () => {
      const error = new Error('one row refused');
      const { svc, audits } = service({ created: {}, failed: [1], error });
      await expect(svc.saveRollCall(owner, 'evt-1', all)).rejects.toBe(error);
      expect(audits[0].map((a) => [a.targetMembershipId, a.targetId])).toEqual([['a', 'row-a'], ['c', null]]);
    });

    it('P18.2-T5 AC-7 a created row is audited under the id the batch gave it', async () => {
      const { svc, audits } = service({ created: { 1: 'row-b', 2: 'row-c' }, failed: [], error: null });
      await expect(svc.saveRollCall(owner, 'evt-1', all)).resolves.toMatchObject({ eventId: 'evt-1' });
      expect(audits[0].map((a) => a.targetId)).toEqual(['row-a', 'row-b', 'row-c']);
    });
  });
});
