import { AUDIT_LOG, isViewedAction } from './index';

/**
 * The audit log's pages (UI-132; the phase file's *Decisions* 4), pinned so a change fails here before it reaches a
 * reader. Documented once in `docs/00-product/metrics-and-definitions.md` §B.32.
 */
describe('the audit log’s pages (§B.32)', () => {
  it('P19.2-T2 AC-6 pins 50 groups a page and a 10-minute group window', () => {
    expect(AUDIT_LOG).toMatchObject({ PAGE_SIZE: 50, GROUP_WINDOW_MINUTES: 10 });
  });

  it('P19.23-T6 AC-1 pins Cari perubahan at 100 characters at most', () => {
    expect(AUDIT_LOG).toMatchObject({ PAGE_SIZE: 50, GROUP_WINDOW_MINUTES: 10, SEARCH_MAX_LENGTH: 100 });
  });

  it('P19.26-T3 AC-1 pins what *dilihat* is: the platform’s reads, and the three reads recorded inside an office', () => {
    expect(AUDIT_LOG).toEqual({
      PAGE_SIZE: 50, GROUP_WINDOW_MINUTES: 10, SEARCH_MAX_LENGTH: 100,
      VIEWED_ACTION_PREFIX: 'platform_read.', VIEWED_ACTIONS: ['activity_log.read_raw', 'leader_note.read', 'lead.viewed'],
    });
    expect(Object.isFrozen(AUDIT_LOG.VIEWED_ACTIONS)).toBe(true);
    expect(isViewedAction('platform_read.members')).toBe(true);
    expect(isViewedAction('platform_read.member_detail')).toBe(true);
    expect(isViewedAction('leader_note.read')).toBe(true);
    // A change, a note written, a support session opened: never *dilihat*.
    expect(isViewedAction('kpm.created')).toBe(false);
    expect(isViewedAction('leader_note.created')).toBe(false);
    expect(isViewedAction('impersonation.window_opened')).toBe(false);
  });

  it('P19.2-T2 AC-6 is frozen, so no caller can move either number at run time', () => {
    expect(Object.isFrozen(AUDIT_LOG)).toBe(true);
  });
});
