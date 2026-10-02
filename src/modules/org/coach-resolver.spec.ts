import { RequestContext } from '@/common/context/request-context';
import { CoachResolver } from './coach-resolver';

/** A repository that fails the test the moment anything is asked of it. */
const untouchable = new Proxy({}, {
  get: (_target, name) => () => {
    throw new Error(`the membership repository was asked ${String(name)}()`);
  },
});

const as = (membershipId: string | null, impersonator: string | null = null) =>
  new RequestContext('u-1', 'none', membershipId === null ? null : {
    membershipId, kpmId: 'kpm-a', orgLevelCode: 'AAB', hierarchyRole: 'aab',
    status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 2,
  }, impersonator);

/**
 * **The rules that are decided before the hierarchy is read** (P11-T3).
 *
 * `coach-resolver.tenancy.spec.ts` proves the resolver on real hierarchy writes. These prove the
 * order: the subject of a note, a support session, somebody in no office and a leader naming
 * themselves are refused without a single read, so no later rule — and no state of the tree — can
 * let one of them through.
 */
describe('CoachResolver, before any read (P11-T3)', () => {
  const resolver = new CoachResolver(untouchable as never);

  it('P11-T3 AC-7 coachee_cannot_read_leader_notes: the subject is refused first, a subject who leads included', async () => {
    // An AAB with two people of their own, reading a note about themselves.
    await expect(resolver.readsLeaderNote(as('mem-aab'), {
      authorMembershipId: 'mem-ab', subjectMembershipId: 'mem-aab',
    })).resolves.toBe(false);
    // Before the author rule too: being its author does not make the subject a reader.
    await expect(resolver.readsLeaderNote(as('mem-aab'), {
      authorMembershipId: 'mem-aab', subjectMembershipId: 'mem-aab',
    })).resolves.toBe(false);
  });

  it('P11-T3 AC-7 support_session_cannot_read_leader_notes: refused without a read, the author’s own included', async () => {
    await expect(resolver.readsLeaderNote(as('mem-ab', 'u-root'), {
      authorMembershipId: 'mem-ab', subjectMembershipId: 'mem-agent',
    })).resolves.toBe(false);
  });

  it('P11-T3 AC-7: somebody in no office reads no note', async () => {
    await expect(resolver.readsLeaderNote(as(null), {
      authorMembershipId: 'mem-ab', subjectMembershipId: 'mem-agent',
    })).resolves.toBe(false);
  });

  it('P11-T3 AC-7: the author reads their own without the tree being asked', async () => {
    await expect(resolver.readsLeaderNote(as('mem-ab'), {
      authorMembershipId: 'mem-ab', subjectMembershipId: 'mem-agent',
    })).resolves.toBe(true);
  });

  it('P11-T3 AC-2 leader_cannot_coach_self: COACH(x, x) is false without a read', async () => {
    await expect(resolver.coaches(as('mem-ab'), 'mem-ab', 'mem-ab')).resolves.toBe(false);
  });
});
