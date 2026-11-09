import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { Membership, MembershipSchema } from './membership.schema';
import { MembershipRepository } from './membership.repository';
import { MemberNames } from './member-names.service';
import type { AvatarLinks } from '@/modules/users/avatar.service';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';

const KPM = '66f0000000000000000000a1';
const OTHER = '66f0000000000000000000b1';
const SARI = '66f000000000000000000102';
const RINA = '66f000000000000000000103';
const ELSEWHERE = '66f000000000000000000104';

const ctx = (kpmId = KPM) => new RequestContext('u1', 'none', {
  membershipId: SARI, kpmId, orgLevelCode: 'AAB', hierarchyRole: 'aab',
  status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 1,
} as never);

/**
 * Naming the person behind a membership (P7-T7).
 *
 * Invariant §2 makes this two hops — the membership is the foreign key, the name lives on the
 * global user — and the hop that matters for safety is the first: it is **scoped**, so the user
 * read that follows can only reach people this office already holds a membership for.
 */
describe('a person’s name, from their membership', () => {
  let names: MemberNames;
  let memberships: MembershipRepository;

  beforeAll(async () => {
    await startMongo();
    memberships = new MembershipRepository(
      mongoose.model(Membership.name, MembershipSchema) as never,
    );
    names = new MemberNames(memberships, mongoose.model(User.name, UserSchema) as never);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    // Built before the rows go in, so the fixture meets the constraint every time rather than when it wins a race.
    await mongoose.model(Membership.name).syncIndexes();
    await mongoose.connection.db!.collection('memberships').insertMany([
      member(SARI, KPM, '01'), member(RINA, KPM, '02'), member(ELSEWHERE, OTHER, '03'),
    ] as never);
    await mongoose.connection.db!.collection('users').insertMany([
      user('01', 'Ibu Sari'), user('02', 'Rina Wijaya'), user('03', 'Lina Marlina'),
    ] as never);
  });

  /*
   * **A membership as the schema has it** — `leaderCode` included. It is required and unique among
   * live memberships, and these rows went in without one: three nulls under a unique index. They
   * passed only while the index was slow to build, and failed once the test database stopped
   * rebuilding itself for every suite (2026-09-29).
   */
  const member = (id: string, kpmId: string, userSuffix: string) => ({
    _id: new mongoose.Types.ObjectId(id),
    kpmId,
    userId: `66f0000000000000000002${userSuffix}`,
    leaderCode: `LEAD${userSuffix}`,
    orgLevelCode: 'AGENT', hierarchyRole: 'agent', leaderId: null, ancestorIds: [],
    status: 'active', deletedAt: null,
  });

  const user = (suffix: string, fullName: string) => ({
    _id: new mongoose.Types.ObjectId(`66f0000000000000000002${suffix}`),
    email: `${suffix}@kpm.test`, fullName, deletedAt: null,
  });

  it('names the memberships this office holds', async () => {
    const found = await names.byMembershipId(ctx(), [SARI, RINA]);

    expect(found.get(SARI)).toBe('Ibu Sari');
    expect(found.get(RINA)).toBe('Rina Wijaya');
  });

  it('asks each collection once, however many rows name the same person', async () => {
    const found = await names.byMembershipId(ctx(), [SARI, SARI, SARI, RINA]);

    expect([...found.keys()].sort()).toEqual([SARI, RINA].sort());
  });

  it('reads nothing at all for an empty list', async () => {
    expect((await names.byMembershipId(ctx(), [])).size).toBe(0);
    expect((await names.byMembershipId(ctx(), ['', ''])).size).toBe(0);
  });

  it('cannot name somebody in another office', async () => {
    // The membership read is scoped, so the user behind it is never reached.
    const found = await names.byMembershipId(ctx(), [ELSEWHERE]);

    expect(found.size).toBe(0);
  });

  it('treats a malformed id as nobody, rather than as a server fault', async () => {
    // `$in` over a list holding one throws a CastError, which renders as a 500. The tenant
    // repository has answered *nothing found* to a malformed id since Phase 2; so does this.
    const found = await names.byMembershipId(ctx(), ['not-an-object-id', SARI]);

    expect(found.has('not-an-object-id')).toBe(false);
    expect(found.get(SARI)).toBe('Ibu Sari');
  });

  it('reads nothing at all when every id is malformed', async () => {
    expect((await names.byMembershipId(ctx(), ['mem-a', 'mem-b'])).size).toBe(0);
  });

  it('leaves an id that resolves to nobody out of the map', async () => {
    // Absent rather than present with a placeholder: the caller decides what missing means on
    // its own surface, so no screen can render the word "Unknown" as though it were somebody.
    const found = await names.byMembershipId(ctx(), ['66f0000000000000000000ff', SARI]);

    expect(found.has('66f0000000000000000000ff')).toBe(false);
    expect(found.get(SARI)).toBe('Ibu Sari');
  });

  it('leaves out a membership whose person has no name on file', async () => {
    // Written before `fullName` was required: the field is absent rather than empty, which is
    // the shape a schema change leaves behind and the one a `??` has to survive.
    await mongoose.connection.db!.collection('users')
      .updateOne({ _id: new mongoose.Types.ObjectId('66f0000000000000000002' + '01') }, { $unset: { fullName: '' } });

    const found = await names.byMembershipId(ctx(), [SARI, RINA]);

    expect(found.has(SARI)).toBe(false);
    expect(found.get(RINA)).toBe('Rina Wijaya');
  });

  /*
   * **The second hop alone, for memberships the caller has just read** (the Owner's reporting, 2026-10-29):
   * `OfficePeople` reads every member's row for its figures, `userId` with them, and names the active from those rows
   * rather than asking `byMembershipId` to read them all again, whole.
   */
  describe('byReadMemberships', () => {
    /** A read, with every query it sends counted. */
    const counted = async <T>(read: () => Promise<T>): Promise<{ result: T; queries: string[] }> => {
      const queries: string[] = [];
      mongoose.set('debug', (collection: string, method: string) => { queries.push(`${collection}.${method}`); });
      try {
        return { result: await read(), queries };
      } finally {
        mongoose.set('debug', false);
      }
    };

    it('names the rows of a scoped read as byMembershipId names their ids — from the users alone', async () => {
      const rows = await memberships.find(ctx(), {}, { projection: { userId: 1 } });
      expect(rows.map((row) => String(row._id)).sort()).toEqual([SARI, RINA].sort());
      const { result, queries } = await counted(() => names.byReadMemberships(rows));
      expect(queries).toEqual(['users.find']);
      expect(result).toEqual(await names.byMembershipId(ctx(), [SARI, RINA]));
      expect(result).toEqual(new Map([[SARI, 'Ibu Sari'], [RINA, 'Rina Wijaya']]));
    });

    it('names only the rows it is given: another office’s person is reached only through that office’s own read', async () => {
      const mine = await memberships.find(ctx(), { _id: SARI }, { projection: { userId: 1 } });
      expect(await names.byReadMemberships(mine)).toEqual(new Map([[SARI, 'Ibu Sari']]));
      // The other office's scoped read holds its own member alone; this office's holds none of theirs.
      expect(await memberships.find(ctx(), { _id: ELSEWHERE }, { projection: { userId: 1 } })).toEqual([]);
      const theirs = await memberships.find(ctx(OTHER), {}, { projection: { userId: 1 } });
      expect(await names.byReadMemberships(theirs)).toEqual(new Map([[ELSEWHERE, 'Lina Marlina']]));
    });

    it('reads nothing for no rows, and leaves out a membership whose person has no name on file', async () => {
      const { result, queries } = await counted(() => names.byReadMemberships([]));
      expect([result.size, queries]).toEqual([0, []]);
      await mongoose.connection.db!.collection('users')
        .updateOne({ _id: new mongoose.Types.ObjectId('66f0000000000000000002' + '02') }, { $unset: { fullName: '' } });
      const rows = await memberships.find(ctx(), {}, { projection: { userId: 1 } });
      expect(await names.byReadMemberships(rows)).toEqual(new Map([[SARI, 'Ibu Sari']]));
    });
  });
  /*
   * **Names with the photos of the people a read draws** (UI V1, UI-111): the Unit roster, the coaching roster and the
   * coachee's header, the forum's editors. The photo is a storage key on `users.avatarUrl`, signed into a link here.
   */
  describe('pictured', () => {
    const SARI_KEY = 'user/66f000000000000000000201/avatar/01JAAAAAAAAAAAAAAAAAAAAAAA.jpg';
    const signer = () => {
      const linksFor = jest.fn(async (keys: readonly (string | null | undefined)[]) =>
        new Map(keys.filter((k): k is string => !!k).map((k) => [k, `https://signed.test/${k}`])));
      return { linksFor } as unknown as AvatarLinks & { linksFor: typeof linksFor };
    };

    beforeEach(async () => {
      await mongoose.connection.db!.collection('users')
        .updateOne({ _id: new mongoose.Types.ObjectId('66f000000000000000000201') }, { $set: { avatarUrl: SARI_KEY, pronoun: 'she' } });
    });

    it('UI-111 a person with a stored photo gets its signed link, one without gets null, in one batch of signatures', async () => {
      const links = signer();
      const pictured = new MemberNames(memberships, mongoose.model(User.name, UserSchema) as never, links);
      const found = await pictured.pictured(ctx(), [SARI, RINA]);
      expect(found.get(SARI)).toEqual({ name: 'Ibu Sari', pronoun: 'she', photoUrl: `https://signed.test/${SARI_KEY}` });
      expect(found.get(RINA)).toEqual({ name: 'Rina Wijaya', pronoun: 'they', photoUrl: null });
      expect(links.linksFor).toHaveBeenCalledTimes(1);
    });

    it('UI-111 signs only the people the read draws: somebody it only names keeps a null photo', async () => {
      const links = signer();
      const pictured = new MemberNames(memberships, mongoose.model(User.name, UserSchema) as never, links);
      const found = await pictured.pictured(ctx(), [SARI, RINA], [RINA]);
      expect(found.get(SARI)).toMatchObject({ name: 'Ibu Sari', photoUrl: null });
      expect(links.linksFor).toHaveBeenCalledWith([null]);
    });

    it('UI-111 without a signer every photo is null — initials, never the storage key — and another office is nobody', async () => {
      const found = await names.pictured(ctx(), [SARI, ELSEWHERE]);
      expect(found).toEqual(new Map([[SARI, { name: 'Ibu Sari', pronoun: 'she', photoUrl: null }]]));
      expect((await names.pictured(ctx(), [])).size).toBe(0);
    });

    /*
     * **P19.9-T4 AC-1 — the Unit roster's WhatsApp** (ADR-0235): `phones` reads each drawn person's number in the same
     * user read. Without it no person carries the key at all, so no other reader can hand on a number it does not draw.
     */
    describe('phones (P19.9-T4 AC-1)', () => {
      const setPhone = (suffix: string, phone: string) => mongoose.connection.db!.collection('users')
        .updateOne({ _id: new mongoose.Types.ObjectId(`66f0000000000000000002${suffix}`) }, { $set: { phone } });

      it('P19.9-T4 AC-1 a drawn person’s number, null without one; the users read once, as without it', async () => {
        await setPhone('01', '+6281200000001');
        const find = jest.spyOn(mongoose.model(User.name), 'find');
        const found = await names.pictured(ctx(), [SARI, RINA], [SARI, RINA], { phones: true });
        expect(found.get(SARI)).toEqual({ name: 'Ibu Sari', pronoun: 'she', photoUrl: null, phone: '+6281200000001' });
        expect(found.get(RINA)).toEqual({ name: 'Rina Wijaya', pronoun: 'they', photoUrl: null, phone: null });
        expect(find).toHaveBeenCalledTimes(1);
        find.mockRestore();
      });

      it('P19.9-T4 AC-1 somebody only named, and an inactive membership, carry null', async () => {
        await setPhone('01', '+6281200000001');
        await setPhone('02', '+6281200000002');
        await mongoose.connection.db!.collection('memberships')
          .updateOne({ _id: new mongoose.Types.ObjectId(RINA) }, { $set: { status: 'removed' } });
        const found = await names.pictured(ctx(), [SARI, RINA], [RINA], { phones: true });
        expect(found.get(SARI)).toMatchObject({ name: 'Ibu Sari', phone: null });
        expect(found.get(RINA)).toMatchObject({ name: 'Rina Wijaya', phone: null });
      });

      it('P19.9-T4 AC-1 not asked, no person carries a phone key — whatever is on file', async () => {
        await setPhone('01', '+6281200000001');
        const found = await names.pictured(ctx(), [SARI]);
        expect(found.get(SARI)).not.toHaveProperty('phone');
      });
    });
  });
});
