import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import type { DomainException } from '@/common/errors/domain.exception';
import { english, indonesian } from '../../../test/i18n';
import {
  CoachingSessionService, shownActionItems, shownLastWeekItems, showsLeadsTo, type Standing,
} from './coaching-session.service';

const NOW = new Date('2026-09-14T03:00:00Z');
const AGUS = 'agus';
const INDAH = 'indah';
const ctx = new RequestContext('u-agus', 'none', {
  membershipId: AGUS, kpmId: 'kpm-a', orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: false, isKpmAdmin: false, directCount: 1,
} as never);

/** A stored session, as the repository hands one back. */
function stored(over: Record<string, unknown> = {}) {
  return {
    _id: 's1', kpmId: 'kpm-a', coachMembershipId: AGUS, coacheeMembershipId: INDAH, status: 'draft', date: null,
    lastWeek: null, lastWeekItems: [], actionItems: [], tips: [], leadActions: [], snapshot: null,
    finalizedAt: null, finalizedByMembershipId: null, version: 2, frozenAt: null, corrections: [],
    createdAt: NOW, ...over,
  };
}

/**
 * **The lifecycle's races, decided by a stub** (P11-T5 AC-1, AC-3). Over HTTP two requests racing land in
 * whichever order the database takes them; here each path is taken on purpose: a *Start* that loses the
 * insert, a pinned write that matches nothing and the reason it is given, and a stored lead item whose
 * lead name was never copied.
 */
