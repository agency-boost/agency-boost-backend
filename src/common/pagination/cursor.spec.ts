import { decodeCursor, encodeCursor, normaliseLimit, PAGE_LIMIT_MAX, toPage } from './cursor';

describe('cursor pagination', () => {
  it('defaults and caps the limit', () => {
    expect(normaliseLimit(undefined)).toBe(50);
    expect(normaliseLimit(10)).toBe(10);
    expect(normaliseLimit(10_000)).toBe(PAGE_LIMIT_MAX);
    expect(normaliseLimit(0)).toBe(1);
    expect(normaliseLimit(-5)).toBe(1);
    expect(normaliseLimit(NaN)).toBe(50);
  });

  it('round-trips a cursor', () => {
    expect(decodeCursor(encodeCursor('lead:2026-09-04:abc'))).toBe('lead:2026-09-04:abc');
  });

  it('uses the extra row to prove there is more, without returning it', () => {
    const rows = ['a', 'b', 'c'];
    const page = toPage(rows, 2, (r) => r);
    expect(page.items).toEqual(['a', 'b']);
    expect(page.page.hasMore).toBe(true);
    expect(page.page.nextCursor).toBe(encodeCursor('b'));
  });

  it('reports the end of a collection', () => {
    const page = toPage(['a'], 2, (r) => r);
    expect(page.page.hasMore).toBe(false);
    expect(page.page.nextCursor).toBeNull();
  });

  it('handles an empty result', () => {
    const page = toPage([], 50, (r: string) => r);
    expect(page.items).toEqual([]);
    expect(page.page.hasMore).toBe(false);
    expect(page.page.nextCursor).toBeNull();
  });
});
