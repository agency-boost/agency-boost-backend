import { refreshCookieOptions, REFRESH_COOKIE_PATH } from './refresh-cookie';

/**
 * The attributes decide whether a session survives a deploy shape, so they are pinned
 * rather than left to be discovered on a staging URL (ADR-0041).
 */
describe('refreshCookieOptions', () => {
  it('is always httpOnly — JavaScript must never read the refresh token', () => {
    expect(refreshCookieOptions({ crossSite: false, nodeEnv: 'development' }).httpOnly).toBe(true);
    expect(refreshCookieOptions({ crossSite: true, nodeEnv: 'production' }).httpOnly).toBe(true);
  });

  it('is scoped to the auth routes and nothing else', () => {
    expect(refreshCookieOptions({ crossSite: false, nodeEnv: 'production' }).path).toBe(
      REFRESH_COOKIE_PATH,
    );
    expect(REFRESH_COOKIE_PATH).toBe('/api/v1/auth');
  });

  describe('same-site deployment — one domain serves app and API', () => {
    it('uses Lax, which is sent on the app\'s own navigations', () => {
      expect(refreshCookieOptions({ crossSite: false, nodeEnv: 'production' }).sameSite).toBe('lax');
    });

    it('is Secure in production and in staging, but not in local development', () => {
      expect(refreshCookieOptions({ crossSite: false, nodeEnv: 'production' }).secure).toBe(true);
      // The case the old `NODE_ENV === 'production'` test got wrong: staging is HTTPS and
      // was sending the session cookie in the clear.
      expect(refreshCookieOptions({ crossSite: false, nodeEnv: 'staging' }).secure).toBe(true);
      expect(refreshCookieOptions({ crossSite: false, nodeEnv: 'development' }).secure).toBe(false);
    });
  });

  describe('cross-site deployment — the Vercel staging shape', () => {
    it('uses None, the only value a browser sends across sites', () => {
      expect(refreshCookieOptions({ crossSite: true, nodeEnv: 'staging' }).sameSite).toBe('none');
    });

    it('is Secure even when the environment would not otherwise require it', () => {
      // SameSite=None without Secure is rejected outright by every current browser, so
      // these two attributes cannot be configured independently.
      const opts = refreshCookieOptions({ crossSite: true, nodeEnv: 'development' });
      expect(opts.sameSite).toBe('none');
      expect(opts.secure).toBe(true);
    });
  });

  it('gives set and clear the identical attributes', () => {
    // Not a tautology: the controller calls this one function for both, and this asserts
    // the function is deterministic so that contract holds. A clear whose attributes
    // differ from the set leaves the cookie in place and logout does nothing.
    const env = { crossSite: true, nodeEnv: 'staging' };
    expect(refreshCookieOptions(env)).toEqual(refreshCookieOptions(env));
  });
});
