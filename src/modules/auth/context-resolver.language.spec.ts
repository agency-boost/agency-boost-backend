import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { DomainExceptionFilter } from '@/common/errors/error.filter';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { ContextResolver } from './context-resolver';

/**
 * **P18.98-T5 AC-1 — the request's reader, resolved with the context** (ADR-0179 §7): from the user the resolver
 * already reads — no extra read — the header first, then the saved `users.locale`, then nobody's choice; and never the
 * person's own choice in a support session. A refusal of the person read is written in their language.
 */
describe('P18.98-T5 AC-1 the reader ContextResolver resolves', () => {
  let resolver: ContextResolver;
  const users = () => mongoose.model(User.name);

  beforeAll(async () => {
    await startMongo();
    mongoose.model(User.name, UserSchema);
    mongoose.model(Kpm.name, KpmSchema);
    mongoose.model(Membership.name, MembershipSchema);
    resolver = new ContextResolver(
      users() as never, mongoose.model(Kpm.name) as never, mongoose.model(Membership.name) as never,
      new FixedClock(new Date('2026-10-29T03:00:00Z')),
    );
  });

  afterAll(stopMongo);
  beforeEach(clearCollections);

  const person = async (locale: string | null, status = 'active') => String((await users().collection.insertOne({
    email: `${Math.random()}@kpm.test`, passwordHash: 'x', fullName: 'Rina', status, platformRole: 'none', locale,
    deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
  })).insertedId);

  it('AC-1 reads the header over the saved choice, and the saved choice where no header names one', async () => {
    const saved = await person('id');
    // A person who has chosen reads figures in the language in force — here the one this screen sends.
    expect((await resolver.resolve(saved, null, false, false, [], 'en')).reader).toEqual({ language: 'en', figures: 'en' });
    expect((await resolver.resolve(saved, null, false, false, [], null)).reader).toEqual({ language: 'id', figures: 'id' });
  });

  it('AC-1 reads nobody’s choice for a person who has made none: English words, Indonesian figures, until live', async () => {
    expect((await resolver.resolve(await person(null))).reader).toEqual({ language: 'en', figures: 'id' });
    expect((await resolver.resolve(await person(null), null, false, false, [], 'id')).reader)
      .toEqual({ language: 'id', figures: 'id' });
  });

  it('AC-1 an English saved choice writes figures in English too: it is a choice', async () => {
    expect((await resolver.resolve(await person('en'))).reader).toEqual({ language: 'en', figures: 'en' });
  });

  it('AC-1 never reads the person’s own choice in a support session (ADR-0179 §2)', async () => {
    const saved = await person('id');
    expect((await resolver.resolve(saved, 'root', true)).reader).toEqual({ language: 'en', figures: 'id' });
    expect((await resolver.resolve(saved, 'root', true, false, [], 'id')).reader).toEqual({ language: 'id', figures: 'id' });
  });

  it('AC-1 writes a refusal of the person read in their saved language', async () => {
    const gone = await person('id', 'deactivated');
    const refusal = await resolver.resolve(gone).catch((err: unknown) => err);
    expect(refusal).toMatchObject({ code: 'AUTH_ACCOUNT_DEACTIVATED', message: 'This account has been deactivated.' });

    const json = jest.fn();
    new DomainExceptionFilter().catch(refusal, {
      switchToHttp: () => ({
        getResponse: () => ({ status: () => ({ json }) }),
        getRequest: () => ({ id: 'r', url: '/x', headers: {} }),
      }),
    } as never);
    expect(json.mock.calls[0][0].error.message).toBe('Akun ini telah dinonaktifkan.');
  });
});
