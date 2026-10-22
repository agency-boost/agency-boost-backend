/**
 * **The origins `CORS_ORIGINS` lists**, read one way for both of its readers: the CORS policy
 * `configureApp` sets, and the refresh-origin check on `/auth/refresh` and `/auth/logout`
 * (P18.7-T1). Two parsers would let a page be allowed by one and refused by the other.
 *
 * Comma-separated, each entry trimmed, empty entries dropped. Compared exactly, as the `cors`
 * package compares them: a browser's `Origin` has no trailing slash, so an entry written with one
 * matches nothing, for CORS and for the check alike.
 */
export function corsOriginsOf(raw: string | undefined | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
