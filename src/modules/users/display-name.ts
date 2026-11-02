/**
 * **A blank preferred name is no name** (the client's UI review, UI-005).
 *
 * `PATCH /auth/me` used to store whatever the profile sent, and the profile sent `''` for an empty field, so the
 * header's `preferredName ?? fullName` printed nothing: `??` falls back on `null`, not on an empty string. Every
 * read of a preferred name goes through `preferredNameOf`, and every place that shows a person's name through
 * `displayNameOf`, so a stray empty string — written before migration 0035, or by anything else — still reads as
 * the full name.
 */
export function preferredNameOf(preferredName: string | null | undefined): string | null {
  const trimmed = typeof preferredName === 'string' ? preferredName.trim() : '';
  return trimmed === '' ? null : trimmed;
}

/** What a person is called on a screen: their preferred name when they have one, else their full name. */
export function displayNameOf(
  user: { preferredName?: string | null; fullName?: string | null } | null | undefined,
): string | null {
  if (!user) return null;
  return preferredNameOf(user.preferredName) ?? (user.fullName?.trim() || null);
}
