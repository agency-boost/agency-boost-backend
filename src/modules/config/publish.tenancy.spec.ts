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
    membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
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

    describe('every change, not only one above the highest version (P5-T11)', () => {
      /*
       * The gate compared the **highest** active row version with the one the snapshot was
       * rendered from. A new row starts at version 1 and an archived row leaves the active
       * list, so once any row had reached version 2 and been published — which is the
       * ordinary life of an office — a create, an edit below that maximum and an archive
       * were all invisible. The Owner was told nothing needed publishing, and agents never
       * saw the change.
       *
       * The test above passed throughout: its edit took a version-1 office to version 2,
       * the one case the old comparison could see. Every test here starts from the state
       * that hid the rest.
       */
      const typeNamed = async (code: string) =>
        (await activity.list(ctx(KPM_A), true)).flatMap((c) => c.types).find((t) => t.code === code)!;

      const unpublished = async () => (await config.state(ctx(KPM_A))).hasUnpublishedChanges;

      beforeEach(async () => {
        const [ratio] = await wired.ratios.list(ctx(KPM_A));
        await wired.ratios.update(ctx(KPM_A), ratio.id, { benchmark: 0.2 });
        await config.publish(ctx(KPM_A));
        expect(await unpublished()).toBe(false);
      });

      it('AC-1: sees a new row, which starts below the highest version', async () => {
        const [category] = await activity.list(ctx(KPM_A));
        await activity.createType(ctx(KPM_A), {
          code: 'SELL_REFERRAL', categoryCode: category.code, label: 'Referral masuk',
        });

        expect(await unpublished()).toBe(true);
      });

      it('AC-1: sees an edit that does not climb above the highest version', async () => {
        const type = await typeNamed('SELL_SUBMISSION');
        await activity.updateType(ctx(KPM_A), type.id, { label: 'Closing' });

        expect(await unpublished()).toBe(true);
      });

      it('AC-1: sees an archive, which takes the row out of the working copy', async () => {
        await activity.archiveType(ctx(KPM_A), (await typeNamed('SELL_SUBMISSION')).id);

        expect(await unpublished()).toBe(true);
      });

      it('AC-1: sees changes to ratios and lead statuses the same way', async () => {
        await wired.leads.create(ctx(KPM_A), {
          pipeline: 'sales', code: 'AWAITING_UNDERWRITING', label: 'Awaiting underwriting',
        });
        expect(await unpublished()).toBe(true);

        await config.publish(ctx(KPM_A));
        const other = (await wired.ratios.list(ctx(KPM_A)))[1];
        await wired.ratios.update(ctx(KPM_A), other.id, { label: 'Renamed' });
        expect(await unpublished()).toBe(true);
      });

      it('AC-2: still does not call a reorder a change', async () => {
        // The rule is unchanged; only the arithmetic under it was wrong.
        const types = (await activity.list(ctx(KPM_A))).flatMap((c) => c.types);
        await activity.reorderTypes(ctx(KPM_A), [...types].reverse().map((t) => t.id));

        expect(await unpublished()).toBe(false);
      });

      it('AC-3: stops saying so once the change is published', async () => {
        await activity.archiveType(ctx(KPM_A), (await typeNamed('SELL_SUBMISSION')).id);
        expect(await unpublished()).toBe(true);

        await config.publish(ctx(KPM_A));
        expect(await unpublished()).toBe(false);
      });

      it('AC-4: sees a restore, which brings a row back into the working copy', async () => {
        const type = await typeNamed('SELL_SUBMISSION');
        await activity.archiveType(ctx(KPM_A), type.id);
        await config.publish(ctx(KPM_A));

        await activity.restoreType(ctx(KPM_A), type.id);
        expect(await unpublished()).toBe(true);
      });

      it('AC-4: sees the archive of the very row that held the highest version', async () => {
        // The case that most exposed the old arithmetic: the maximum itself leaves.
        const [ratio] = await wired.ratios.list(ctx(KPM_A));
        await wired.ratios.archive(ctx(KPM_A), ratio.id);

        expect(await unpublished()).toBe(true);
      });
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
  describe('the ladder and the tag (P4-T9, P4-T7)', () => {
    it('answers an empty ladder for somebody in no office', async () => {
      // A Super Admin reads this too, and they belong to no office — an empty answer is
      // the honest one rather than a throw on a screen that merely draws badges.
      const platform = new RequestContext('u-root', 'super_admin', null);
      await expect(config.ladderFor(platform)).resolves.toEqual([]);
    });

    it('answers an empty ladder when the office row has gone', async () => {
      // A session outliving its office is rare and survivable; a 500 drawing a badge is
      // neither.
      await expect(config.ladderFor(ctx('66f00000000000000000dead'))).resolves.toEqual([]);
    });

    it('gives the same tag for the same configuration, and a different one otherwise', async () => {
      /*
       * Hashed from the rendered body rather than composed from timestamps: the body is
       * what a client caches, so its sameness is the only thing worth asserting.
       */
      const before = await config.read(ctx(KPM_A));
      expect(config.etag(before)).toBe(config.etag(await config.read(ctx(KPM_A))));

      const type = (await activity.list(ctx(KPM_A))).flatMap((c) => c.types)[0];
      await activity.updateType(ctx(KPM_A), type.id, { label: 'Changed' });

      expect(config.etag(await config.read(ctx(KPM_A)))).not.toBe(config.etag(before));
    });

    it('is a strong tag, quoted, and short enough to sit in a header', async () => {
      const tag = config.etag(await config.read(ctx(KPM_A)));
      expect(tag).toMatch(/^"[A-Za-z0-9_-]{32}"$/);
    });

    it('reads version 0 for an office with nothing configured at all', async () => {
      // Not an error: an office created before its company published anything, read
      // before provisioning has run.
      const empty = await config.read(ctx('66f00000000000000000beef'));
      expect(empty.version).toBe(0);
      expect(empty.activity).toEqual([]);
    });
  });

});
