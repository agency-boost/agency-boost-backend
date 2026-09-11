import { RequestContext } from '@/common/context/request-context';
import { TenantConfigService } from './tenant-config.service';
import { ActivityConfigService } from './activity.service';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

const NOW = new Date('2026-09-11T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const COMPANY = '66f0000000000000000000c1';

function ctx(kpmId: string) {
  return new RequestContext('u1', 'none', {
    membershipId: `mem-${kpmId}`, kpmId, hierarchyRole: 'ab', status: 'active',
    isKpmOwner: true, isKpmAdmin: false, directCount: 0,
  });
}

describe('publishing an office’s configuration (P4-T6)', () => {
  let wired: ReturnType<typeof configModule>;
  let config: TenantConfigService;
  let activity: ActivityConfigService;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    config = wired.config;
    activity = wired.activity;
  });

  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await provisionOffice(wired, KPM_A, COMPANY);
  });

  describe('what agents see (AC-2)', () => {
    it('falls back to the working copy when an office has no snapshot at all', async () => {
      // The "created before P4-T6" case. Agents seeing nothing would be a worse answer
      // than agents seeing the working copy.
      const published = await config.readPublished(ctx(KPM_A));
      expect(published.activity.flatMap((c) => c.types)).toHaveLength(12);
    });

    it('keeps agents on the published copy while an Owner restructures', async () => {
      /*
       * The whole reason this exists. An Owner archives a type, and for as long as it
       * takes them to rebind the ratio that named it, that ratio computes over something
       * nobody can log against. Agents must not be watching.
       */
      await config.publish(ctx(KPM_A));

      const type = (await activity.list(ctx(KPM_A))).flatMap((c) => c.types)
        .find((t) => t.code === 'SELL_SUBMISSION')!;
      await activity.archiveType(ctx(KPM_A), type.id);

      const working = await config.read(ctx(KPM_A));
      const published = await config.readPublished(ctx(KPM_A));

      expect(working.activity.flatMap((c) => c.types).map((t) => t.code))
        .not.toContain('SELL_SUBMISSION');
      expect(published.activity.flatMap((c) => c.types).map((t) => t.code))
        .toContain('SELL_SUBMISSION');
    });

    it('moves them on once it is published', async () => {
      await config.publish(ctx(KPM_A));
      const type = (await activity.list(ctx(KPM_A))).flatMap((c) => c.types)[0];
      await activity.archiveType(ctx(KPM_A), type.id);
      await config.publish(ctx(KPM_A));

      const published = await config.readPublished(ctx(KPM_A));
      expect(published.activity.flatMap((c) => c.types).map((t) => t.code))
        .not.toContain(type.code);
    });

    it('renders the snapshot with the same renderer agents read it through', async () => {
      // Two renderers would be two answers to "what is this office's configuration".
      await config.publish(ctx(KPM_A));
      expect(await config.readPublished(ctx(KPM_A))).toEqual(await config.read(ctx(KPM_A)));
    });
  });

  describe('knowing there is something to publish', () => {
    it('says so after an edit, and stops saying so after publishing', async () => {
      await config.publish(ctx(KPM_A));
      expect((await config.state(ctx(KPM_A))).hasUnpublishedChanges).toBe(false);

      const type = (await activity.list(ctx(KPM_A))).flatMap((c) => c.types)[0];
      await activity.updateType(ctx(KPM_A), type.id, { label: 'Renamed' });

      expect((await config.state(ctx(KPM_A))).hasUnpublishedChanges).toBe(true);
      await config.publish(ctx(KPM_A));
      expect((await config.state(ctx(KPM_A))).hasUnpublishedChanges).toBe(false);
    });

    it('does not call a reorder an unpublished change', async () => {
      /*
       * A reorder rebinds nothing and bumps no version, so it is not something an office
       * needs to publish. Saying otherwise would train Owners to press Publish after
       * every drag, which is how a real change eventually goes out unnoticed.
       */
      await config.publish(ctx(KPM_A));
      const types = (await activity.list(ctx(KPM_A))).flatMap((c) => c.types);
      await activity.reorderTypes(ctx(KPM_A), [...types].reverse().map((t) => t.id));

      expect((await config.state(ctx(KPM_A))).hasUnpublishedChanges).toBe(false);
    });

    it('treats an office with nothing published as having changes', async () => {
      const state = await config.state(ctx(KPM_A));
      expect(state.publishedVersion).toBe(0);
      expect(state.hasUnpublishedChanges).toBe(true);
    });

    it('counts published versions up, one per publish', async () => {
      await config.publish(ctx(KPM_A));
      const type = (await activity.list(ctx(KPM_A))).flatMap((c) => c.types)[0];
      await activity.updateType(ctx(KPM_A), type.id, { label: 'Again' });
      const state = await config.publish(ctx(KPM_A));

      expect(state.publishedVersion).toBe(2);
      expect(state.publishedAt).toBe(NOW.toISOString());
    });
  });

  describe('isolation', () => {
    it('publishes one office without touching another', async () => {
      await provisionOffice(wired, KPM_B, COMPANY);
      await config.publish(ctx(KPM_A));

      expect((await config.state(ctx(KPM_A))).publishedVersion).toBe(1);
      expect((await config.state(ctx(KPM_B))).publishedVersion).toBe(0);
    });

    it('never hands one office another’s published copy', async () => {
      await provisionOffice(wired, KPM_B, COMPANY);
      const type = (await activity.list(ctx(KPM_A))).flatMap((c) => c.types)[0];
      await activity.updateType(ctx(KPM_A), type.id, { label: 'Only in A' });
      await config.publish(ctx(KPM_A));
      await config.publish(ctx(KPM_B));

      const theirs = await config.readPublished(ctx(KPM_B));
      expect(theirs.activity.flatMap((c) => c.types).map((t) => t.label))
        .not.toContain('Only in A');
    });
  });
});
