import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { readerIn } from '@/common/i18n/reader';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { AuthToken, AuthTokenSchema } from './auth-token.schema';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { Hs256TokenSigner } from './token-signer';

const NOW = new Date('2026-11-04T03:00:00Z');
const PASSWORD = 'correct horse battery';
const HOUR = 3_600_000;

interface Sent {
  userId?: string;
  templateId: string;
  payload: Record<string, unknown>;
  toAddress?: string;
  reader?: unknown;
}

/**
 * **Email, at the service** (P19-T1; UI-163, ADR-0190): verifying takes the press of a button and a used or
 * already-verified link reads as success (AC-2); a reset proves the mailbox (AC-3); an unverified address signs in, and
 * an email change still moves only by the new address's own link (AC-4); a reset or a change of password sends
 * *"Kata sandi Anda diubah"* (AC-5).
 *
 * No cross-tenant case: `users` and `authTokens` are global — one person, one account (invariant 2) — and nothing here
 * names an office.
 */
describe('P19-T1 email at the service (UI-163, ADR-0190)', () => {
  let service: AuthService;
  let users: mongoose.Model<User>;
  const clock = new FixedClock(NOW);
  const passwords = new PasswordService();
  let sent: Sent[];
  let failSends = false;

  beforeAll(async () => {
    await startMongo();
    users = mongoose.model(User.name, UserSchema) as never;
    service = new AuthService(
      users as never,
      mongoose.model(AuthToken.name, AuthTokenSchema) as never,
      mongoose.model(Company.name, CompanySchema) as never,
      passwords,
      new Hs256TokenSigner('a'.repeat(40), clock),
      clock,
      {
        send: async (r: Sent) => {
          if (failSends && r.templateId === 'auth.password_changed') throw new Error('database unavailable');
          sent.push(r);
        },
      } as never,
    );
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    clock.set(NOW);
    sent = [];
    failSends = false;
  });

  let seq = 0;
  /** An account as registration leaves it: `invited`, the address not verified, a verification link sent. */
  async function registered(extra: Record<string, unknown> = {}): Promise<{ userId: string; email: string; token: string }> {
    const email = `rina${++seq}@kpm.test`;
    const user = await users.create({
      email, passwordHash: await passwords.hash(PASSWORD), fullName: 'Rina Wijaya', status: 'invited',
      platformRole: 'none', ...extra,
    });
    const token = await service.issueVerification(user as never);
    return { userId: String(user._id), email, token };
  }

  const account = (userId: string) => users.findById(userId).lean().exec();
  const tokenOf = (templateId: string) => sent.filter((s) => s.templateId === templateId).at(-1)!.payload.token as string;

  async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number }> {
    try {
      await work;
    } catch (err) {
      const e = err as { code: string; getStatus: () => number };
      return { code: e.code, status: e.getStatus() };
    }
    throw new Error('expected a refusal');
  }

  describe('AC-2 a used or already-verified link is success', () => {
    it('P19-T1 AC-2 verifies on the press, and a second press of the same link answers success', async () => {
      const { userId, token } = await registered();
      await service.verifyEmail(token);
      expect(await account(userId)).toMatchObject({ emailVerifiedAt: NOW, status: 'active' });

      await expect(service.verifyEmail(token)).resolves.toBeUndefined();
    });

    it('P19-T1 AC-2 a link for an address already verified answers success, an older mail’s and an expired one too', async () => {
      const { userId, token: first } = await registered();
      // A second mail, from *Kirim ulang*; the first link is the one pressed.
      await service.resendVerification((await account(userId))!.email);
      const second = tokenOf('auth.email_verification');
      await service.verifyEmail(first);

      clock.set(new Date(NOW.getTime() + 25 * HOUR));
      await expect(service.verifyEmail(second)).resolves.toBeUndefined();
      await expect(service.verifyEmail(first)).resolves.toBeUndefined();
    });

    it('P19-T1 AC-2 two presses at once both answer success', async () => {
      const { userId, token } = await registered();
      await expect(Promise.all([service.verifyEmail(token), service.verifyEmail(token)])).resolves.toEqual([undefined, undefined]);
      expect((await account(userId))!.emailVerifiedAt).toEqual(NOW);
    });

    it('P19-T1 AC-2 a press that lands between the other press’s two writes answers success, and so does the other', async () => {
      const { userId, token } = await registered();
      const original = service.markVerified.bind(service);
      let second: Promise<void> | undefined;
      // The second press runs to its end inside the first's step: the interleaving that refused it while the link was
      // spent before the address was verified.
      const mark = jest.spyOn(service, 'markVerified').mockImplementationOnce(async (id: string) => {
        second = service.verifyEmail(token);
        await second;
        await original(id);
      });
      try {
        await expect(service.verifyEmail(token)).resolves.toBeUndefined();
        await expect(second).resolves.toBeUndefined();
      } finally {
        mark.mockRestore();
      }
      expect((await account(userId))!.emailVerifiedAt).toEqual(NOW);
    });

    it('P19-T1 AC-2 a token that names nobody, or whose account is gone, is 400 AUTH_TOKEN_INVALID', async () => {
      expect(await refusal(service.verifyEmail('never-issued'))).toEqual({ code: 'AUTH_TOKEN_INVALID', status: 400 });
      const { userId, token } = await registered();
      await users.updateOne({ _id: userId }, { $set: { deletedAt: NOW } }).exec();
      expect(await refusal(service.verifyEmail(token))).toEqual({ code: 'AUTH_TOKEN_INVALID', status: 400 });
    });

    it('P19-T1 AC-2 a link expired before the address was verified is 400 AUTH_TOKEN_INVALID, and verifies nothing', async () => {
      const { userId, token } = await registered();
      clock.set(new Date(NOW.getTime() + 24 * HOUR));
      expect(await refusal(service.verifyEmail(token))).toEqual({ code: 'AUTH_TOKEN_INVALID', status: 400 });
      expect((await account(userId))!.emailVerifiedAt).toBeNull();
    });

    it('P19-T1 AC-2 verifies a deactivated account’s address without bringing the account back', async () => {
      const { userId, token } = await registered({ status: 'deactivated' });
      await service.verifyEmail(token);
      expect(await account(userId)).toMatchObject({ emailVerifiedAt: NOW, status: 'deactivated' });
    });
  });

  describe('AC-3 a reset proves the mailbox', () => {
    it('P19-T1 AC-3 a completed reset sets emailVerifiedAt where it was unset, and makes an invited account active', async () => {
      const { userId, email } = await registered();
      await service.forgotPassword(email);
      await service.resetPassword(tokenOf('auth.password_reset'), 'a brand new password');

      expect(await account(userId)).toMatchObject({ emailVerifiedAt: NOW, status: 'active' });
      // The verification link still pressed afterwards reads as success.
      await expect(service.verifyEmail(tokenOf('auth.email_verification'))).resolves.toBeUndefined();
    });

    it('P19-T1 AC-3 keeps the moment an address was first verified', async () => {
      const { userId, email, token } = await registered();
      await service.verifyEmail(token);
      clock.set(new Date(NOW.getTime() + HOUR));
      await service.forgotPassword(email);
      await service.resetPassword(tokenOf('auth.password_reset'), 'a brand new password');
      expect((await account(userId))!.emailVerifiedAt).toEqual(NOW);
    });

    it('P19-T1 AC-3 a refused reset verifies nothing', async () => {
      const { userId } = await registered();
      expect(await refusal(service.resetPassword('never-issued', 'a brand new password')))
        .toEqual({ code: 'AUTH_RESET_TOKEN_INVALID', status: 400 });
      expect((await account(userId))!.emailVerifiedAt).toBeNull();
    });
  });

  describe('AC-4 sign in first; a change of address still needs a proven one', () => {
    it('P19-T1 AC-4 an unverified address signs in and stays unverified', async () => {
      const { userId, email } = await registered();
      await expect(service.login(email, PASSWORD)).resolves.toMatchObject({ accessToken: expect.any(String) });
      expect((await account(userId))!.emailVerifiedAt).toBeNull();
    });

    it('P19-T1 AC-4 an unverified account may ask to change its address; it moves only by the new address’s link, verified then', async () => {
      const { userId, email } = await registered();
      await service.requestEmailChange(userId, 'rina.baru@kpm.test', PASSWORD);
      expect(await account(userId)).toMatchObject({ email, emailVerifiedAt: null });

      clock.set(new Date(NOW.getTime() + 60_000));
      await service.confirmEmailChange(tokenOf('auth.email_change_verification'));
      expect(await account(userId)).toMatchObject({
        email: 'rina.baru@kpm.test', emailVerifiedAt: new Date(NOW.getTime() + 60_000),
      });
    });
  });

  describe('AC-5 Kata sandi Anda diubah', () => {
    it('P19-T1 AC-5 a reset sends auth.password_changed to the account, with no token, in the page’s language', async () => {
      const { userId, email } = await registered();
      await service.forgotPassword(email);
      sent = sent.filter((s) => s.templateId !== 'auth.password_changed');
      const ID = readerIn('id');
      await service.resetPassword(tokenOf('auth.password_reset'), 'a brand new password', ID);

      const told = sent.filter((s) => s.templateId === 'auth.password_changed');
      expect(told).toEqual([{ userId, templateId: 'auth.password_changed', payload: { fullName: 'Rina Wijaya' }, reader: ID }]);
      expect(told[0].toAddress).toBeUndefined();
    });

    it('P19-T1 AC-5 a change from the profile sends it too, and a refused change sends nothing', async () => {
      const { userId } = await registered();
      await refusal(service.changePassword(userId, 'not the password', 'a brand new password'));
      expect(sent.filter((s) => s.templateId === 'auth.password_changed')).toEqual([]);

      await service.changePassword(userId, PASSWORD, 'a brand new password');
      expect(sent.filter((s) => s.templateId === 'auth.password_changed')).toEqual([
        { userId, templateId: 'auth.password_changed', payload: { fullName: 'Rina Wijaya' }, reader: undefined },
      ]);
    });

    it('P19-T1 AC-5 a mail that cannot be sent never fails the change: the new password stands', async () => {
      const { userId, email } = await registered();
      failSends = true;
      await expect(service.changePassword(userId, PASSWORD, 'a brand new password')).resolves.toBeUndefined();
      await expect(service.login(email, 'a brand new password')).resolves.toMatchObject({ accessToken: expect.any(String) });
    });
  });
});
