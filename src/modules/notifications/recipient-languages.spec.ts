import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { User, UserSchema } from '@/modules/users/user.schema';
import { UserLanguages } from './recipient-languages';

/**
 * **P18.10-T5 AC-5 — whose language an email is written in**: the recipient's saved `users.locale`, read by id, or
 * `null` for somebody who has chosen none, an account that has gone, or an id nobody holds.
 */
describe('P18.10-T5 AC-5 a recipient’s saved language', () => {
  let languages: UserLanguages;
  const users = () => mongoose.model(User.name);

  beforeAll(async () => {
    await startMongo();
    mongoose.model(User.name, UserSchema);
    languages = new UserLanguages(users() as never);
  });

  afterAll(stopMongo);
  beforeEach(clearCollections);

  const make = async (locale: string | null) => {
    const user = await users().collection.insertOne({
      email: `${Math.random()}@kpm.test`, passwordHash: 'x', fullName: 'X', status: 'active', platformRole: 'none',
      locale, deletedAt: null, createdAt: new Date(), updatedAt: new Date(),
    });
    return String(user.insertedId);
  };

  it('AC-5 reads the saved choice', async () => {
    expect(await languages.languageOf(await make('id'))).toBe('id');
    expect(await languages.languageOf(await make('en'))).toBe('en');
  });

  it('AC-5 reads none as none — the email then follows the request that caused it, or nobody’s choice', async () => {
    expect(await languages.languageOf(await make(null))).toBeNull();
    expect(await languages.languageOf(await make('fr'))).toBeNull();
    expect(await languages.languageOf(new mongoose.Types.ObjectId().toString())).toBeNull();
  });
});
