import { TEMPLATE } from './index';

/**
 * A template name's bounds (P13.2's exit review, N-notes): one declaration, which the DTOs read and the
 * frontend's `TEMPLATE_NAME_MAX` is pinned to by `frontend/src/lib/templates.spec.ts`.
 */
describe('template bounds', () => {
  it('pins a name at 1–80 characters', () => {
    expect(TEMPLATE).toEqual({ NAME_MIN_LENGTH: 1, NAME_MAX_LENGTH: 80 });
  });
});
