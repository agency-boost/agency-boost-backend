import { createHmac, timingSafeEqual } from 'node:crypto';
import { Clock } from '@/common/clock/clock.port';

/**
 * Access-token signing, behind a port.
 *
 * HS256 implemented on `node:crypto` rather than pulling a JWT library: the algorithm
 * is a HMAC over two base64url segments, the verification rules that matter here are
 * signature, `exp` and `alg`, and every JWT dependency we looked at carried its own
 * advisory history. Keeping it in-process also keeps the audit gate quiet.
 *
 * The token deliberately carries only the subject and session id. Roles are resolved
 * per request, so revoking a KPM Admin grant takes effect on the next request rather
 * than at the next token refresh (docs/02-specs/api/auth-and-sessions.md).
 */
export interface AccessTokenClaims {
  /** userId */
  sub: string;
  /** session (refresh-token family) id */
  sid: string;
  /** issued at, seconds since epoch */
  iat: number;
  /** expires at, seconds since epoch */
  exp: number;
}

export class TokenError extends Error {}

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export abstract class TokenSigner {
  abstract sign(claims: Omit<AccessTokenClaims, 'iat' | 'exp'>, ttlSeconds: number): string;
  abstract verify(token: string): AccessTokenClaims;
}

export class Hs256TokenSigner extends TokenSigner {
  constructor(
    private readonly secret: string,
    private readonly clock: Clock,
  ) {
    super();
    if (secret.length < 32) {
      throw new TokenError('Signing secret must be at least 32 characters.');
    }
  }

  private signature(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }

  sign(claims: Omit<AccessTokenClaims, 'iat' | 'exp'>, ttlSeconds: number): string {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    const body = `${encode(HEADER)}.${encode({ ...claims, iat: now, exp: now + ttlSeconds })}`;
    return `${body}.${this.signature(body)}`;
  }

  verify(token: string): AccessTokenClaims {
    const parts = token.split('.');
    if (parts.length !== 3) throw new TokenError('Malformed token.');

    const [rawHeader, rawPayload, signature] = parts;
    const expected = this.signature(`${rawHeader}.${rawPayload}`);

    // Constant-time, and length-checked first because timingSafeEqual throws on a
    // length mismatch — which would itself be an oracle.
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new TokenError('Bad signature.');
    }

    let header: { alg?: string };
    let claims: AccessTokenClaims;
    try {
      header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8'));
    } catch {
      throw new TokenError('Malformed token.');
    }

    // Pin the algorithm. Accepting whatever the token claims is how `alg: none` and
    // algorithm-confusion attacks work.
    if (header.alg !== HEADER.alg) throw new TokenError('Unexpected algorithm.');
    if (!claims.sub || !claims.sid) throw new TokenError('Missing claims.');

    if (claims.exp * 1000 <= this.clock.now().getTime()) {
      throw new TokenError('Token expired.');
    }
    return claims;
  }
}
