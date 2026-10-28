import type { FilterQuery } from 'mongoose';
import { REQUIRED_PERMISSION } from '@/common/auth/auth.decorators';
import { RequestContext, type TenantMembership } from '@/common/context/request-context';
import type { Scope } from '@/modules/rbac/permissions';
import type { MembershipDocument } from './membership.schema';
import { OrgController } from './org.controller';
import { DIRECTORY_READ, scopeFilter, siblingsWithinReach, visibleTo, withinReach } from './reader-visibility';

const SELF = 'mem-self';
const SUBTREE = { $or: [{ _id: SELF }, { ancestorIds: SELF }] };

/** A member of office A reading as `SELF`: an active Agent unless told otherwise. */
const reader = (over: Partial<TenantMembership> = {}) =>
  new RequestContext('u-reader', 'none', {
    membershipId: SELF, kpmId: 'kpm-a', orgLevelCode: 'AGENT', hierarchyRole: 'agent', status: 'active',
    isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
  });
const ab = () => reader({ hierarchyRole: 'ab', orgLevelCode: 'AB', directCount: 2 });
const aab = () => reader({ hierarchyRole: 'aab', orgLevelCode: 'AAB', directCount: 1 });

/**
 * **Which memberships a reader may see** (P18.97-T8 L2, the Phase 18.97 exit permission review): the narrowing the
 * roster, one member's read, their reports, the *Rejoined* mark, the org tree and a removal's destination all go
 * through, held at 100% branch in `jest.config.ts`. Pure: what each reader is answered, as the filter the repository
 * is handed. `org.tenancy.spec.ts` proves the same filters on real hierarchy writes.
 */
describe('which memberships a reader may see (P18.97-T8 L2)', () => {
  describe('the directory’s permission', () => {
    it('P18.97-T8 L2 is the one GET /members, /members/:id and /members/:id/reports are gated on', () => {
      // A route regated on another permission would leave its narrowing resolving this one, silently.
      for (const route of ['list', 'read', 'reports'] as const) {
        expect(Reflect.getMetadata(REQUIRED_PERMISSION, OrgController.prototype[route])).toBe(DIRECTORY_READ);
      }
      expect(DIRECTORY_READ).toBe('member:read_profile');
    });
  });

  describe('visibleTo', () => {
    it('P18.97-T8 L2 gives the office to its Owner and to an Admin, whatever rung either stands on', () => {
      expect(visibleTo(reader({ isKpmOwner: true }), DIRECTORY_READ)).toEqual({});
      expect(visibleTo(reader({ isKpmAdmin: true }), DIRECTORY_READ)).toEqual({});
    });

    it('P18.97-T8 L2 gives the office to a Super Admin acting inside it, who holds no membership there', () => {
      expect(visibleTo(new RequestContext('u-sa', 'super_admin', null, null, 'kpm-a'), DIRECTORY_READ)).toEqual({});
    });

    it('P18.97-T8 L2 shows nobody to somebody with no membership: an impossible filter, never an absent one', () => {
      const unjoined = new RequestContext('u-new', 'none', null, null, 'kpm-a');
      expect(visibleTo(unjoined, DIRECTORY_READ)).toEqual({ _id: null });
    });

    it('P18.97-T8 L2 narrows an AB and an AAB to their subtree (rules 1 and 2) and an Agent to themselves', () => {
      expect(visibleTo(ab(), DIRECTORY_READ)).toEqual(SUBTREE);
      expect(visibleTo(aab(), DIRECTORY_READ)).toEqual(SUBTREE);
      expect(visibleTo(reader(), DIRECTORY_READ)).toEqual({ _id: SELF });
    });

    it('P18.97-T8 L2 fails closed for a membership the grant does not reach: pending, or removed', () => {
      expect(visibleTo(reader({ status: 'pending' }), DIRECTORY_READ)).toEqual({ _id: null });
      expect(visibleTo(reader({ hierarchyRole: 'ab', orgLevelCode: 'AB', status: 'removed' }), DIRECTORY_READ))
        .toEqual({ _id: null });
    });

    it('P18.97-T8 L2 resolves the permission it is handed, and the directory’s when it is handed none', () => {
      expect(visibleTo(reader())).toEqual({ _id: SELF });
      expect(visibleTo(ab())).toEqual(SUBTREE);
      // A removal's destination: an AB's `own-unit`, the subtree here. An Agent holds no grant on it at all.
      expect(visibleTo(ab(), 'member:remove_from_team')).toEqual(SUBTREE);
      expect(visibleTo(reader(), 'member:remove_from_team')).toEqual({ _id: null });
    });
  });

  describe('scopeFilter', () => {
    /** Every scope the vocabulary has: one added to `Scope` fails to compile here until it has a row. */
    const ROWS: Record<Scope, FilterQuery<MembershipDocument>> = {
      all: {},
      'own-kpm': {},
      'own-downline': SUBTREE,
      'own-unit': SUBTREE,
      own: { _id: SELF },
    };

    it.each(Object.entries(ROWS))('P18.97-T8 L2 reads %s as its filter', (scope, filter) => {
      expect(scopeFilter(scope as Scope, SELF)).toEqual(filter);
    });

    it('P18.97-T8 L2 reads no grant at all as nobody, never as everybody', () => {
      expect(scopeFilter(null, SELF)).toEqual({ _id: null });
    });
  });

  describe('withinReach', () => {
    it('P18.97-T8 L2 composes under $and, so an Agent’s own id narrows the id asked for rather than replacing it', () => {
      // Spread, `{ _id: 'mem-peer', ...{ _id: SELF } }` is `{ _id: SELF }`: the caller's own record, under a peer's id.
      expect(withinReach(reader(), { _id: 'mem-peer' })).toEqual({ $and: [{ _id: 'mem-peer' }, { _id: SELF }] });
      expect(withinReach(aab(), { _id: 'mem-peer' })).toEqual({ $and: [{ _id: 'mem-peer' }, SUBTREE] });
      expect(withinReach(reader({ isKpmOwner: true }), { _id: 'mem-peer' })).toEqual({ $and: [{ _id: 'mem-peer' }, {}] });
    });
  });

  describe('siblingsWithinReach', () => {
    it('P18.97-T8 L2 asks for each person once, narrowed as the page is', () => {
      expect(siblingsWithinReach(ab(), ['u-yanti', 'u-dewi', 'u-yanti'])).toEqual({
        $and: [{ userId: { $in: ['u-yanti', 'u-dewi'] } }, SUBTREE],
      });
    });

    it('P18.97-T8 L2 gives an Agent the one membership they hold, so no earlier one of theirs is read', () => {
      expect(siblingsWithinReach(reader(), ['u-reader'])).toEqual({
        $and: [{ userId: { $in: ['u-reader'] } }, { _id: SELF }],
      });
    });
  });
});
