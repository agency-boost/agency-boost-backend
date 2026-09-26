import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { Membership, MembershipSchema } from './membership.schema';
import { MembershipRepository } from './membership.repository';
import { MemberNames } from './member-names.service';
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

  beforeAll(async () => {
    await startMongo();
    const memberships = new MembershipRepository(
      mongoose.model(Membership.name, MembershipSchema) as never,
    );
    names = new MemberNames(memberships, mongoose.model(User.name, UserSchema) as never);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await mongoose.connection.db!.collection('memberships').insertMany([
      member(SARI, KPM, '01'), member(RINA, KPM, '02'), member(ELSEWHERE, OTHER, '03'),
    ] as never);
    await mongoose.connection.db!.collection('users').insertMany([
      user('01', 'Ibu Sari'), user('02', 'Rina Wijaya'), user('03', 'Lina Marlina'),
    ] as never);
  });

  const member = (id: string, kpmId: string, userSuffix: string) => ({
    _id: new mongoose.Types.ObjectId(id),
    kpmId,
    userId: `66f0000000000000000002${userSuffix}`,
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
});
