import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { AUTH_REFUSALS } from './auth.messages';

/** What the check reads of an account: whether, and the address it names in the refusal. */
export interface AddressHolder {
  email: string;
  emailVerifiedAt?: Date | null;
}

/** Whether the account's address has been proven: a verification link, a password reset, or an email change's link. */
export function hasVerifiedAddress(user: Pick<AddressHolder, 'emailVerifiedAt'>): boolean {
  return Boolean(user.emailVerifiedAt);
}

/**
 * **What still needs a proven address** (P19-T1 AC-4; UI-163, [ADR-0190](../../../../docs/04-adr/0190-a-person-signs-in-before-verifying-and-verifying-takes-a-click.md) §4).
 *
 * Signing in no longer waits for a verified address, so anything that must be sure of it checks `emailVerifiedAt`
 * itself. **Being made a KPM's Owner** is one: an office's mail — its requests, its subscription, a reset of the one
 * account that runs it — goes to that address, so it must be the person's. Refused `409 AUTH_EMAIL_NOT_VERIFIED`, a
 * state of the named account rather than a permission of the caller's, with `details.userId`; nothing is written.
 *
 * Called where an Owner is assigned or a KPM request approved (`tenants/`), after the account is found and before
 * anything changes. **An email change needs no call**: the account moves to the new address only when that address's
 * own link is opened, which marks it verified (ADR-0181).
 */
export function refuseUnverifiedAddress(user: AddressHolder & { _id?: unknown; id?: string }): void {
  if (hasVerifiedAddress(user)) return;
  throw new DomainException(
    ErrorCode.AUTH_EMAIL_NOT_VERIFIED,
    AUTH_REFUSALS.AUTH_EMAIL_NOT_VERIFIED.notVerifiedYet({ email: user.email }),
    HttpStatus.CONFLICT,
    { userId: String(user.id ?? user._id ?? '') },
  );
}
