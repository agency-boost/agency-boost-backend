import { INBOX_PAGE } from './index';

/**
 * **The inbox's page sizes, pinned** (`functional/notifications.md`, the Data contract). The frontend's
 * `contract.spec.ts` reads the default and the maximum back out of the OpenAPI document, so a drift here
 * fails there too.
 */
describe('inbox page sizes (functional/notifications.md, the Data contract)', () => {
  it('P12.1-T4 AC-1 pins twenty a page by default and fifty at most', () => {
    expect(INBOX_PAGE.DEFAULT_SIZE).toBe(20);
    expect(INBOX_PAGE.MAX_SIZE).toBe(50);
  });
});
