/**
 * Cursor pagination, not offset. Rosters and activity logs change under the reader;
 * an offset silently skips or repeats rows when a row is inserted mid-scroll.
 */
export interface PageRequest {
  readonly cursor?: string;
  readonly limit: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: {
    readonly cursor: string | null;
    readonly nextCursor: string | null;
    readonly limit: number;
    readonly hasMore: boolean;
  };
}

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;

export function normaliseLimit(requested?: number): number {
  if (requested === undefined || Number.isNaN(requested)) return PAGE_LIMIT_DEFAULT;
  return Math.min(Math.max(1, Math.floor(requested)), PAGE_LIMIT_MAX);
}

export function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64url').toString('utf8');
}

/**
 * Build a page from `limit + 1` rows: the extra row proves there is more without a
 * second count query.
 */
export function toPage<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (row: T) => string,
  requestCursor?: string,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    page: {
      cursor: requestCursor ?? null,
      nextCursor: hasMore && last ? encodeCursor(cursorOf(last)) : null,
      limit,
      hasMore,
    },
  };
}
