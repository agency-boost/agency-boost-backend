import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { User, UserSchema } from '@/modules/users/user.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { AuthToken, AuthTokenSchema } from './auth-token.schema';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { Hs256TokenSigner } from './token-signer';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';

const NOW = new Date('2026-09-05T02:00:00Z');
const PASSWORD = 'correct horse battery';

describe('AuthService', () => {
  let service: AuthService;
  let clock: FixedClock;
  let sent: { templateId: string; payload: Record<string, unknown> }[];

  beforeAll(async () => {
    await startMongo();
    const users = mongoose.model(User.name, UserSchema);
    const tokens = mongoose.model(AuthToken.name, AuthTokenSchema);
    clock = new FixedClock(NOW);
    sent = [];
    service = new AuthService(
      users as never,
      tokens as never,
      mongoose.model(Company.name, CompanySchema) as never,
      new PasswordService(),
      new Hs256TokenSigner('a'.repeat(40), clock),
      clock,
      { send: async (r: { templateId: string; payload: Record<string, unknown> }) => { sent.push(r); } } as never,
    );
  });
  afterAll(stopMongo);
  let companyId: string;
  let codeSeq = 0;

  beforeEach(async () => {
    await clearCollections();
    clock.set(NOW);
    sent = [];
    // Registration names the insurer that issued the code (ADR-0017), so one has to
    // exist. Recreated per test because `clearCollections` empties everything.
    const company = await mongoose
      .model(Company.name)
      .create({ name: 'Prudential', slug: 'prudential' });
    companyId = String(company._id);
    codeSeq = 0;
  });

  /** A registration payload with a fresh code, so two calls never collide by accident. */
  function reg(
    over: Partial<{
      email: string; password: string; fullName: string; agentCode: string; companyId: string;
    }> = {},
  ) {
    codeSeq += 1;
    return {
      email: 'rina@kpm.test',
      password: PASSWORD,
      fullName: 'Rina Wijaya',
      companyId,
      agentCode: `PRU-${1000 + codeSeq}`,
      ...over,
    };
  }

  async function verifiedUser(email = 'rina@kpm.test') {
    await service.register(reg({ email }));
    const token = sent.find((s) => s.templateId === 'auth.email_verification')!.payload.token as string;
    await service.verifyEmail(token);
    return email;
  }

  describe('registration', () => {
    it('lower-cases the email and sends a verification', async () => {
      await service.register(reg({ email: '  Rina@KPM.test ', fullName: 'Rina' }));
      const user = await mongoose.model(User.name).findOne({});
      expect(user?.get('email')).toBe('rina@kpm.test');
      expect(sent.map((s) => s.templateId)).toContain('auth.email_verification');
    });

    it('does not reveal that an address is already registered', async () => {
      await service.register(reg({ email: 'a@b.test', fullName: 'A' }));
      await expect(
        service.register(reg({ email: 'a@b.test', fullName: 'Impostor' })),
      ).resolves.toBeDefined();
      expect(await mongoose.model(User.name).countDocuments({})).toBe(1);
      // And the impostor's name never overwrote the real one.
      expect((await mongoose.model(User.name).findOne({}))?.get('fullName')).toBe('A');
    });

    /*
     * ADR-0017. The code is the insurer's, so registration is where a person declares
     * both — and it is the one place the pair can be checked before anything depends
     * on it.
     */
    it('AC-1: stores the insurer and the code, upper-cased and trimmed', async () => {
      await service.register(reg({ email: 'code@kpm.test', agentCode: '  pru-88213 ' }));
      const user = await mongoose.model(User.name).findOne({ email: 'code@kpm.test' });
      expect(user?.get('companyId')).toBe(companyId);
      expect(user?.get('agentCode')).toBe('PRU-88213');
    });

    it('AC-1: refuses a code already registered at that insurer, and says so', async () => {
      await service.register(reg({ email: 'first@kpm.test', agentCode: 'PRU-500' }));
      /*
       * **Said out loud, where a taken address is not.** Confirming an email is an
       * enumeration oracle and the real owner is emailed instead. A person holding a card
       * with this number on it cannot proceed either way, and staying quiet would send
       * them off waiting for a verification email that is never coming.
       */
      await expect(
        service.register(reg({ email: 'second@kpm.test', agentCode: 'pru-500' })),
      ).rejects.toMatchObject({ code: 'AGENT_CODE_TAKEN' });
      expect(await mongoose.model(User.name).countDocuments({})).toBe(1);
    });

    it('AC-1: accepts the same code at a different insurer', async () => {
      const other = await mongoose
        .model(Company.name)
        .create({ name: 'Allianz', slug: `allianz-${Math.random()}` });
      await service.register(reg({ email: 'a@kpm.test', agentCode: 'X-1' }));
      await expect(
        service.register(reg({ email: 'b@kpm.test', agentCode: 'X-1', companyId: String(other._id) })),
      ).resolves.toBeDefined();
      expect(await mongoose.model(User.name).countDocuments({})).toBe(2);
    });

    it('refuses an insurer that does not exist, and a malformed id, alike', async () => {
      await expect(
        service.register(reg({ email: 'ghost@kpm.test', companyId: String(new mongoose.Types.ObjectId()) })),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // From a public form, so a mistyped id is "not here" rather than a 500.
      await expect(
        service.register(reg({ email: 'bad@kpm.test', companyId: 'not-an-objectid' })),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects a password below the minimum length', async () => {
      await expect(
        service.register(reg({ email: 'x@y.test', password: 'short', fullName: 'X' })),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('login', () => {
    it('issues a pair for correct credentials', async () => {
      const email = await verifiedUser();
      const pair = await service.login(email, PASSWORD);
      expect(pair.accessToken).toMatch(/^ey/);
      expect(pair.refreshToken).toHaveLength(43);
      expect(pair.expiresIn).toBe(900);
    });

    it('gives the same error for a wrong password and an unknown account', async () => {
      const email = await verifiedUser();
      const wrong = await service.login(email, 'not the password').catch((e) => e);
      const missing = await service.login('nobody@kpm.test', PASSWORD).catch((e) => e);
      expect(wrong.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(missing.code).toBe('AUTH_INVALID_CREDENTIALS');
      expect(wrong.getResponse().message).toBe(missing.getResponse().message);
    });

    it('refuses an unverified account distinctly', async () => {
      await service.register(reg({ email: 'new@kpm.test', fullName: 'New' }));
      await expect(service.login('new@kpm.test', PASSWORD)).rejects.toMatchObject({
        code: 'AUTH_EMAIL_NOT_VERIFIED',
      });
    });

    it('refuses a deactivated account distinctly', async () => {
      const email = await verifiedUser();
      await mongoose.model(User.name).updateOne({ email }, { $set: { status: 'deactivated' } });
      await expect(service.login(email, PASSWORD)).rejects.toMatchObject({
        code: 'AUTH_ACCOUNT_DEACTIVATED',
      });
    });

    it('never accepts an agent code as an identifier', async () => {
      await verifiedUser();
      await expect(service.login('KPM0417-001', PASSWORD)).rejects.toMatchObject({
        code: 'AUTH_INVALID_CREDENTIALS',
      });
    });

    it('records the last login from the injected clock', async () => {
      const email = await verifiedUser();
      clock.set(new Date('2026-09-06T09:00:00Z'));
      await service.login(email, PASSWORD);
      const user = await mongoose.model(User.name).findOne({ email });
      expect(user?.get('lastLoginAt')).toEqual(new Date('2026-09-06T09:00:00Z'));
    });
  });

  describe('refresh rotation', () => {
    it('rotates: the old token stops working and a new one is issued', async () => {
      const email = await verifiedUser();
      const first = await service.login(email, PASSWORD);
      const second = await service.refresh(first.refreshToken);
      expect(second.refreshToken).not.toBe(first.refreshToken);
    });

    it('revokes the entire family when a rotated token is reused', async () => {
      const email = await verifiedUser();
      const first = await service.login(email, PASSWORD);
      const second = await service.refresh(first.refreshToken);

      // The attacker replays the token the legitimate client already spent.
      await expect(service.refresh(first.refreshToken)).rejects.toMatchObject({
        code: 'AUTH_TOKEN_INVALID',
      });

      // And the legitimate client's current token dies too — we cannot tell which
      // party is which, so both must sign in again.
      await expect(service.refresh(second.refreshToken)).rejects.toMatchObject({
        code: 'AUTH_TOKEN_INVALID',
      });
    });

    it('does not touch a different login session', async () => {
      const email = await verifiedUser();
      const phone = await service.login(email, PASSWORD);
      const laptop = await service.login(email, PASSWORD);

      await service.refresh(phone.refreshToken);
      await service.refresh(phone.refreshToken).catch(() => undefined); // trips the family

      // The laptop is a separate family and is unaffected.
      await expect(service.refresh(laptop.refreshToken)).resolves.toBeDefined();
    });

    it('rejects an expired refresh token', async () => {
      const email = await verifiedUser();
      const pair = await service.login(email, PASSWORD);
      clock.set(new Date(NOW.getTime() + 31 * 86_400_000));
      await expect(service.refresh(pair.refreshToken)).rejects.toMatchObject({
        code: 'AUTH_TOKEN_EXPIRED',
      });
    });

    it('rejects an unknown token', async () => {
      await expect(service.refresh('never-issued')).rejects.toMatchObject({
        code: 'AUTH_TOKEN_INVALID',
      });
    });
  });

  describe('logout', () => {
    it('kills the session it was given', async () => {
      const email = await verifiedUser();
      const pair = await service.login(email, PASSWORD);
      await service.logout(pair.refreshToken);
      await expect(service.refresh(pair.refreshToken)).rejects.toMatchObject({
        code: 'AUTH_TOKEN_INVALID',
      });
    });

    it('logout-all kills every session', async () => {
      const email = await verifiedUser();
      const a = await service.login(email, PASSWORD);
      const b = await service.login(email, PASSWORD);
      const user = await mongoose.model(User.name).findOne({ email });

      await service.logoutAll(String(user!._id));

      for (const pair of [a, b]) {
        await expect(service.refresh(pair.refreshToken)).rejects.toBeDefined();
      }
    });

    it('tolerates an unknown token without throwing', async () => {
      await expect(service.logout('never-issued')).resolves.toBeUndefined();
    });
  });

  describe('password reset', () => {
    it('resolves for an unknown address, revealing nothing', async () => {
      await expect(service.forgotPassword('nobody@kpm.test')).resolves.toBeUndefined();
      expect(sent).toHaveLength(0);
    });

    it('emails a token for a known address', async () => {
      const email = await verifiedUser();
      sent = [];
      await service.forgotPassword(email);
      expect(sent[0].templateId).toBe('auth.password_reset');
    });

    it('resets the password and revokes every existing session', async () => {
      const email = await verifiedUser();
      const old = await service.login(email, PASSWORD);
      sent = [];
      await service.forgotPassword(email);
      const token = sent[0].payload.token as string;

      await service.resetPassword(token, 'a brand new password');

      await expect(service.login(email, 'a brand new password')).resolves.toBeDefined();
      await expect(service.refresh(old.refreshToken)).rejects.toBeDefined();
    });

    it('refuses a reset token twice', async () => {
      const email = await verifiedUser();
      sent = [];
      await service.forgotPassword(email);
      const token = sent[0].payload.token as string;
      await service.resetPassword(token, 'a brand new password');
      await expect(service.resetPassword(token, 'another password here')).rejects.toMatchObject({
        code: 'AUTH_RESET_TOKEN_INVALID',
      });
    });

    it('refuses an expired reset token', async () => {
      const email = await verifiedUser();
      sent = [];
      await service.forgotPassword(email);
      const token = sent[0].payload.token as string;
      clock.set(new Date(NOW.getTime() + 31 * 60_000));
      await expect(service.resetPassword(token, 'a brand new password')).rejects.toMatchObject({
        code: 'AUTH_RESET_TOKEN_INVALID',
      });
    });
  });

  describe('change password', () => {
    it('requires the current password and revokes other sessions', async () => {
      const email = await verifiedUser();
      const user = await mongoose.model(User.name).findOne({ email });
      const old = await service.login(email, PASSWORD);

      await expect(
        service.changePassword(String(user!._id), 'wrong', 'a brand new password'),
      ).rejects.toMatchObject({ code: 'AUTH_INVALID_CREDENTIALS' });

      await service.changePassword(String(user!._id), PASSWORD, 'a brand new password');
      await expect(service.refresh(old.refreshToken)).rejects.toBeDefined();
    });
  });

  /*
   * P3.6-T4. The roster import generates a password, an admin reads it and emails it on,
   * so the person holding the session has demonstrated control of a mailbox and nothing
   * more. `AuthGuard` refuses everything but three routes until it is replaced; these are
   * the two things that replace it.
   */
  describe('a password somebody else chose', () => {
    async function imported(email = 'imported@kpm.test') {
      await service.register(reg({ email }));
      await mongoose.model(User.name).updateOne(
        { email },
        { $set: { mustChangePassword: true, emailVerifiedAt: NOW, status: 'active' } },
      );
      return email;
    }

    it('is cleared by changing it, and by nothing short of that', async () => {
      const email = await imported();
      const user = await mongoose.model(User.name).findOne({ email });
      expect(user?.get('mustChangePassword')).toBe(true);

      // Signing in does not clear it: that is the whole point.
      await service.login(email, PASSWORD);
      expect(
        (await mongoose.model(User.name).findOne({ email }))?.get('mustChangePassword'),
      ).toBe(true);

      await service.changePassword(String(user!._id), PASSWORD, 'a different long password');
      expect(
        (await mongoose.model(User.name).findOne({ email }))?.get('mustChangePassword'),
      ).toBe(false);
    });

    it('refuses replacing it with itself', async () => {
      const email = await imported();
      const user = await mongoose.model(User.name).findOne({ email });
      await expect(
        service.changePassword(String(user!._id), PASSWORD, PASSWORD),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      // And the gate is still down, so the credential the admin holds still opens nothing.
      expect(
        (await mongoose.model(User.name).findOne({ email }))?.get('mustChangePassword'),
      ).toBe(true);
    });

    it('is cleared by a reset, so somebody who never got the email is not locked out', async () => {
      const email = await imported();
      await service.forgotPassword(email);
      const token = sent.find((x) => x.templateId === 'auth.password_reset')!.payload.token as string;
      await service.resetPassword(token, 'a different long password');

      expect(
        (await mongoose.model(User.name).findOne({ email }))?.get('mustChangePassword'),
      ).toBe(false);
    });
  });

  describe('email verification', () => {
    it('activates the account and is single-use', async () => {
      await service.register(reg({ email: 'v@kpm.test', fullName: 'V' }));
      const token = sent[0].payload.token as string;
      await service.verifyEmail(token);

      const user = await mongoose.model(User.name).findOne({ email: 'v@kpm.test' });
      expect(user?.get('status')).toBe('active');
      expect(user?.get('emailVerifiedAt')).toEqual(NOW);

      await expect(service.verifyEmail(token)).rejects.toBeDefined();
    });
  });
});