describe('the coaching session’s races (P11-T5)', () => {
  const duplicate = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });

  function service(sessions: Record<string, jest.Mock>) {
    const coach = {
      coaches: jest.fn(async () => true),
      coachee: jest.fn(async () => ({ _id: INDAH, orgLevelCode: 'AGENT', userId: 'u-indah' })),
    };
    return new CoachingSessionService(
      sessions as never,
      coach as never,
      { byMembershipId: jest.fn(async () => new Map()) } as never,
      { for: jest.fn(async () => ({ today: '2026-09-14', month: '2026-09', timezone: 'Asia/Jakarta' })) } as never,
      { find: jest.fn(async () => []) } as never,
      { build: jest.fn() } as never,
      { record: jest.fn() } as never,
      { record: jest.fn() } as never,
      { send: jest.fn(), releaseHeld: jest.fn() } as never,
      new FixedClock(NOW),
    );
  }

  it('P11-T5 AC-1 a Start that loses the insert to another resumes the draft the other wrote', async () => {
    const svc = service({
      findOne: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(stored()),
      find: jest.fn(async () => []),
      create: jest.fn().mockRejectedValueOnce(duplicate),
    });
    await expect(svc.start(ctx, INDAH)).resolves.toMatchObject({ created: false, session: { sessionId: 's1' } });
  });

  it('P11-T5 AC-1 an insert refused for another reason, or a duplicate with no draft to resume, is not swallowed', async () => {
    const failing = service({
      findOne: jest.fn(async () => null), find: jest.fn(async () => []),
      create: jest.fn().mockRejectedValueOnce(new Error('disk full')),
    });
    await expect(failing.start(ctx, INDAH)).rejects.toThrow('disk full');

    const vanished = service({
      findOne: jest.fn(async () => null), find: jest.fn(async () => []),
      create: jest.fn().mockRejectedValueOnce(duplicate),
    });
    await expect(vanished.start(ctx, INDAH)).rejects.toBe(duplicate);
  });

  it('P11-T5 AC-3 a pinned write that matches nothing says why: finalized meanwhile, moved on, or gone', async () => {
    const body = { version: 2, lastWeekItems: [], actionItems: [], tips: [] };
    const after = (now: ReturnType<typeof stored> | null) => service({
      findById: jest.fn().mockResolvedValueOnce(stored()).mockResolvedValueOnce(now),
      updateIfAt: jest.fn(async () => null),
    });

    await expect(after(stored({ status: 'finalized' })).save(ctx, 's1', body))
      .rejects.toMatchObject({ code: 'COACHING_SESSION_FINALIZED' });
    await expect(after(stored({ version: 3 })).save(ctx, 's1', body))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT', details: { expectedVersion: 2, actualVersion: 3 } });
    await expect(after(null).save(ctx, 's1', body)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('P11-T5 AC-6 a reopen that loses the race to another is told the session is no longer the one it read', async () => {
    const finalized = stored({ status: 'finalized', date: '2026-09-14', frozenAt: NOW, finalizedAt: NOW, finalizedByMembershipId: AGUS });
    const svc = service({
      findById: jest.fn().mockResolvedValueOnce(finalized).mockResolvedValueOnce(stored({ status: 'reopened', version: 3 })),
      updateIfAt: jest.fn(async () => null),
    });
    await expect(svc.reopen(ctx, 's1', { version: 2, reason: 'A date was wrong.' }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('P11-T5 AC-4 a finalize that loses the race to a save is told the session moved on', async () => {
    const draft = stored({ actionItems: [{ itemId: 'a', text: 'Call', dueDate: '2026-09-20', carriedFromItemId: null }] });
    const svc = service({
      findById: jest.fn().mockResolvedValueOnce(draft).mockResolvedValueOnce(stored({ version: 3 })),
      updateIfAt: jest.fn(async () => null),
    });
    (svc as unknown as { snapshots: { build: jest.Mock } }).snapshots.build.mockResolvedValue({ takenAt: NOW, goal: null, ratios: null, activity: null });
    await expect(svc.finalize(ctx, 's1', 2)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('P11-T8 a lead item whose name was never copied reads with an empty name, never a made-up one', async () => {
    const svc = service({
      findById: jest.fn(async () => stored({
        lastWeekItems: [{ itemId: 'lead-L', text: 'Call', dueDate: null, leadId: 'L', leadName: null, done: false }],
      })),
    });
    const view = await svc.read(ctx, 's1');
    expect(view.lastWeekItems[0].lead).toEqual({ leadId: 'L', name: '' });
  });

  /*
   * **A 1:1 logged after it was held refuses in both languages** (P18.96-T4 AC-3; P18.98-T5 AC-2). The checklist's
   * route checks the date and the note before it asks, so these are the service's own backstop, read here directly.
   */
  it('P18.98-T5 AC-2 a 1:1 logged for a day to come, with a blank note, or by an Agent is refused in both languages', async () => {
    const svc = service({});
    const refusal = async (run: Promise<unknown>): Promise<DomainException> => {
      try {
        await run;
      } catch (err) {
        return err as DomainException;
      }
      throw new Error('expected a refusal');
    };

    const future = await refusal(svc.logOneOnOne(ctx, INDAH, { date: '2026-09-15', note: 'Talked it through.' }));
    expect([future.code, future.details, english(future.sentence), indonesian(future.sentence)]).toEqual([
      'VALIDATION_FAILED', { field: 'date' },
      'The day the 1:1 was held is a date, written YYYY-MM-DD, and no later than today.',
      'Tanggal 1:1 diadakan ditulis dengan format YYYY-MM-DD, dan tidak boleh setelah hari ini.',
    ]);

    const blank = await refusal(svc.logOneOnOne(ctx, INDAH, { date: '2026-09-10', note: '   ' }));
    expect([blank.code, blank.details, english(blank.sentence), indonesian(blank.sentence)]).toEqual([
      'VALIDATION_FAILED', { field: 'note' },
      'The note is 1 to 500 characters once trimmed.',
      'Catatan harus 1 sampai 500 karakter, tanpa spasi di awal dan akhir.',
    ]);

    const agent = new RequestContext('u-tari', 'none', {
      membershipId: 'tari', kpmId: 'kpm-a', orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
      isKpmOwner: false, isKpmAdmin: false, directCount: 1,
    } as never);
    const refused = await refusal(svc.logOneOnOne(agent, INDAH, { date: '2026-09-10', note: 'Talked it through.' }));
    expect([refused.code, refused.details, english(refused.sentence), indonesian(refused.sentence)]).toEqual([
      'PERM_DENIED', { permission: 'coaching_session:create' },
      'A 1:1 is logged by a leader who runs coaching sessions: an AB or an AAB.',
      '1:1 dicatat oleh leader yang menjalankan sesi coaching: AB atau AAB.',
    ]);
  });
});

/**
 * **Who reads a session's lead rows** (Phase 11 exit review, B1; roles §3.7): the rule `GET /summary?for=`
 * applies, decided once for the session read and the print alike.
 */
describe('B1 showsLeadsTo — lead rows only to a reader who may read the coachee’s leads', () => {
  const standing = (over: Partial<Standing> = {}): Standing => ({
    me: 'admin', live: false, isCoach: false, coachesNow: false, isCoachee: false, officeWide: true, ...over,
  });
  const reaching = (answer: string[] | null) => ({ reach: jest.fn(async () => answer) });

  it.each([
    ['its coach, while they coach or after', { isCoach: true }],
    ['a current coach', { coachesNow: true }],
    ['the coachee', { isCoachee: true }],
  ] as [string, Partial<Standing>][])('B1 %s reads them, and lead:read is never asked', async (_who, over) => {
    const coach = reaching([]);
    await expect(showsLeadsTo(coach as never, ctx, stored() as never, standing(over))).resolves.toBe(true);
    expect(coach.reach).not.toHaveBeenCalled();
  });

  it('B1 a reader admitted only office-wide reads them only where their own lead:read reaches the coachee', async () => {
    const nobody = reaching(['admin']);
    await expect(showsLeadsTo(nobody as never, ctx, stored() as never, standing())).resolves.toBe(false);
    expect(nobody.reach).toHaveBeenCalledWith(ctx, 'lead:read');
    await expect(showsLeadsTo(reaching(['admin', INDAH]) as never, ctx, stored() as never, standing())).resolves.toBe(true);
    // The whole office — the widest grant — reaches everybody.
    await expect(showsLeadsTo(reaching(null) as never, ctx, stored() as never, standing())).resolves.toBe(true);
  });

  it('B1 the typed items without leads leave out the ones carried from a lead; with them, every one', () => {
    const items = [{ itemId: 'a1', carriedFromItemId: null }, { itemId: 'a2', carriedFromItemId: 'lead-L' }, { itemId: 'a3', carriedFromItemId: 'x9' }];
    expect(shownActionItems(items, false).map((i) => i.itemId)).toEqual(['a1', 'a3']);
    expect(shownActionItems(items, true).map((i) => i.itemId)).toEqual(['a1', 'a2', 'a3']);
  });

  it('B1 last week’s items without leads are the typed ones; with them, every one', () => {
    const items = [{ itemId: 'typed', leadId: null }, { itemId: 'lead-L', leadId: 'L' }];
    expect(shownLastWeekItems(items, false).map((i) => i.itemId)).toEqual(['typed']);
    expect(shownLastWeekItems(items, true).map((i) => i.itemId)).toEqual(['typed', 'lead-L']);
  });
});
