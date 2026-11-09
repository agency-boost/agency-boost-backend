/**
 * **Whether a request to sign in, refresh or sign out came from a page this API does not serve**
 * (P18.4-T1, ADR-0152).
 *
 * Every host lives on one registrable domain: `agencyboost.id`, `staging.agencyboost.id`,
 * `api.agencyboost.id` and `staging-api.agencyboost.id`. That is what lets the refresh cookie stay
 * `SameSite=Lax` (`auth-and-sessions.md`), and it also means a page on staging is *same-site* with
 * the production API. So the browser sends production's cookie with a request from staging, and keeps
 * the cookie a sign-in from staging sets. CORS keeps the answer from that page, but by then the server
 * has already rotated the token, ended the session, or signed the browser in.
 *
 * A browser always sends `Origin` on a cross-origin `POST`, a plain `<form>` included, so a foreign one
 * is refused. A request with no `Origin` is not a page's: a server-to-server call, curl, a test. It keeps
 * working.
 */
export function isForeignOrigin(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined) return false;
  return !allowed.includes(origin);
}

/**
 * **The API's own origin, as the browser that reached it spells it**: `https://api.agencyboost.id` for
 * Swagger UI at `/api/docs` on staging, which is a page this API serves and posts to itself.
 *
 * Built from the request rather than configured: the scheme from `req.protocol`, which reads Caddy's
 * `X-Forwarded-Proto` once `TRUST_PROXY` trusts it, and the host from the `Host` header, which Caddy
 * passes through unchanged. A page cannot forge either: the browser writes them. When the proxy is not
 * trusted the scheme reads `http` behind TLS, so the comparison fails and the page is refused. That is the
 * safe direction to fail in.
 *
 * Chosen over `Sec-Fetch-Site: same-origin`, which says the same thing more directly, because every
 * browser sends `Origin` on a `POST` and some still in use (Safari before 16.4) send no `Sec-Fetch-*`.
 */
export function ownOriginOf(req: { protocol: string; get(header: string): string | undefined }): string | null {
  const host = req.get('host');
  return host ? `${req.protocol}://${host}` : null;
}
