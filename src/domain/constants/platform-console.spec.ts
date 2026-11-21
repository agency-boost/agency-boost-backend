import { ANNOUNCEMENT } from './index';

/** *Pengumuman*'s bounds (P19.23-T6 AC-4; ADR-0279), pinned so a change fails here before it reaches anybody's inbox. */
describe('the platform console’s announcements', () => {
  it('P19.23-T6 AC-4 pins the three audiences, a 500-character message, 100 chosen of each kind and a list of 20', () => {
    expect(ANNOUNCEMENT).toEqual({
      AUDIENCES: ['owners', 'members', 'selected'],
      MESSAGE_MAX_LENGTH: 500,
      SELECTED_MAX: 100,
      LIST_SIZE: 20,
    });
  });

  it('P19.23-T6 AC-4 is frozen, its audiences too', () => {
    expect(Object.isFrozen(ANNOUNCEMENT)).toBe(true);
    expect(Object.isFrozen(ANNOUNCEMENT.AUDIENCES)).toBe(true);
  });
});
