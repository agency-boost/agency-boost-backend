import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { SOURCE_READER } from '@/common/i18n/reader';
import { DirectoryService } from '@/modules/org/directory.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { Membership, MembershipSchema } from '@/modules/org/membership.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { User, UserSchema } from '@/modules/users/user.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { COACHING_CAST } from '../coaching-cast';
import { seedDemo } from '../demo';

const RUN_MS = 300_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

/**
 * **P19.12-T5 on the demo seed** (ADR-0248 §3, §4; `member-page-fixture.ts`): the Owner opens *All members* in 0417 and
 * finds two members who read *Diundang*, the rest who never signed in *Belum diundang*, and one whose *Data pribadi*
 * has four blanks for *Lengkapi data* — read through the service `GET /members` and `GET /members/:id` answer with.
 */
describe('P19.12-T5 the member page’s states on the demo seed — a run at 09:00 on 11 November 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-11-11T02:00:00Z'));
  let directory: DirectoryService;
  let owner: RequestContext;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    directory = new DirectoryService(
      new MembershipRepository(mongoose.model(Membership.name, MembershipSchema) as never),
      mongoose.model(User.name, UserSchema) as never,
      mongoose.model(Kpm.name, KpmSchema) as never,
      mongoose.model(Company.name, CompanySchema) as never,
    );
    const kpm = await col('kpms').findOne({ code: '0417' });
    const account = await col('users').findOne({ email: 'owner@kpm0417.test' });
    const member = (await col('memberships').findOne({ kpmId: String(kpm!._id), userId: String(account!._id), status: 'active' }))!;
    owner = new RequestContext(String(account!._id), 'none', {
      membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
      status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 1,
    } as never).withReader(SOURCE_READER);
  }, RUN_MS);
  afterAll(stopMongo);

  /** Every active member of 0417, as the Directory pages them. */
  async function directoryRows() {
    const rows = [];
    let cursor: string | undefined;
    do {
      const page = await directory.list(owner, { limit: 100, cursor });
      rows.push(...page.members);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return rows;
  }

  it('P19.12-T5 AC-4 two members read Diundang, somebody Belum diundang, and most have signed in', async () => {
    const rows = await directoryRows();
    const by = (state: string) => rows.filter((r) => r.invitation === state);
    expect(by('invited')).toHaveLength(2);
    expect(by('not_invited').length).toBeGreaterThan(0);
    expect(by('signed_in').length).toBeGreaterThan(rows.length / 2);
    // Nobody another walk reads is touched: the coaching cast, the Owner and the Admin.
    const spared = new Set([...COACHING_CAST.map((p) => p.email), 'owner@kpm0417.test', 'admin@kpm0417.test']);
    expect(by('invited').filter((r) => spared.has(r.email))).toEqual([]);
  });

  it('P19.12-T5 AC-3 one of the invited has four blanks, so Lengkapi data is offered; the other has everything', async () => {
    const [first, second] = (await directoryRows()).filter((r) => r.invitation === 'invited');
    const reads = await Promise.all([first, second].map((r) => directory.read(owner, r.membershipId)));
    const blank = reads.find((r) => r.personal?.dateOfBirth === null)!;
    expect(blank.personal).toMatchObject({ dateOfBirth: null, gender: null, companyJoinMonth: null, workStatus: null });
    const whole = reads.find((r) => r !== blank)!;
    expect(whole.personal?.dateOfBirth).not.toBeNull();
    expect(whole.personal?.workStatus).not.toBeNull();
  });

  it('P19.12-T5 a second run changes nothing: the same two invited, the same one blank', async () => {
    const before = (await directoryRows()).filter((r) => r.invitation === 'invited').map((r) => r.membershipId);
    const invitedAt = await col('memberships').find({ invitedAt: { $ne: null } }).project({ invitedAt: 1 }).toArray();

    await seedDemo({ clock, log: quiet });

    expect((await directoryRows()).filter((r) => r.invitation === 'invited').map((r) => r.membershipId)).toEqual(before);
    expect(await col('memberships').find({ invitedAt: { $ne: null } }).project({ invitedAt: 1 }).toArray()).toEqual(invitedAt);
    const blank = await Promise.all(before.map((id) => directory.read(owner, id)));
    expect(blank.filter((r) => r.personal?.dateOfBirth === null)).toHaveLength(1);
  }, RUN_MS);
});
