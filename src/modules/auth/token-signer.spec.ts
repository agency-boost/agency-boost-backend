import { FixedClock } from '@/common/clock/clock.port';
import { Hs256TokenSigner, TokenError } from './token-signer';

const SECRET = 'a'.repeat(40);
const NOW = new Date('2026-09-05T02:00:00Z');

describe('Hs256TokenSigner', () => {
  const clock = new FixedClock(NOW);
  const signer = new Hs256TokenSigner(SECRET, clock);

  beforeEach(() => clock.set(NOW));

  it('round-trips the subject and session', () => {
    const token = signer.sign({ sub: 'u1', sid: 's1' }, 900);
    const claims = signer.verify(token);
    expect(claims.sub).toBe('u1');
    expect(claims.sid).toBe('s1');
    expect(claims.exp - claims.iat).toBe(900);
  });

  it('carries no roles — they resolve per request', () => {
    const token = signer.sign({ sub: 'u1', sid: 's1' }, 900);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sid', 'sub']);
  });

  it('rejects a tampered payload', () => {
    const token = signer.sign({ sub: 'u1', sid: 's1' }, 900);
    const [h, , s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'attacker', sid: 's1', iat: 1, exp: 9e9 }))
      .toString('base64url');
    expect(() => signer.verify(`${h}.${forged}.${s}`)).toThrow(TokenError);
  });

  it('rejects a token signed with a different secret', () => {
    const other = new Hs256TokenSigner('b'.repeat(40), clock);
    expect(() => signer.verify(other.sign({ sub: 'u1', sid: 's1' }, 900))).toThrow(TokenError);
  });

  it('rejects alg:none — the classic JWT bypass', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'attacker', sid: 's', iat: 1, exp: 9e9 }))
      .toString('base64url');
    expect(() => signer.verify(`${header}.${payload}.`)).toThrow(TokenError);
  });

  it('rejects an expired token', () => {
    const token = signer.sign({ sub: 'u1', sid: 's1' }, 900);
    clock.set(new Date(NOW.getTime() + 901_000));
    expect(() => signer.verify(token)).toThrow(/expired/i);
  });

  it('accepts a token one second before expiry', () => {
    const token = signer.sign({ sub: 'u1', sid: 's1' }, 900);
    clock.set(new Date(NOW.getTime() + 899_000));
    expect(signer.verify(token).sub).toBe('u1');
  });

  it.each([
    ['not a token', 'abc'],
    ['two segments', 'a.b'],
    ['empty', ''],
  ])('rejects a malformed token (%s)', (_label, token) => {
    expect(() => signer.verify(token)).toThrow(TokenError);
  });

  it('refuses a weak secret at construction', () => {
    expect(() => new Hs256TokenSigner('short', clock)).toThrow(/at least 32/);
  });

  it('rejects a token missing required claims', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ iat: 1, exp: 9e9 })).toString('base64url');
    const body = `${header}.${payload}`;
    const sig = new Hs256TokenSigner(SECRET, clock)['signature'](body);
    expect(() => signer.verify(`${body}.${sig}`)).toThrow(/Missing claims/);
  });
});
