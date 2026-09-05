/**
 * Agent codes.
 *
 * `KPM0417-001` — the office's code, then a sequence allocated from that office's
 * counter. It is a **business key**: the monthly production import joins on it
 * (`docs/01-flows/kpm-owner-data-upload.md`), so it is issued by the server, immutable
 * once assigned, and never used as a foreign key. `membershipId` is the foreign key.
 */
export const AGENT_CODE_PREFIX = 'KPM';
export const AGENT_CODE_PAD = 3;

/**
 * Padded to three digits, and **widening rather than wrapping** past 999. An office
 * with a thousand agents is unusual but not impossible, and `-1000` sorts after `-999`
 * lexically as well as numerically, so the roster stays in order.
 */
export function formatAgentCode(kpmCode: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) {
    throw new RangeError(`Agent code sequence must be a positive integer, received ${seq}`);
  }
  return `${AGENT_CODE_PREFIX}${kpmCode}-${String(seq).padStart(AGENT_CODE_PAD, '0')}`;
}

/** Reads the sequence back out. Used by tests and by the import's diagnostics. */
export function parseAgentCode(code: string): { kpmCode: string; seq: number } | null {
  const m = /^KPM([A-Za-z0-9-]+)-(\d+)$/.exec(code);
  if (!m) return null;
  return { kpmCode: m[1], seq: Number(m[2]) };
}
