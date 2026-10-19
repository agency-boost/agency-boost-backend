/**
 * **The inbox's page sizes** (P12.1-T4, `functional/notifications.md`, the Data contract), held once
 * here and read by the query DTO, the service and the OpenAPI document (invariant §7).
 *
 * `/notifications` asks for the default and the bell's popover for fewer; nobody is answered more than
 * the maximum, so one read stays light however long an inbox grows.
 */
export const INBOX_PAGE = {
  /** A page when none is asked for: what `/notifications` shows. */
  DEFAULT_SIZE: 20,
  /** The most one read answers. */
  MAX_SIZE: 50,
} as const;
