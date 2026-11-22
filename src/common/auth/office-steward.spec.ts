import { Types } from 'mongoose';
import { RequestContext, type HierarchyRole } from '@/common/context/request-context';
import { ErrorCode } from '@/common/errors/error-codes';
import {
  canManageMember, canOpenMember, isOfficeSteward, officeStewardKind, requireManageableMember, requireOfficeSteward,
  requireOpenableMember, stewardsWholeOffice,
} from './office-steward';

/**
 * **Who looks after a KPM, and how far** (ADR-0268 §1–§3; P19.17 F2). A positive and a negative per role: the Super
 * Admin inside a KPM and outside one, the Owner, an Admin, a core leader in and out of their downline, an AB and an AAB
 * untagged, an Agent tagged or not, a pending core leader, a support session and a platform read.
 */
function member(opts: {
  role?: HierarchyRole; owner?: boolean; admin?: boolean; coreLeader?: boolean;
  status?: 'active' | 'pending' | 'removed'; impersonatedBy?: string;
} = {}): RequestContext {
  return new RequestContext(
    'u1', 'none',
    {
      membershipId: 'me', kpmId: 'kpm-a', orgLevelCode: (opts.role ?? 'agent').toUpperCase(),
      hierarchyRole: opts.role ?? 'agent', status: opts.status ?? 'active',
      isKpmOwner: opts.owner ?? false, isKpmAdmin: opts.admin ?? false, directCount: 3,
      isCoreLeader: opts.coreLeader ?? false,
    },
    opts.impersonatedBy ?? null, null, false, opts.impersonatedBy !== undefined,
  );
}

const SA_OUTSIDE = RequestContext.platform('sa-1');
const SA_IN_KPM = RequestContext.superAdminInKpm(SA_OUTSIDE, 'kpm-a');
const OWNER = member({ role: 'ab', owner: true });
const ADMIN = member({ role: 'aab', admin: true });
const CL = member({ role: 'ab', coreLeader: true });
const CL_AAB = member({ role: 'aab', coreLeader: true });

/** Somebody two levels below the core leader, somebody beside them, and the core leader's own row. */
const BELOW = { membershipId: 'm-below', ancestorIds: ['root', 'me', 'm-mid'] };
const BESIDE = { membershipId: 'm-beside', ancestorIds: ['root', 'other'] };
const SELF = { membershipId: 'me', ancestorIds: ['root'] };

