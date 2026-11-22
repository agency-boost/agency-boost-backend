import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { TrainingModuleFacts } from '@/modules/training/training-module-facts';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import { seedTrainingTreeFixture, TRAINING_TREE_SEED } from '../training-tree-fixture';

const KPM = '66f0000000000000000004a2';
const clock = new FixedClock(new Date('2026-11-20T02:00:00Z'));
const OWNER = new RequestContext('u-owner', 'none', {
  membershipId: 'mem-owner', kpmId: KPM, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);

/**
 * **Pengaturan › Training's demo tree** (P19.25-T4; `training-tree-fixture.ts`): after a publish, each of the four other
 * categories holds a skill and its modules — some with a link, some for *Unggah materi* — read back through the
 * product's own settings read; *Training* stays published; and a second run writes nothing.
 */
describe('P19.25-T4 the training tree seed', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    wired = configModule(new Date('2026-11-20T02:00:00Z'));
    await provisionOffice(wired, KPM);
    await wired.config.publish(OWNER);
  }, 120_000);

  afterAll(stopMongo);

  it('P19.25-T4 AC-1 fills the four categories, keeps Training published, and writes nothing on a re-run', async () => {
    const first = await seedTrainingTreeFixture({ clock, kpmId: KPM, cast: {} });
    expect(first.written).toBeGreaterThan(0);

    const tree = await wired.training.list(OWNER);
    for (const branch of TRAINING_TREE_SEED) {
      const category = tree.find((c) => c.code === branch.categoryCode)!;
      const skill = category.skills.find((s) => s.code === branch.skill.code)!;
      expect(skill.modules.map((m) => m.code)).toEqual(branch.modules.map((m) => m.code));
      for (const module of skill.modules) {
        const planned = branch.modules.find((m) => m.code === module.code)!;
        // A link the office added is the row's item; none is *Unggah materi*.
        expect(module.materialItem).toEqual(planned.material ? { label: planned.material.label, kind: 'link', mimeType: null } : null);
      }
    }
    const state = await wired.config.state(OWNER);
    expect(state.settings.find((s) => s.setting === 'training')!.hasUnpublishedChanges).toBe(false);

    expect((await seedTrainingTreeFixture({ clock, kpmId: KPM, cast: {} })).written).toBe(0);
  });

  it('P19.25-T4 AC-2 its progress makes a row read "n dari … selesai"', async () => {
    const mongoose = (await import('mongoose')).default;
    const members = await mongoose.connection.db!.collection('memberships').insertMany(['agus', 'siti'].map((key) => ({
      // A leader code each: another suite in the same worker may have built `memberships`' unique `leaderCode` index.
      kpmId: KPM, userId: `u-${key}`, leaderCode: `tt-${key}`, role: 'agent', orgLevelCode: 'AGENT', status: 'active', deletedAt: null,
    })));
    const ids = Object.values(members.insertedIds).map(String);
    await seedTrainingTreeFixture({ clock, kpmId: KPM, cast: { agus: ids[0], siti: ids[1] } });
    const facts = new TrainingModuleFacts(wired.memberships as never, wired.trainingProgressRows as never);
    const read = await facts.completion(OWNER, ['NPA_PROCESS', 'OPPORTUNITY_TALK']);
    expect(read.get('NPA_PROCESS')).toMatchObject({ done: 2 });
    expect(read.get('OPPORTUNITY_TALK')).toMatchObject({ done: 0, started: 0 });
  });
});
