import { isReservedAddress, type MailProvider } from './mail-provider';
import type { SendRequest } from './notification.types';

/** Where a message is addressed. The service knows the recipient; the adapter needs an address. */
export abstract class RecipientAddressBook {
  abstract addressOf(userId: string): Promise<string | null>;
}

/**
 * **Where an email goes, or why it is not sent** — the one rule every sender applies, SMTP's and Resend's (moved here
 * from `smtp.adapter.ts` for P19.12-T1, ADR-0244):
 *
 * - **The address the account has at sending**, looked up then rather than carried in a payload, so a changed address
 *   is never sent the mail its old one would have had; or **`toAddress`**, the email change's link to the address being
 *   proved, which the account does not hold yet (ADR-0181).
 * - **No address is a throw**, which `NotificationService` records as `failed` with this reason: the audit trail wanted,
 *   where doing nothing would record a send that never happened.
 * - **A reserved address is not sent through a real provider** (ADR-0182 §5): the seed's `.test` people on staging. A
 *   provider would accept the mail and bounce it, spending the sender's reputation and its quota. Recorded `failed`
 *   with a reason that names the kind of address, not the address. A plain `smtp` relay is exempt: locally it is a
 *   mail catcher, where those are exactly the addresses wanted.
 */
export async function recipientAddress(
  to: SendRequest,
  addresses: RecipientAddressBook,
  provider: MailProvider,
): Promise<string> {
  const address = to.toAddress ?? (to.userId ? await addresses.addressOf(to.userId) : null);
  if (!address) throw new Error(`no email address for user ${to.userId ?? '(none)'}`);
  if (provider !== 'smtp' && isReservedAddress(address)) {
    throw new Error(
      `not sent: the address is in a reserved domain no mail server receives for (RFC 2606), and ${provider} would only bounce it`,
    );
  }
  return address;
}
