import { AUDIT_LOG } from './index';

/**
 * The audit log's pages (UI-132; the phase file's *Decisions* 4), pinned so a change fails here before it reaches a
 * reader. Documented once in `docs/00-product/metrics-and-definitions.md` §B.32.
 */
describe('the audit log’s pages (§B.32)', () => {
  it('P19.2-T2 AC-6 pins 50 groups a page and a 10-minute group window', () => {
    expect(AUDIT_LOG).toEqual({ PAGE_SIZE: 50, GROUP_WINDOW_MINUTES: 10 });
  });

  it('P19.2-T2 AC-6 is frozen, so no caller can move either number at run time', () => {
    expect(Object.isFrozen(AUDIT_LOG)).toBe(true);
  });
});
