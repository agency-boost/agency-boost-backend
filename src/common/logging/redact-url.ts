/**
 * **A URL as a log line may carry it** (ADR-0131 §1; the Phase 18.1 code review): a meeting's shared link puts its
 * raw token in the path — `/leader-meetings/shared/{token}` — and the raw token is in the answer that makes the link
 * and nowhere else, a log line included. The request logger and the error filter both write the path through this.
 */
export const REDACTED = '[redacted]';

/**
 * The token's segment of a shared link's path, whatever follows it — a meeting's, and since P18.8-T3 an invite's
 * (`/v1/invites/{token}` and its `/accept`, ADR-0170 §3), which is a credential to join an office. Not
 * `/new-hires/invites/{inviteId}`, whose id is a row's, not a secret.
 */
const SHARED_LINK_TOKEN = /(\/leader-meetings\/shared\/|\/v\d+\/invites\/)[^/?#]+/g;

export function redactUrl(url: string | undefined): string | undefined {
  return url === undefined ? url : url.replace(SHARED_LINK_TOKEN, `$1${REDACTED}`);
}

/** A request as pino serialises it: the path rewritten, and the route's `token` parameter censored. */
export function serializeRequest<T extends { url?: string; params?: Record<string, unknown> }>(req: T): T {
  req.url = redactUrl(req.url);
  if (req.params && typeof req.params === 'object' && 'token' in req.params) req.params = { ...req.params, token: REDACTED };
  return req;
}
