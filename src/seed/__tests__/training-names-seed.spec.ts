import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { seedDemo, type SeedResult } from '../demo';
import { DEMO_SKILL_DESCRIPTIONS, DEMO_TEMPLATE_NAMES } from '../training-names-fixture';

const RUN_MS = 300_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);

/** The account's live membership in 0417, as a signed-in context. */
async function as(email: string, flags: { owner?: boolean } = {}): Promise<RequestContext> {
  const kpm = await col('kpms').findOne({ code: '0417' });
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').findOne({ kpmId: String(kpm!._id), userId: String(account!._id), status: 'active' }))!;
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode, hierarchyRole: member.role,
    status: 'active', isKpmOwner: flags.owner ?? false, isKpmAdmin: false, directCount: 0,
  } as never);
}

/**
 * **P19.6-T4 — short names and *Sinkron dari template*, seeded** (`training-names-fixture.ts`): the seed run as the
 * command runs it, then read back through the training reads and the sync's own read. A second run writes nothing.
 */
describe('P19.6-T4 the training names seed', () => {
  const clock = new FixedClock(new Date('2026-11-06T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;
  let seeded: SeedResult;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    seeded = await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  }, RUN_MS);
  afterAll(stopMongo);

  it('P19.6-T4 AC-1 Rina reads each Sales skill as one short name with its description under it', async () => {
    const rina = await as('rina@kpm0417.test');
    const view = await wired.trainingReadings.of(rina, rina.membershipId!);
    const skills = view.categories.find((c) => c.code === 'SALES')!.skills;
    expect(skills.map((s) => [s.code, s.description])).toEqual(
      skills.map((s) => [s.code, DEMO_SKILL_DESCRIPTIONS[s.code]]),
    );
    expect(seeded.trainingNames).toMatchObject({ skills: 6, templateVersions: 2 });
  });

  it('P19.6-T4 AC-3 AC-5 the Owner of 0417 sees Sinkron dari template: module lines, a renamed skill and a capability item, by code', async () => {
    const owner = await as('owner@kpm0417.test', { owner: true });
    const read = await wired.templateSync.read(owner);
    expect(read.template).toMatchObject({ name: expect.stringContaining('Prudential') });
    expect(read.differences).toEqual(expect.arrayContaining([
      ...Object.entries(DEMO_TEMPLATE_NAMES.modules).map(([code, to]) => ({ level: 'module', code, field: 'description', from: null, to })),
      { level: 'skill', code: 'RETENTION', field: 'name', from: 'Retensi nasabah', to: 'Mempertahankan nasabah' },
      { level: 'capability_item', code: 'PERSONAL_SELLING:LEADS_GEN', field: 'name', from: 'Konsistensi pencarian leads', to: 'Pencarian prospek' },
    ]));
    // The skills' own lines are already the template's: they are not listed.
    expect(read.differences.filter((d) => d.level === 'skill' && d.field === 'description')).toEqual([]);
  });

  it('P19.6-T4 AC-1 no publish bar speaks of the seeded lines: 0417’s skills kept their versions', async () => {
    const kpm = String((await col('kpms').findOne({ code: '0417' }))!._id);
    const owner = await as('owner@kpm0417.test', { owner: true });
    expect((await col('trainingSkills').find({ kpmId: kpm, code: { $in: Object.keys(DEMO_SKILL_DESCRIPTIONS) } }).toArray())
      .map((s) => s.version)).toEqual(Object.keys(DEMO_SKILL_DESCRIPTIONS).map(() => 1));
    expect((await wired.config.state(owner)).hasUnpublishedChanges).toBe(false);
  });

  it('P19.6-T4 a second run writes nothing', async () => {
    const again = await seedDemo({ clock, log: quiet });
    expect(again.trainingNames).toMatchObject({ skills: 0, templateVersions: 0 });
  }, RUN_MS);
});
