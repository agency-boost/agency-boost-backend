import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';
import { SETTINGS_HUB_DEMO, seedSettingsHubFixture } from '../settings-hub-fixture';

const KPM = '66f0000000000000000004a1';
const clock = new FixedClock(new Date('2026-11-20T02:00:00Z'));
const OWNER = new RequestContext('u-owner', 'none', {
  membershipId: 'mem-owner', kpmId: KPM, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
  isKpmOwner: true, isKpmAdmin: false, directCount: 0,
} as never);

/**
 * **The Pengaturan hub's demo** (P19.21-T2; `settings-hub-fixture.ts`): after its publish, 0417's Activity types holds a
 * change agents do not see — read back through the product's own publish state — and a second run adds nothing.
 */
describe('the settings hub seed (P19.21-T2)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    wired = configModule(new Date('2026-11-20T02:00:00Z'));
    await provisionOffice(wired, KPM);
    await wired.config.publish(OWNER);
  }, 120_000);

  afterAll(stopMongo);

  it('P19.21-T2 AC-2 leaves Activity types unpublished and every other setting as published; a re-run writes nothing', async () => {
    expect(await seedSettingsHubFixture({ kpmId: KPM, clock })).toEqual({ edited: true });
    const state = await wired.config.state(OWNER);
    expect(state.settings.filter((s) => s.hasUnpublishedChanges).map((s) => s.setting)).toEqual(['activity_types']);
    const type = (await wired.activity.list(OWNER)).flatMap((c) => c.types).find((t) => t.code === SETTINGS_HUB_DEMO.typeCode)!;
    expect(type).toMatchObject({ description: SETTINGS_HUB_DEMO.description, version: 2 });

    expect(await seedSettingsHubFixture({ kpmId: KPM, clock })).toEqual({ edited: false });
    expect((await wired.activity.list(OWNER)).flatMap((c) => c.types).find((t) => t.code === SETTINGS_HUB_DEMO.typeCode)!.version).toBe(2);
  });

  it('P19.21-T2 an office never published is left alone', async () => {
    await expect(seedSettingsHubFixture({ kpmId: '66f00000000000000000beef', clock })).resolves.toEqual({ edited: false });
  });
});
