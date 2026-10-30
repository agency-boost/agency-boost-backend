import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import type { RequestContext } from '@/common/context/request-context';
import type { AuditEntry } from '@/modules/audit/audit.service';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { AuthToken, AuthTokenSchema } from './auth-token.schema';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { Hs256TokenSigner } from './token-signer';

const NOW = new Date('2026-10-30T03:00:00Z');
const PASSWORD = 'correct horse battery';
const HOUR = 3_600_000;

interface Sent {
  userId?: string;
  templateId: string;
  payload: Record<string, unknown>;
  toAddress?: string;
}

/**
 * **The email change, at the service** (UI V1, 2026-10-30; UI-111; ADR-0181): `requestEmailChange` checks the password
 * again, normalises the address as registration does, refuses the address the account has (`400`) and one another
 * account has (`409`), and leaves the account as it is — one pending `email_change` row, a link to the new address and
 * a notice to the old one. `confirmEmailChange` spends the token once, moves `users.email`, marks it verified and
 * audits it; a replaced, spent or expired link is `verify-email`'s `AUTH_TOKEN_INVALID`.
 */
describe('UI-111 the email change (ADR-0181)', () => {
  let service: AuthService;
  let users: mongoose.Model<User>;
  let tokens: mongoose.Model<AuthToken>;
  const clock = new FixedClock(NOW);
  const passwords = new PasswordService();
  let sent: Sent[];
  let audited: { ctx: RequestContext; entry: AuditEntry }[];

  beforeAll(async () => {
    await startMongo();
    users = mongoose.model(User.name, UserSchema) as never;
    tokens = mongoose.model(AuthToken.name, AuthTokenSchema) as never;
    service = new AuthService(
      users as never,
      tokens as never,
      mongoose.model(Company.name, CompanySchema) as never,
      passwords,
      new Hs256TokenSigner('a'.repeat(40), clock),
      clock,
      { send: async (r: Sent) => { sent.push(r); } } as never,
      { record: async (ctx: RequestContext, entry: AuditEntry) => { audited.push({ ctx, entry }); } } as never,
    );
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    clock.set(NOW);
    sent = [];
    audited = [];
  });

  let seq = 0;
  /** A verified, signed-in-able account. */
  async function account(email = `agus${++seq}@kpm.test`, extra: Record<string, unknown> = {}): Promise<string> {
    const user = await users.create({
      email, passwordHash: await passwords.hash(PASSWORD), fullName: 'Agus Prasetyo', status: 'active',
      platformRole: 'none', emailVerifiedAt: new Date('2026-01-01T00:00:00Z'), ...extra,
    });
    return String(user._id);
  }

  const emailOf = async (userId: string) => (await users.findById(userId).lean().exec())?.email;
  const linkTo = (address: string) => sent.find((s) => s.templateId === 'auth.email_change_verification' && s.toAddress === address);
  const tokenSentTo = (address: string) => linkTo(address)!.payload.token as string;
  const pending = (userId: string) => tokens.find({ userId, kind: 'email_change' }).sort({ createdAt: 1 }).lean().exec();

  async function refusal(work: Promise<unknown>): Promise<{ code: string; status: number; message: string; details?: unknown }> {
    try {
      await work;
    } catch (err) {
      const e = err as { code: string; getStatus: () => number; message: string; details?: unknown };
      return { code: e.code, status: e.getStatus(), message: e.message, details: e.details };
    }
    throw new Error('expected a refusal');
  }

  describe('asking', () => {
    it('UI-111 normalises the address as registration does, changes nothing on the account, and keeps one pending row', async () => {
      const userId = await account('agus@kpm.test');

      await service.requestEmailChange(userId, '  Agus.Baru@KPM.test ', PASSWORD);

      expect(await emailOf(userId)).toBe('agus@kpm.test');
      const rows = await pending(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ newEmail: 'agus.baru@kpm.test', usedAt: null, revokedAt: null });
      // Hashed at rest, as every single-use token is: the raw value is only in the mail.
      expect(rows[0].tokenHash).toBe(passwords.hashToken(tokenSentTo('agus.baru@kpm.test')));
      expect(JSON.stringify(rows[0])).not.toContain(tokenSentTo('agus.baru@kpm.test'));
    });

    it('L10 records the request: user.email_change_requested, the address as it is and as asked, as the person in no office', async () => {
      const userId = await account('agus@kpm.test');

      await service.requestEmailChange(userId, '  Agus.Baru@KPM.test ', PASSWORD);

      expect(audited).toHaveLength(1);
      expect(audited[0].entry).toEqual({
        action: 'user.email_change_requested', targetCollection: 'users', targetId: userId,
        before: { email: 'agus@kpm.test' }, after: { email: 'agus.baru@kpm.test' },
      });
      expect(audited[0].ctx).toMatchObject({ userId, kpmId: null, impersonatorUserId: null });
    });

    it('L10 a refused request records nothing: a wrong password, the same address, another account’s', async () => {
      const userId = await account('agus@kpm.test');
      await account('dewi@kpm.test');

      await refusal(service.requestEmailChange(userId, 'baru@kpm.test', 'not the password'));
      await refusal(service.requestEmailChange(userId, 'agus@kpm.test', PASSWORD));
      await refusal(service.requestEmailChange(userId, 'dewi@kpm.test', PASSWORD));

      expect(audited).toEqual([]);
    });

    it('UI-111 sends the link to the new address and a notice with no link to the old one', async () => {
      const userId = await account('agus@kpm.test');

      await service.requestEmailChange(userId, 'agus.baru@kpm.test', PASSWORD);

      expect(sent).toHaveLength(2);
      expect(linkTo('agus.baru@kpm.test')).toMatchObject({ userId, payload: { fullName: 'Agus Prasetyo' } });
      const notice = sent.find((s) => s.templateId === 'auth.email_change_requested')!;
      // To the account's own address — no `toAddress` — naming the new one, and carrying no token.
      expect(notice).toMatchObject({ userId, payload: { fullName: 'Agus Prasetyo', newEmail: 'agus.baru@kpm.test' } });
      expect(notice.toAddress).toBeUndefined();
      expect(notice.payload).not.toHaveProperty('token');
    });

    it('UI-111 lasts as long as a verification link: valid a minute before, refused at the end', async () => {
      const userId = await account('agus@kpm.test');
      const verification = await tokens.create({
        userId, kind: 'email_verification', tokenHash: 'h-verify', expiresAt: new Date(NOW.getTime() + 24 * HOUR),
      });

      await service.requestEmailChange(userId, 'agus.baru@kpm.test', PASSWORD);
      const [row] = await pending(userId);

      // The verification link's lifetime, reused rather than restated (`VERIFICATION_TTL_HOURS`).
      expect(row.expiresAt.getTime() - NOW.getTime()).toBe(verification.expiresAt.getTime() - NOW.getTime());
      clock.set(new Date(NOW.getTime() + 24 * HOUR));
      expect(await refusal(service.confirmEmailChange(tokenSentTo('agus.baru@kpm.test'))))
        .toMatchObject({ code: 'AUTH_TOKEN_INVALID', status: 400 });
      expect(await emailOf(userId)).toBe('agus@kpm.test');

      // A minute before the end, the next request's link still works.
      clock.set(NOW);
      sent = [];
      await service.requestEmailChange(userId, 'agus.lagi@kpm.test', PASSWORD);
      clock.set(new Date(NOW.getTime() + 24 * HOUR - 60_000));
      expect(await service.confirmEmailChange(tokenSentTo('agus.lagi@kpm.test'))).toEqual({ email: 'agus.lagi@kpm.test' });
    });

    it('UI-111 an expired link changes nothing', async () => {
      const userId = await account('agus@kpm.test');
      await service.requestEmailChange(userId, 'agus.baru@kpm.test', PASSWORD);
      clock.set(new Date(NOW.getTime() + 25 * HOUR));
      expect(await refusal(service.confirmEmailChange(tokenSentTo('agus.baru@kpm.test'))))
        .toMatchObject({ code: 'AUTH_TOKEN_INVALID', status: 400 });
      expect(await emailOf(userId)).toBe('agus@kpm.test');
    });

    it('UI-111 refuses the address the account already has, in any case, 400 naming newEmail, and sends nothing', async () => {
      const userId = await account('agus@kpm.test');

      expect(await refusal(service.requestEmailChange(userId, ' AGUS@kpm.test', PASSWORD))).toEqual({
        code: 'VALIDATION_FAILED', status: 400, message: 'That is already your email address.', details: { field: 'newEmail' },
      });
      expect(await pending(userId)).toEqual([]);
      expect(sent).toEqual([]);
    });

    it.each([
      ['a live account', {}],
      ['a soft-deleted one — users.email is unique over every row', { deletedAt: new Date('2026-05-01T00:00:00Z') }],
    ])('UI-111 refuses an address that belongs to %s, 409 AUTH_EMAIL_TAKEN, and sends nothing', async (_, extra) => {
      const userId = await account('agus@kpm.test');
      await account('dewi@kpm.test', extra);

      expect(await refusal(service.requestEmailChange(userId, 'Dewi@kpm.test', PASSWORD))).toMatchObject({
        code: 'AUTH_EMAIL_TAKEN', status: 409, details: { field: 'newEmail' },
      });
      expect(await pending(userId)).toEqual([]);
      expect(sent).toEqual([]);
    });

    it('UI-111 refuses a wrong password as change-password does, 401, before anything else is looked at', async () => {
      const userId = await account('agus@kpm.test');
      await account('dewi@kpm.test');

      // Even for a taken address: the password is the first question, so the answer cannot be used to probe one.
      expect(await refusal(service.requestEmailChange(userId, 'dewi@kpm.test', 'not the password'))).toMatchObject({
        code: 'AUTH_INVALID_CREDENTIALS', status: 401, message: 'Your current password is not correct.',
      });
      expect(await pending(userId)).toEqual([]);
      expect(sent).toEqual([]);
    });

    it('UI-111 a newer request replaces the pending one: the first link stops working, the second works', async () => {
      const userId = await account('agus@kpm.test');
      await service.requestEmailChange(userId, 'first@kpm.test', PASSWORD);
      await service.requestEmailChange(userId, 'second@kpm.test', PASSWORD);

      const rows = await pending(userId);
      expect(rows.map((r) => [r.newEmail, r.revokedAt !== null])).toEqual([['first@kpm.test', true], ['second@kpm.test', false]]);
      expect(await refusal(service.confirmEmailChange(tokenSentTo('first@kpm.test'))))
        .toMatchObject({ code: 'AUTH_TOKEN_INVALID', status: 400 });

      expect(await service.confirmEmailChange(tokenSentTo('second@kpm.test'))).toEqual({ email: 'second@kpm.test' });
      expect(await emailOf(userId)).toBe('second@kpm.test');
    });
  });

  describe('opening the link', () => {
    it('UI-111 moves the account to the new address, marks it verified, audits before and after, and answers it', async () => {
      const userId = await account('agus@kpm.test');
      await service.requestEmailChange(userId, 'agus.baru@kpm.test', PASSWORD);
      clock.set(new Date(NOW.getTime() + HOUR));

      expect(await service.confirmEmailChange(tokenSentTo('agus.baru@kpm.test'))).toEqual({ email: 'agus.baru@kpm.test' });

      const user = await users.findById(userId).lean().exec();
      expect(user).toMatchObject({ email: 'agus.baru@kpm.test', emailVerifiedAt: new Date(NOW.getTime() + HOUR) });
      expect(audited.map((a) => a.entry.action)).toEqual(['user.email_change_requested', 'user.email_changed']);
      expect(audited[1].entry).toEqual({
        action: 'user.email_changed', targetCollection: 'users', targetId: userId,
        before: { email: 'agus@kpm.test' }, after: { email: 'agus.baru@kpm.test' },
      });
      // The account is global: written as the person, in no office.
      expect(audited[1].ctx).toMatchObject({ userId, kpmId: null, impersonatorUserId: null });
    });

    it('UI-111 leaves every session signed in', async () => {
      const userId = await account('agus@kpm.test');
      await tokens.create({
        userId, kind: 'refresh', tokenHash: 'h-refresh', familyId: 'fam-1', expiresAt: new Date(NOW.getTime() + 30 * 24 * HOUR),
      });
      await service.requestEmailChange(userId, 'agus.baru@kpm.test', PASSWORD);

      await service.confirmEmailChange(tokenSentTo('agus.baru@kpm.test'));

      expect(await tokens.findOne({ tokenHash: 'h-refresh' }).lean().exec()).toMatchObject({ revokedAt: null });
    });

    it('UI-111 is single use: the second opening is AUTH_TOKEN_INVALID and audits nothing more', async () => {
      const userId = await account('agus@kpm.test');
      await service.requestEmailChange(userId, 'agus.baru@kpm.test', PASSWORD);
      const token = tokenSentTo('agus.baru@kpm.test');
      await service.confirmEmailChange(token);

      expect(await refusal(service.confirmEmailChange(token))).toEqual({
        code: 'AUTH_TOKEN_INVALID', status: 400, message: 'That link is no longer valid. Request a new one.', details: undefined,
      });
      expect(audited.filter((a) => a.entry.action === 'user.email_changed')).toHaveLength(1);
    });

    it('UI-111 refuses an unknown token as verify-email does', async () => {
      expect(await refusal(service.confirmEmailChange('no-such-token'))).toMatchObject({ code: 'AUTH_TOKEN_INVALID', status: 400 });
    });

    it('UI-111 an address taken between the request and the link is 409, and the account keeps its address', async () => {
      const userId = await account('agus@kpm.test');
      await service.requestEmailChange(userId, 'agus.baru@kpm.test', PASSWORD);
      await account('agus.baru@kpm.test');

      expect(await refusal(service.confirmEmailChange(tokenSentTo('agus.baru@kpm.test')))).toEqual({
        code: 'AUTH_EMAIL_TAKEN', status: 409,
        message: 'That address now belongs to another account, so your email has not changed. Ask again with a different one.',
        details: { field: 'newEmail' },
      });
      expect(await emailOf(userId)).toBe('agus@kpm.test');
      expect(audited.map((a) => a.entry.action)).toEqual(['user.email_change_requested']);
    });

    it('UI-111 a verification link is not an email change link, and the other way round', async () => {
      const userId = await account('agus@kpm.test');
      await service.requestEmailChange(userId, 'agus.baru@kpm.test', PASSWORD);

      await expect(service.verifyEmail(tokenSentTo('agus.baru@kpm.test'))).rejects.toMatchObject({ code: 'AUTH_TOKEN_INVALID' });
      expect(await emailOf(userId)).toBe('agus@kpm.test');
    });
  });

  describe('what the old address is told to do (ADR-0181 §4)', () => {
    it('UI-111 changing the password cancels a pending change', async () => {
      const userId = await account('agus@kpm.test');
      await service.requestEmailChange(userId, 'thief@kpm.test', PASSWORD);

      await service.changePassword(userId, PASSWORD, 'a brand new password');

      expect(await refusal(service.confirmEmailChange(tokenSentTo('thief@kpm.test'))))
        .toMatchObject({ code: 'AUTH_TOKEN_INVALID' });
      expect(await emailOf(userId)).toBe('agus@kpm.test');
    });

    it('UI-111 resetting the password cancels it too', async () => {
      const userId = await account('agus@kpm.test');
      await service.requestEmailChange(userId, 'thief@kpm.test', PASSWORD);
      await service.forgotPassword('agus@kpm.test');
      const reset = sent.find((s) => s.templateId === 'auth.password_reset')!.payload.token as string;

      await service.resetPassword(reset, 'a brand new password');

      expect(await refusal(service.confirmEmailChange(tokenSentTo('thief@kpm.test'))))
        .toMatchObject({ code: 'AUTH_TOKEN_INVALID' });
    });
  });
});
