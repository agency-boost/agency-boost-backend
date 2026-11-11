import { RequestContext } from '@/common/context/request-context';
import {
  canChangeRoleOf, canHoldUnit, canPromoteToAbOf, DEFAULT_LADDER, readLadder, roleChoices, roleReaderOf, type RoleReader,
  type RoleTarget,
} from './role-rules';

const LEADER = 'mem-leader';
const reader = (over: Partial<RoleReader> = {}): RoleReader => ({
  membershipId: LEADER, office: false, role: 'ab', mayChangeRoles: true, ...over,
});
const target = (over: Partial<RoleTarget> = {}): RoleTarget => ({
  leaderId: LEADER, role: 'agent', orgLevelCode: 'AGENT', status: 'active', isOwner: false, ...over,
});

/**
 * **Who may put somebody on which rung** (P19.12-T4; ADR-0247 §1; the client's message of 11 November 2026, item 4).
 * The pure rule `RoleChangeService` enforces and every screen offers.
 */
describe('P19.12-T4 roleChoices — a leader sets roles up to their own rung', () => {
  it('P19.12-T4 AC-1 an AB leader: Agent, AAB and AB — AB under AB — for an Agent and for an AB alike', () => {
    expect(roleChoices(reader(), target(), DEFAULT_LADDER)).toEqual(['AGENT', 'AAB', 'AB']);
    // Maya, an AB: her own rung among the choices, so the screen checks it.
    expect(roleChoices(reader(), target({ role: 'ab', orgLevelCode: 'AB' }), DEFAULT_LADDER)).toEqual(['AGENT', 'AAB', 'AB']);
  });

  it('P19.12-T4 AC-1 an AAB leader: Agent and AAB; a report who stands above them is not theirs to change', () => {
    const aab = reader({ role: 'aab' });
    expect(roleChoices(aab, target(), DEFAULT_LADDER)).toEqual(['AGENT', 'AAB']);
    expect(roleChoices(aab, target({ role: 'ab', orgLevelCode: 'AB' }), DEFAULT_LADDER)).toEqual(['AB']);
  });

  it('P19.12-T4 AC-1 the Owner and an Admin: every rung, anywhere — never on the office’s owner', () => {
    const office = reader({ office: true, membershipId: 'mem-office', role: null });
    expect(roleChoices(office, target({ leaderId: 'somebody-else' }), DEFAULT_LADDER)).toEqual(['AGENT', 'AAB', 'AB']);
    expect(roleChoices(office, target({ role: 'ab', orgLevelCode: 'AB', isOwner: true }), DEFAULT_LADDER)).toEqual(['AB']);
  });

  it('P19.12-T4 AC-1 nobody else: not the direct leader, no permission, or somebody who has left — their own rung only', () => {
    expect(roleChoices(reader(), target({ leaderId: 'another-leader' }), DEFAULT_LADDER)).toEqual(['AGENT']);
    expect(roleChoices(reader({ mayChangeRoles: false }), target(), DEFAULT_LADDER)).toEqual(['AGENT']);
    expect(roleChoices(reader(), target({ status: 'removed' }), DEFAULT_LADDER)).toEqual(['AGENT']);
    expect(roleChoices(reader({ role: null }), target(), DEFAULT_LADDER)).toEqual(['AGENT']);
    expect(roleChoices(reader({ membershipId: null }), target({ leaderId: null }), DEFAULT_LADDER)).toEqual(['AGENT']);
  });

  it('P19.12-T4 AC-1 a company’s own ladder, by class: a custom senior rung is an AB leader’s to give, not an AAB leader’s', () => {
    const ladder = [
      { code: 'FA', role: 'agent' as const }, { code: 'UM', role: 'aab' as const }, { code: 'SM', role: 'ab' as const },
    ];
    expect(roleChoices(reader(), target({ orgLevelCode: 'FA' }), ladder)).toEqual(['FA', 'UM', 'SM']);
    expect(roleChoices(reader({ role: 'aab' }), target({ orgLevelCode: 'FA' }), ladder)).toEqual(['FA', 'UM']);
    // A rung since taken off the ladder is kept, first, so the screen can still check it.
    expect(roleChoices(reader(), target({ orgLevelCode: 'OLD' }), ladder)).toEqual(['OLD', 'FA', 'UM', 'SM']);
  });

  it('P19.12-T4 AC-1 the flags are read off the choices', () => {
    expect(canChangeRoleOf(['AGENT'])).toBe(false);
    expect(canChangeRoleOf(['AGENT', 'AAB'])).toBe(true);
    expect(canPromoteToAbOf(['AGENT', 'AAB'], DEFAULT_LADDER)).toBe(false);
    expect(canPromoteToAbOf(['agent', 'aab', 'ab'], DEFAULT_LADDER)).toBe(true);
    // An owner's single AB rung is nothing to promote to.
    expect(canPromoteToAbOf(['AB'], DEFAULT_LADDER)).toBe(false);
  });

  it('P19.12-T4 AC-1 the reader is read off the request: the office, their class, and the permission', () => {
    const member = (over: Record<string, unknown>) => new RequestContext('u-1', 'none', {
      membershipId: 'mem-1', kpmId: 'kpm-1', orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
      isKpmOwner: false, isKpmAdmin: false, directCount: 1, ...over,
    } as never);
    expect(roleReaderOf(member({}))).toEqual({ membershipId: 'mem-1', office: false, role: 'ab', mayChangeRoles: true });
    expect(roleReaderOf(member({ isKpmAdmin: true }))).toMatchObject({ office: true });
    expect(roleReaderOf(member({ hierarchyRole: 'agent' }))).toMatchObject({ role: 'agent', mayChangeRoles: false });
    expect(roleReaderOf(RequestContext.platform('root'))).toEqual({ membershipId: null, office: false, role: null, mayChangeRoles: false });
  });
});

describe('P19.12-T4 canHoldUnit and the ladder', () => {
  it('P19.12-T4 AC-2 an AB, an AAB, or an Agent who already leads somebody — and only while active', () => {
    expect(canHoldUnit({ status: 'active', role: 'ab' })).toBe(true);
    expect(canHoldUnit({ status: 'active', role: 'aab', directCounts: { total: 0 } })).toBe(true);
    expect(canHoldUnit({ status: 'active', role: 'agent', directCounts: { total: 0 } })).toBe(false);
    expect(canHoldUnit({ status: 'active', role: 'agent' })).toBe(false);
    expect(canHoldUnit({ status: 'active', role: 'agent', directCounts: { total: 2 } })).toBe(true);
    expect(canHoldUnit({ status: 'pending', role: 'ab' })).toBe(false);
  });

  it('P19.12-T4 AC-1 reads a company’s ladder junior first, each rung’s class beside it', async () => {
    const orgLevels = {
      activeCodesFor: async () => ['AGENT', 'AAB', 'AB', 'NEW'],
      classesByCode: async () => new Map([['AGENT', 'agent' as const], ['AAB', 'aab' as const], ['AB', 'ab' as const]]),
    };
    expect(await readLadder(orgLevels, 'company-1')).toEqual([
      { code: 'AGENT', role: 'agent' }, { code: 'AAB', role: 'aab' }, { code: 'AB', role: 'ab' }, { code: 'NEW', role: 'agent' },
    ]);
  });
});
