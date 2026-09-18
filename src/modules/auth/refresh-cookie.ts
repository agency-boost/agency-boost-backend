import type { CookieOptions } from 'express';

/** Where the refresh cookie is scoped. Nothing outside the auth routes ever needs it. */
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

/**
 * The refresh cookie's attributes, derived in one place.
 *
 * Setting and clearing go through the same function so the two cannot diverge. A deletion
 * is matched on name, domain and path, so those must line up — and `Secure` and
 * `SameSite` have to be mirrored too, because a browser applies its own rules to the
 * expiring `Set-Cookie` as it would to any other: a `SameSite=None` cookie without
 * `Secure` is rejected outright, and the clear would silently leave a usable refresh
 * token in the browser after logout.
 */
export function refreshCookieOptions(env: {
  crossSite: boolean;
  nodeEnv: string;
}): CookieOptions {
  return {
    httpOnly: true,
    // Secure everywhere except plain local development. Keying this on
    // `NODE_ENV === 'production'` alone left staging — which is HTTPS — sending the
    // session cookie in the clear, and `SameSite=None` is ignored without it.
    secure: env.crossSite || env.nodeEnv !== 'development',
    // Lax is the safer default and correct when the app and the API share a site. It is
    // also never sent on a cross-site request, which is why the deployment states which
    // shape it is rather than this guessing (ADR-0041).
    sameSite: env.crossSite ? 'none' : 'lax',
    path: REFRESH_COOKIE_PATH,
  };
}
