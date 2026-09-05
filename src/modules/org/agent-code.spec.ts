import { formatAgentCode, parseAgentCode } from './agent-code';

describe('agent codes', () => {
  it('formats the office code and a padded sequence', () => {
    expect(formatAgentCode('0417', 1)).toBe('KPM0417-001');
    expect(formatAgentCode('0417', 42)).toBe('KPM0417-042');
    expect(formatAgentCode('0417', 999)).toBe('KPM0417-999');
  });

  it('widens past 999 rather than wrapping', () => {
    // Wrapping would re-issue a code already attached to a year of imported production.
    expect(formatAgentCode('0417', 1000)).toBe('KPM0417-1000');
    expect(formatAgentCode('0417', 12345)).toBe('KPM0417-12345');
  });

  it('does not sort correctly as a string past 999 — which is why the roster orders on the sequence', () => {
    // Pinned rather than assumed. A widened code sorts *before* the one it follows, so
    // ordering the directory on `agentCode` would silently reorder it and make the
    // cursor — a `$gt` on the sort key — skip the whole 1000s. `memberships.agentSeq`
    // exists for this, and org.tenancy.spec.ts proves the ordering it produces.
    expect(['KPM0417-999', 'KPM0417-1000'].sort()).toEqual(['KPM0417-1000', 'KPM0417-999']);
  });

  it('refuses a sequence that is not a positive integer', () => {
    expect(() => formatAgentCode('0417', 0)).toThrow(RangeError);
    expect(() => formatAgentCode('0417', -1)).toThrow(RangeError);
    expect(() => formatAgentCode('0417', 1.5)).toThrow(RangeError);
  });

  it('reads a code back apart', () => {
    expect(parseAgentCode('KPM0417-001')).toEqual({ kpmCode: '0417', seq: 1 });
    expect(parseAgentCode('KPM0417-1000')).toEqual({ kpmCode: '0417', seq: 1000 });
  });

  it('returns null for something that is not one, rather than guessing', () => {
    for (const bad of ['0417-001', 'KPM0417', 'KPM0417-', 'KPM0417-abc', '']) {
      expect(parseAgentCode(bad)).toBeNull();
    }
  });
});
