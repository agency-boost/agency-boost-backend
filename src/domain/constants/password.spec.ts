import { PASSWORD } from './index';

/**
 * A password's bounds (the product owner, 2026-11-01), pinned so a change fails here before it reaches a form.
 * Documented once in `docs/00-product/metrics-and-definitions.md` §B.30; the frontend's `PASSWORD_MIN_LENGTH` is read
 * against this file by `frontend/src/lib/password.spec.ts`.
 */
describe('the password bounds', () => {
  it('pins a password at 8 to 200 characters', () => {
    expect(PASSWORD).toEqual({ MIN_LENGTH: 8, MAX_LENGTH: 200 });
  });
});
