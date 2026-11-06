import {
  DEFAULT_ORG_LADDER, LEADER_CLASSES, LEADER_TIERS, LEGACY_TIER_BY_CODE, ROLE_CLASS_BY_TIER, RUNG_SHORT_CODE_MAX_LENGTH,
  isLeaderClass, roleClassOf, shortOfRung, tierOfRung,
} from './index';

/**
 * **A rung's leader tier decides who leads** (ADR-0156, P18.5-T1): the tiers, the class each gives, the classes the
 * leader limit counts, and the default ladder's tiers — pinned so a change to one fails here before it re-classes
 * anybody. Each is documented once in `docs/00-product/metrics-and-definitions.md`.
 */
describe('P18.5-T1 the leader tier (ADR-0156)', () => {
  it('AC-1 has two tiers, Senior and Associate; no tier is *Not a leader*', () => {
    expect([...LEADER_TIERS]).toEqual(['senior', 'associate']);
  });

  it('AC-3 derives the class from the tier: senior → ab, associate → aab, none → agent', () => {
    expect(ROLE_CLASS_BY_TIER).toEqual({ senior: 'ab', associate: 'aab' });
    expect(roleClassOf('senior')).toBe('ab');
    expect(roleClassOf('associate')).toBe('aab');
    expect(roleClassOf(null)).toBe('agent');
    expect(roleClassOf(undefined)).toBe('agent');
  });

  it('AC-1 gives the default ladder AB senior, AAB associate and Agent none', () => {
    expect(DEFAULT_ORG_LADDER.map((r) => [r.code, r.leaderTier])).toEqual([
      ['AGENT', null], ['AAB', 'associate'], ['AB', 'senior'],
    ]);
    // The class each default rung gives is the code lower-cased — the one-to-one v1 rested on, now derived.
    for (const rung of DEFAULT_ORG_LADDER) expect(roleClassOf(rung.leaderTier)).toBe(rung.code.toLowerCase());
  });

  it('AC-1 reads a rung written before the field as the migration writes it, and a stored null as stored', () => {
    expect(LEGACY_TIER_BY_CODE).toEqual({ AB: 'senior', AAB: 'associate' });
    expect(tierOfRung({ code: 'AB' })).toBe('senior');
    expect(tierOfRung({ code: 'aab' })).toBe('associate');
    expect(tierOfRung({ code: 'AGENT' })).toBeNull();
    expect(tierOfRung({ code: 'SM' })).toBeNull();
    // Stored wins, both ways: a custom rung marked senior leads, and an AB marked *Not a leader* does not.
    expect(tierOfRung({ code: 'SM', leaderTier: 'senior' })).toBe('senior');
    expect(tierOfRung({ code: 'AB', leaderTier: null })).toBeNull();
  });

  it('AC-5 counts the ab and aab classes as leaders, never the agent class, whatever the rung', () => {
    expect([...LEADER_CLASSES]).toEqual(['ab', 'aab']);
    expect(isLeaderClass('ab')).toBe(true);
    expect(isLeaderClass('aab')).toBe(true);
    expect(isLeaderClass('agent')).toBe(false);
    // A rung code is not a class: `AB` upper-cased is nobody's role.
    expect(isLeaderClass('AB')).toBe(false);
    expect(isLeaderClass(null)).toBe(false);
    expect(isLeaderClass(undefined)).toBe(false);
  });
});

describe('P18.7-T9 AC-1 what a rung is called in a sentence (ADR-0167 §10)', () => {
  it('P18.7-T9 AC-1 calls the default ladder AB, AAB and Agent: a short code as itself, a longer one by its label', () => {
    expect(RUNG_SHORT_CODE_MAX_LENGTH).toBe(4);
    expect(DEFAULT_ORG_LADDER.map(shortOfRung)).toEqual(['Agent', 'AAB', 'AB']);
    // A company's own: a code of four or fewer reads as one; five or more is shouted, so its label is used.
    expect(shortOfRung({ code: 'SM', label: 'Senior Manager' })).toBe('SM');
    expect(shortOfRung({ code: 'SRUM', label: 'Senior Unit Manager' })).toBe('SRUM');
    expect(shortOfRung({ code: 'RDIR', label: 'Regional Director' })).toBe('RDIR');
    expect(shortOfRung({ code: 'REGIONAL', label: 'Regional Director' })).toBe('Regional Director');
  });
});
