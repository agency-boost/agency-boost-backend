import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

const NOW = new Date('2026-03-11T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';
const TODAY = '2026-03-11';

const member = (kpmId: string, over: Record<string, unknown> = {}) => new RequestContext(
  'u1', 'none', {
    membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
    status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
  } as never,
);
const owner = (kpmId: string) => member(kpmId, {
  membershipId: `owner-${kpmId}`, orgLevelCode: 'AB', hierarchyRole: 'ab', isKpmOwner: true,
});
const leader = (kpmId: string) => member(kpmId, {
  membershipId: `leader-${kpmId}`, orgLevelCode: 'AB', hierarchyRole: 'ab', directCount: 1,
});

/**
 * **Log Activity saves what it shows** (P13.1-T2; the client's item 10, 2026-10-07).
 *
 * The screen draws its rows from `/kpm/config`, the office's published copy (P4-T6). The save checked
 * the live draft. So a type the Owner archived after publishing — the seed's `DEV_COACHING_RECEIVED`,
 * *"1-on-1 coaching dengan leader saya"* — stayed on the agent's screen and was refused on Save as a code
 * the office did not have. Here the day and the save read the published copy, as the screen does.
 *
 * **The service as the application's container builds it.** `configModule` constructs `ActivityService`
 * before `TenantConfigService` and hands it none, so every other spec on the harness reads the working
 * copy — what `readPublished` answers an office with nothing published, which is where the harness's
 * offices are. These specs give it the published read, as Nest does.
 */
describe('P13.1-T2 — the day is read and saved in the published vocabulary', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    Object.assign(wired.activityLogs, { published: wired.config });
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    jest.restoreAllMocks();
    await clearCollections();
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: COMPANY, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: COMPANY, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
    ]);
    await wired.orgLevels.seedDefaultLadder(COMPANY);
    await provisionOffice(wired, KPM_A, COMPANY);
    await provisionOffice(wired, KPM_B, COMPANY);
    // What provisioning does in the application: the office starts on a published copy.
    await wired.config.publish(owner(KPM_A));
    await wired.config.publish(owner(KPM_B));
  });

  const save = (ctx: RequestContext, counts: Record<string, number>) =>
    wired.activityLogs.saveDay(ctx, { counts });
  const codesOf = async (ctx: RequestContext) =>
    (await wired.activityLogs.readDay(ctx, {})).entries.map((e) => e.activityTypeCode);
  const typeId = async (kpmId: string, code: string) =>
    (await wired.activity.list(owner(kpmId), true)).flatMap((c) => c.types).find((t) => t.code === code)!.id;
  const stored = (kpmId: string, membershipId: string) =>
    mongoose.connection.db!.collection('activityLogs').findOne({ kpmId, membershipId, localDate: TODAY });

  describe('AC-1 a type archived in the draft after publishing', () => {
    beforeEach(async () => {
      await wired.activity.archiveType(owner(KPM_A), await typeId(KPM_A, 'DEV_COACHING_RECEIVED'));
    });

    it('P13.1-T2 AC-1 is still on the day the screen opens, and its count saves — the client’s row', async () => {
      expect(await codesOf(member(KPM_A))).toContain('DEV_COACHING_RECEIVED');

      const day = await save(member(KPM_A), { DEV_COACHING_RECEIVED: 1, SELL_SUBMISSION: 2 });

      expect(day.totalCount).toBe(3);
      expect(day.entries.find((e) => e.activityTypeCode === 'DEV_COACHING_RECEIVED')).toMatchObject({ count: 1 });
      // Stored against the type's own id, as every entry is: the archived row is still the same type.
      const entry = ((await stored(KPM_A, `mem-${KPM_A}`))!.entries as { activityTypeId: string; activityTypeCode: string }[])
        .find((e) => e.activityTypeCode === 'DEV_COACHING_RECEIVED');
      expect(entry?.activityTypeId).toBe(await typeId(KPM_A, 'DEV_COACHING_RECEIVED'));
    });

    it('P13.1-T2 AC-1 and a correction takes it too, from the same copy', async () => {
      await mongoose.connection.db!.collection('activityLogs').insertOne({
        kpmId: KPM_A, membershipId: `mem-${KPM_A}`, localDate: '2026-01-15', entries: [], totalCount: 0,
        source: 'self', enteredByMembershipId: `mem-${KPM_A}`, version: 1, frozenAt: null, corrections: [],
        deletedAt: null,
      });

      const day = await wired.activityLogs.correctDay(member(KPM_A), {
        date: '2026-01-15', counts: { DEV_COACHING_RECEIVED: 2 }, reason: 'The 1-on-1 was on the 15th.',
      });

      expect(day.totalCount).toBe(2);
    });

    it('P13.1-T2 AC-1 leaves the day and is refused by name once the office publishes the archive', async () => {
      await wired.config.publish(owner(KPM_A));

      expect(await codesOf(member(KPM_A))).not.toContain('DEV_COACHING_RECEIVED');
      await expect(save(member(KPM_A), { DEV_COACHING_RECEIVED: 1 })).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(/no activity type with the code DEV_COACHING_RECEIVED/),
      });
    });
  });

  describe('AC-2 a type created in the draft after publishing', () => {
    beforeEach(async () => {
      await wired.activity.createType(owner(KPM_A), {
        code: 'SELL_REFERRAL_ASKED', categoryCode: 'SELLING', label: 'Meminta referensi',
      });
    });

    it('P13.1-T2 AC-2 is on no day yet, and its count is refused by name', async () => {
      expect(await codesOf(member(KPM_A))).not.toContain('SELL_REFERRAL_ASKED');

      await expect(save(member(KPM_A), { SELL_REFERRAL_ASKED: 1 })).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(/no activity type with the code SELL_REFERRAL_ASKED in the list it has published/),
      });
      expect(await stored(KPM_A, `mem-${KPM_A}`)).toBeNull();
    });

    it('P13.1-T2 AC-2 is on the day, and saves, once the office publishes it', async () => {
      await wired.config.publish(owner(KPM_A));

      expect(await codesOf(member(KPM_A))).toContain('SELL_REFERRAL_ASKED');
      const day = await save(member(KPM_A), { SELL_REFERRAL_ASKED: 4 });
      expect(day.entries.find((e) => e.activityTypeCode === 'SELL_REFERRAL_ASKED')).toMatchObject({ count: 4 });
    });
  });

  describe('AC-3 a section the rung is not shown, and a code nobody has', () => {
    const restrictTeamDevelopmentToLeaders = async () => {
      const development = (await wired.activity.list(owner(KPM_A))).find((c) => c.code === 'TEAM_DEVELOPMENT')!;
      await wired.activity.updateCategory(owner(KPM_A), development.id, { appliesToOrgLevelCodes: ['AB'] });
    };

    it('P13.1-T2 AC-3 keeps its own refusal code once the restriction is published, and a leader still saves', async () => {
      await restrictTeamDevelopmentToLeaders();
      await wired.config.publish(owner(KPM_A));

      expect(await codesOf(member(KPM_A))).not.toContain('DEV_TEAM_ACTIVITY');
      await expect(save(member(KPM_A), { DEV_TEAM_ACTIVITY: 2 }))
        .rejects.toMatchObject({ code: 'ACTIVITY_TYPE_NOT_APPLICABLE', status: 422, details: { codes: ['DEV_TEAM_ACTIVITY'] } });
      await expect(save(leader(KPM_A), { DEV_TEAM_ACTIVITY: 2 })).resolves.toMatchObject({ totalCount: 2 });
    });

    it('P13.1-T2 AC-3 follows the published rule, not the draft’s: narrowed and not published, the agent still logs it', async () => {
      await restrictTeamDevelopmentToLeaders();

      // The agent's screen still shows the section, because what was published says every rung.
      expect(await codesOf(member(KPM_A))).toContain('DEV_TEAM_ACTIVITY');
      await expect(save(member(KPM_A), { DEV_TEAM_ACTIVITY: 2 })).resolves.toMatchObject({ totalCount: 2 });
    });

    it('P13.1-T2 AC-3 still refuses a code no office has, by name, with the validation status', async () => {
      await expect(save(member(KPM_A), { NOT_A_CODE: 1 })).rejects.toMatchObject({
        status: 400, message: expect.stringMatching(/no activity type with the code NOT_A_CODE/),
      });
    });
  });

  describe('AC-4 an office with nothing published', () => {
    const wipeSnapshots = (kpmId: string) =>
      mongoose.connection.db!.collection('configSnapshots').deleteMany({ kpmId });

    it('P13.1-T2 AC-4 reads its working copy on both sides, as `/kpm/config` falls back to it for the screen', async () => {
      await wipeSnapshots(KPM_A);
      await wired.activity.createType(owner(KPM_A), {
        code: 'SELL_REFERRAL_ASKED', categoryCode: 'SELLING', label: 'Meminta referensi',
      });

      // The screen's read and the day's agree: the draft is all there is.
      const screen = (await wired.config.readPublished(owner(KPM_A))).activity.flatMap((c) => c.types.map((t) => t.code));
      expect(screen).toContain('SELL_REFERRAL_ASKED');
      expect(await codesOf(member(KPM_A))).toEqual(expect.arrayContaining(['SELL_REFERRAL_ASKED']));
      await expect(save(member(KPM_A), { SELL_REFERRAL_ASKED: 1 })).resolves.toMatchObject({ totalCount: 1 });
    });

    it('P13.1-T2 AC-4 a published copy with nothing for the rung opens an empty day and takes no code — the empty-configuration card', async () => {
      await mongoose.connection.db!.collection('configSnapshots')
        .updateMany({ kpmId: KPM_A }, { $set: { 'payload.activity': [] } });

      const day = await wired.activityLogs.readDay(member(KPM_A), {});
      expect(day.entries).toEqual([]);
      await expect(save(member(KPM_A), { SELL_SUBMISSION: 1 })).rejects.toMatchObject({
        status: 400, message: expect.stringMatching(/no activity type with the code SELL_SUBMISSION/),
      });
    });
  });

  describe('AC-5 one snapshot read per request', () => {
    it('P13.1-T2 AC-5 reads the published copy once to open a day, once to save one, once to correct one', async () => {
      const reads = jest.spyOn(wired.config, 'readPublished');

      await wired.activityLogs.readDay(member(KPM_A), {});
      expect(reads).toHaveBeenCalledTimes(1);

      reads.mockClear();
      await save(member(KPM_A), { SELL_SUBMISSION: 1 });
      expect(reads).toHaveBeenCalledTimes(1);

      reads.mockClear();
      await mongoose.connection.db!.collection('activityLogs').insertOne({
        kpmId: KPM_A, membershipId: `mem-${KPM_A}`, localDate: '2026-01-15', entries: [], totalCount: 0,
        source: 'self', enteredByMembershipId: `mem-${KPM_A}`, version: 1, frozenAt: null, corrections: [],
        deletedAt: null,
      });
      await wired.activityLogs.correctDay(member(KPM_A), { date: '2026-01-15', counts: {}, reason: 'Nothing that day.' });
      expect(reads).toHaveBeenCalledTimes(1);
    });
  });

  describe('isolation (invariant §1)', () => {
    it('P13.1-T2 reads each office’s own published copy: office B publishing an archive changes nothing in office A', async () => {
      await wired.activity.archiveType(owner(KPM_B), await typeId(KPM_B, 'DEV_COACHING_RECEIVED'));
      await wired.config.publish(owner(KPM_B));

      await expect(save(member(KPM_B), { DEV_COACHING_RECEIVED: 1 })).rejects.toMatchObject({ status: 400 });
      await expect(save(member(KPM_A), { DEV_COACHING_RECEIVED: 1 })).resolves.toMatchObject({ totalCount: 1 });
      expect((await stored(KPM_B, `mem-${KPM_B}`))).toBeNull();
    });
  });
});