describe('office-steward (ADR-0268)', () => {
  describe('officeStewardKind', () => {
    it.each([
      ['a Super Admin inside a KPM', SA_IN_KPM, 'super_admin'],
      ['the Owner', OWNER, 'kpm_owner'],
      ['an Admin', ADMIN, 'kpm_admin'],
      ['a core leader AB', CL, 'core_leader'],
      ['a core leader AAB', CL_AAB, 'core_leader'],
      ['an Owner who is also tagged, as the Owner', member({ role: 'ab', owner: true, coreLeader: true }), 'kpm_owner'],
    ] as const)('%s is %s', (_who, ctx, kind) => {
      expect(officeStewardKind(ctx)).toBe(kind);
      expect(isOfficeSteward(ctx)).toBe(true);
    });

    it.each([
      ['a Super Admin in no KPM', SA_OUTSIDE],
      ['a platform read, which only reads', RequestContext.platformRead(SA_OUTSIDE, 'kpm-a')],
      ['an AB untagged', member({ role: 'ab' })],
      ['an AAB untagged', member({ role: 'aab' })],
      ['an Agent', member({ role: 'agent' })],
      ['an Agent carrying the bare tag', member({ role: 'agent', coreLeader: true })],
      ['a pending core leader', member({ role: 'ab', coreLeader: true, status: 'pending' })],
      ['a removed Owner', member({ role: 'ab', owner: true, status: 'removed' })],
      ['somebody in no KPM', new RequestContext('u9', 'none', null)],
    ] as const)('%s is no steward', (_who, ctx) => {
      expect(officeStewardKind(ctx)).toBeNull();
      expect(isOfficeSteward(ctx)).toBe(false);
      expect(stewardsWholeOffice(ctx)).toBe(false);
    });

    it('a support session as the Owner is the Owner’s view — a steward that writes nothing (can() refuses it)', () => {
      const session = member({ role: 'ab', owner: true, impersonatedBy: 'sa-1' });
      expect(session.impersonationReadOnly).toBe(true);
      expect(officeStewardKind(session)).toBe('kpm_owner');
      expect(session.isSuperAdminInKpm).toBe(false);
    });
  });

  it('stewardsWholeOffice: every steward but a core leader', () => {
    for (const ctx of [SA_IN_KPM, OWNER, ADMIN]) expect(stewardsWholeOffice(ctx)).toBe(true);
    for (const ctx of [CL, CL_AAB]) expect(stewardsWholeOffice(ctx)).toBe(false);
  });

  describe('requireOfficeSteward', () => {
    it('answers the KPM to a steward', () => {
      for (const ctx of [SA_IN_KPM, OWNER, ADMIN, CL]) expect(requireOfficeSteward(ctx)).toBe('kpm-a');
    });

    it('refuses a request in no KPM 403 TENANT_NO_MEMBERSHIP — the Super Admin who has not entered one included', () => {
      for (const ctx of [SA_OUTSIDE, new RequestContext('u9', 'none', null)]) {
        expect(() => requireOfficeSteward(ctx)).toThrow(expect.objectContaining({ code: ErrorCode.TENANT_NO_MEMBERSHIP }));
      }
    });

    it('refuses a member who is no steward 404, naming the resource asked for, never confirming what is there', () => {
      expect(() => requireOfficeSteward(member({ role: 'ab' }))).toThrow(expect.objectContaining({ code: ErrorCode.NOT_FOUND }));
      expect(() => requireOfficeSteward(member({ role: 'agent' }), 'Group'))
        .toThrow(expect.objectContaining({ code: ErrorCode.NOT_FOUND, status: 404 }));
    });
  });

  describe('canOpenMember / canManageMember — a core leader’s downline', () => {
    it('the Super Admin inside, the Owner and an Admin open and change anybody in the KPM', () => {
      for (const ctx of [SA_IN_KPM, OWNER, ADMIN]) {
        for (const target of [BELOW, BESIDE, SELF]) {
          expect(canOpenMember(ctx, target)).toBe(true);
          expect(canManageMember(ctx, target)).toBe(true);
        }
      }
    });

    it('a core leader opens themselves and their downline; beside them, nobody', () => {
      expect(canOpenMember(CL, BELOW)).toBe(true);
      expect(canOpenMember(CL, SELF)).toBe(true);
      expect(canOpenMember(CL, BESIDE)).toBe(false);
      expect(canOpenMember(CL_AAB, BELOW)).toBe(true);
    });

    it('a core leader changes only who is strictly below them — never themselves', () => {
      expect(canManageMember(CL, BELOW)).toBe(true);
      expect(canManageMember(CL, SELF)).toBe(false);
      expect(canManageMember(CL, BESIDE)).toBe(false);
    });

    it('reads ObjectIds as their strings, and a row with no uplines as nobody’s downline', () => {
      const me = new Types.ObjectId();
      const cl = new RequestContext('u1', 'none', {
        membershipId: String(me), kpmId: 'kpm-a', orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
        isKpmOwner: false, isKpmAdmin: false, directCount: 1, isCoreLeader: true,
      });
      const below = { membershipId: new Types.ObjectId(), ancestorIds: [new Types.ObjectId(), me] };
      expect(canOpenMember(cl, below)).toBe(true);
      expect(canManageMember(cl, below)).toBe(true);
      expect(canOpenMember(cl, { membershipId: me })).toBe(true);
      expect(canOpenMember(cl, { membershipId: 'x', ancestorIds: null })).toBe(false);
      expect(canManageMember(cl, { membershipId: 'x' })).toBe(false);
    });

    it('nobody who is no steward opens or changes anybody through it', () => {
      for (const ctx of [SA_OUTSIDE, member({ role: 'ab' }), member({ role: 'agent' })]) {
        expect(canOpenMember(ctx, BELOW)).toBe(false);
        expect(canManageMember(ctx, BELOW)).toBe(false);
      }
    });

    it('the require forms answer 404 outside the reach, and nothing inside it', () => {
      expect(() => requireOpenableMember(CL, BELOW)).not.toThrow();
      expect(() => requireManageableMember(CL, BELOW)).not.toThrow();
      expect(() => requireOpenableMember(CL, BESIDE)).toThrow(expect.objectContaining({ code: ErrorCode.NOT_FOUND }));
      expect(() => requireManageableMember(CL, SELF, 'Transfer request'))
        .toThrow(expect.objectContaining({ code: ErrorCode.NOT_FOUND }));
    });
  });
});
