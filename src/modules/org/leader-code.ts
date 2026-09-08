import { randomInt } from 'node:crypto';

/**
 * Alphabet without `0`, `O`, `1` and `I` — a code gets read down a phone line and written
 * on paper, and those four are the pairs people get wrong.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

/**
 * A leader's code: six characters, generated once with their membership and never again.
 *
 * **`randomInt`, not `Math.random`.** This is a credential — presenting it puts a stranger
 * into somebody's unit with nobody approving it — and `Math.random` is seeded predictably
 * enough that a sequence of codes could be guessed from one of them.
 *
 * The code space is 32⁶ ≈ 1.07 billion. That is thin for a credential, which is why
 * `POST /join/redeem` and `GET /join/invite` are rate-limited (P4-T13) and why redeeming
 * requires an account: a prober needs a session before they can even ask.
 */
export function generateLeaderCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/** The shareable form. The QR encodes exactly this string. */
export function leaderCodeUrl(appOrigin: string, code: string): string {
  return `${appOrigin}/join?code=${code}`;
}
