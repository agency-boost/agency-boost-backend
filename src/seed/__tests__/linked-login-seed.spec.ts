import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AccountLink, AccountLinkSchema } from '@/modules/auth/account-link.schema';
import { AccountLinksService } from '@/modules/auth/account-links.service';
import { AuthToken, AuthTokenSchema } from '@/modules/auth/auth-token.schema';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { seedDemo } from '../demo';

const RUN_MS = 240_000;
const quiet = () => undefined;

/**
 * **P19.2-T1 AC-8 — the Owner's two logins, seeded linked** (UI-169 item 5; ADR-0199): `owner@kpm0417.test` and his own
 * Super Admin login, `wilson@agencyboost.test`, so the switcher's linked entries can be seen in a browser. Read back
 * through the service `GET /auth/me` reads `linkedLogin` from, as each login.
 */
describe('P19.2-T1 AC-8 the linked-login seed', () => {
  const clock = new FixedClock(new Date('2026-11-05T03:00:00Z'));
  let service: AccountLinksService;
  const users = () => mongoose.model(User.name, UserSchema);

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    const unused = {} as never;
    service = new AccountLinksService(
      mongoose.model(AccountLink.name, AccountLinkSchema) as never,
      users() as never,
      mongoose.model(AuthToken.name, AuthTokenSchema) as never,
      mongoose.model(Kpm.name, KpmSchema) as never,
      new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never),
      // The read uses none of these: it neither signs in, mails, audits nor limits anything.
      unused, unused, unused, unused, unused, unused, clock,
    );
  }, RUN_MS);
  afterAll(stopMongo);

  const idOf = async (email: string) => String((await users().findOne({ email }).lean().exec())!._id);

  it('P19.2-T1 AC-8 the Owner reads his Super Admin login, with its view', async () => {
    const owner = await idOf('owner@kpm0417.test');
    const linked = await service.linkedLoginFor(new RequestContext(owner, 'none', null));
    expect(linked).toMatchObject({
      userId: await idOf('wilson@agencyboost.test'), email: 'wilson@agencyboost.test', fullName: 'Wilson Tanoto',
      views: [{ kind: 'super_admin', officeName: null }],
    });
  });

  it('P19.2-T1 AC-8 the Super Admin login reads the Owner’s, with Akun saya and KPM Owner · BSD City Branch', async () => {
    const operator = await idOf('wilson@agencyboost.test');
    const linked = await service.linkedLoginFor(new RequestContext(operator, 'super_admin', null));
    expect(linked).toMatchObject({
      email: 'owner@kpm0417.test',
      views: [{ kind: 'self', officeName: null }, { kind: 'kpm_owner', officeName: 'BSD City Branch' }],
    });
  });

  it('P19.2-T1 AC-8 the demo Super Admin of the support walks is linked to nobody', async () => {
    const operator = await idOf('superadmin@agencyboost.test');
    expect(await service.linkedLoginFor(new RequestContext(operator, 'super_admin', null))).toBeNull();
  });

  it('P19.2-T1 AC-8 a second run links them once', async () => {
    await seedDemo({ clock, log: quiet });
    expect(await mongoose.connection.db!.collection('accountLinks').countDocuments({ deletedAt: null })).toBe(1);
    expect(await users().countDocuments({ email: 'wilson@agencyboost.test' })).toBe(1);
  }, RUN_MS);
});
