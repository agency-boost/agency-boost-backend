import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { defaultCampaignKinds } from '@/modules/campaigns/campaign-kinds-payload';
import { defaultEventTypes } from '@/modules/events/event-types-payload';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule, provisionOffice } from '../../../test/config-module';

const NOW = new Date('2026-09-18T02:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';
const PRU_OFFICE = '66f0000000000000000000a1';
const PRU_OFFICE_2 = '66f0000000000000000000a2';
const ALLIANZ_OFFICE = '66f0000000000000000000b1';

function ctx(kpmId: string, membershipId = `mem-${kpmId}`) {
  return new RequestContext('u1', 'none', {
    membershipId, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab', status: 'active',
    isKpmOwner: true, isKpmAdmin: false, directCount: 0,
  });
}

const admin = () => new RequestContext('u-root', 'super_admin', null);

/**
 * Catalog publishing and the consolidated read (P5-T9).
 *
 * Two things this task exists to make true, and neither was before it:
 *
 * **Every Phase 5 kind can be published** — a starting payload so a Super Admin edits rather than
 * retypes, one checker shared by publishing and provisioning, and a provisioning step that reads
 * what was published. `capability_ladder` had two of the three; `event_types` and `campaign_kinds`
 * had none, which is why the Company template's Events and Campaigns tabs were signs rather than
 * screens.
 *
 * **`GET /kpm/config` carries the office's own configuration, and only that** (ADR-0039): if two
 * members of one office would receive different bytes, it is not snapshot material.
 */
describe('catalog publishing and the consolidated read (P5-T9)', () => {
  let wired: ReturnType<typeof configModule>;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });

  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    const companies = wired.companies as mongoose.Model<never>;
    await companies.create([
      {
        _id: PRUDENTIAL, name: 'Prudential', slug: 'prudential', defaultCurrency: 'IDR',
        defaultLocale: 'id-ID', defaultTimezone: 'Asia/Jakarta', status: 'active', deletedAt: null,
      },
      {
        _id: ALLIANZ, name: 'Allianz Life', slug: 'allianz-life', defaultCurrency: 'IDR',
        defaultLocale: 'id-ID', defaultTimezone: 'Asia/Jakarta', status: 'active', deletedAt: null,
      },
    ] as never);
  });

  /** Publish a template of one kind for a company, in one step. */
  const publish = async (companyId: string, kind: string, payload: Record<string, unknown>) => {
    await wired.templateService.saveDraft(admin(), companyId, kind as never, payload);
    return wired.templateService.publish(admin(), companyId, kind as never);
  };

  describe('every Phase 5 kind has the three things (AC-4)', () => {
    it('hands back a starting payload rather than an empty object', async () => {
      // `capability_ladder` had validation and a provisioning reader since P5-T8 and no starting
      // payload, so opening its tab would have asked a Super Admin to retype four stages.
      for (const kind of ['capability_ladder', 'event_types', 'campaign_kinds'] as const) {
        const template = await wired.templateService.read(PRUDENTIAL, kind);
        expect(Object.keys(template.payload).length).toBeGreaterThan(0);
      }

      const events = await wired.templateService.read(PRUDENTIAL, 'event_types');
      expect((events.payload as { types: unknown[] }).types).toHaveLength(5);
    });

    it('refuses an event type set that would give an office nothing to file under', async () => {
      await expect(publish(PRUDENTIAL, 'event_types', { types: [] }))
        .rejects.toThrow(/nothing to file an event under/);

      await expect(publish(PRUDENTIAL, 'event_types', {
        types: [{ code: 'TRAINING', label: 'Training' }, { code: 'TRAINING', label: 'Latihan' }],
      })).rejects.toThrow(/used twice/);

      await expect(publish(PRUDENTIAL, 'event_types', {
        types: [{ code: 'TRAINING', label: '' }],
      })).rejects.toThrow(/no label/);
    });

    it('refuses a rule everybody passes and a tier order nobody can read', async () => {
      await expect(publish(PRUDENTIAL, 'campaign_kinds', {
        rules: [{
          kind: 'production_club', code: 'STAR_CLUB', name: 'Star Club',
          criteriaGroups: [], rank: 1,
        }],
      })).rejects.toThrow(/asks for nothing/);

      const two = (rank: number) => ({
        kind: 'production_club', code: `TIER_${rank}`, name: `Tier ${rank}`, rank: 1,
        criteriaGroups: [{
          mode: 'all', criteria: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 1 }],
        }],
      });
      await expect(publish(PRUDENTIAL, 'campaign_kinds', { rules: [two(1), two(2)] }))
        .rejects.toThrow(/share rank 1/);
    });

    it('seeds a new office from what its company published, not from the defaults', async () => {
      await publish(PRUDENTIAL, 'event_types', {
        types: [
          { code: 'PRODUCT_LAUNCH', label: 'Peluncuran produk', emoji: '🚀', color: '#F2994A' },
          { code: 'TOWN_HALL', label: 'Town hall', emoji: '📣', color: '#2D9CDB' },
        ],
      });

      const seeded = await wired.provisioning.seedEventTypes(PRU_OFFICE, PRUDENTIAL);
      expect(seeded.rows).toBe(2);

      const types = await wired.events.listTypes(ctx(PRU_OFFICE));
      expect(types.map((t) => t.code)).toEqual(['PRODUCT_LAUNCH', 'TOWN_HALL']);
      expect(types[1].label).toBe('Town hall');
    });

    it('falls back to the platform defaults where a company has published nothing', async () => {
      const seeded = await wired.provisioning.seedEventTypes(ALLIANZ_OFFICE, ALLIANZ);

      expect(seeded.rows).toBe(defaultEventTypes().types.length);
      expect(seeded.seededFrom.version).toBeNull();
    });

    it('applies campaign kinds at publish, because the rules are the company’s', async () => {
      /*
       * Not at provisioning, and the reason is in the data model: carrier rules are
       * company-partitioned and read live by every office (ADR-0026). There is nothing to copy
       * into an office — and a template belongs to a company, so no company could have one
       * published before it existed anyway.
       */
      const payload = defaultCampaignKinds();
      await publish(PRUDENTIAL, 'campaign_kinds', payload as never);

      const rules = await mongoose.connection.db!.collection('qualificationRules')
        .find({ companyId: PRUDENTIAL, deletedAt: null }).toArray();
      expect(rules).toHaveLength(payload.rules.length);
      expect(rules.map((r) => r.code)).toEqual(
        expect.arrayContaining(['STAR_CLUB', 'CHAIRMANS_CLUB', 'MOC_AB']),
      );
      // The unit comes from the registry, never from the payload (invariant 7).
      const star = rules.find((r) => r.code === 'STAR_CLUB')!;
      expect(star.criteriaGroups[0].criteria[0].unit).toBe('idr_minor');
    });

    it('retires a rule the new payload no longer names, and never removes it', async () => {
      await publish(PRUDENTIAL, 'campaign_kinds', defaultCampaignKinds() as never);
      await publish(PRUDENTIAL, 'campaign_kinds', {
        rules: defaultCampaignKinds().rules.filter((r) => r.code !== 'CHAIRMANS_CLUB'),
      } as never);

      const all = await mongoose.connection.db!.collection('qualificationRules')
        .find({ companyId: PRUDENTIAL }).toArray();
      const chairmans = all.find((r) => r.code === 'CHAIRMANS_CLUB')!;
      // Soft-deleted (invariant 6): a standing that qualified under it is still a standing, and
      // the row has to stay readable to render it.
      expect(chairmans.deletedAt).not.toBeNull();
      expect(all.filter((r) => r.deletedAt === null)).toHaveLength(
        defaultCampaignKinds().rules.length - 1,
      );
    });
  });

  describe('the consolidated read (AC-1, AC-3)', () => {
    beforeEach(async () => {
      await provisionOffice(wired, PRU_OFFICE, PRUDENTIAL);
    });

    it('carries the office’s Phase 5 catalogs, active rows only', async () => {
      const config = await wired.config.read(ctx(PRU_OFFICE));

      expect(config.eventTypes.map((t) => t.code)).toEqual(
        defaultEventTypes().types.map((t) => t.code),
      );
      expect(config.capability?.stages.length).toBeGreaterThan(0);
      expect(config.training.length).toBeGreaterThan(0);
      // No live count on a snapshot row: it would be wrong the moment anybody filed an event.
      expect(config.eventTypes[0]).not.toHaveProperty('events');
    });

    it('leaves an archived event type out of what agents read', async () => {
      const types = await wired.events.listTypes(ctx(PRU_OFFICE));
      await wired.events.archiveType(ctx(PRU_OFFICE), types[0].id);

      const config = await wired.config.read(ctx(PRU_OFFICE));
      expect(config.eventTypes.map((t) => t.code)).not.toContain(types[0].code);
    });

    it('gives two members of one office the same bytes (AC-3)', async () => {
      /*
       * ADR-0039's whole test. A list filtered per member would either break the `ETag` — one body
       * per reader — or stop the snapshot being the single agent read. Per-person audience is an
       * event's, and events are not in here at all.
       */
      const mine = await wired.config.read(ctx(PRU_OFFICE, 'mem-one'));
      const theirs = await wired.config.read(ctx(PRU_OFFICE, 'mem-two'));

      expect(wired.config.etag(mine)).toBe(wired.config.etag(theirs));
      expect(mine).toEqual(theirs);
      expect(mine).not.toHaveProperty('events');
      expect(mine).not.toHaveProperty('campaigns');
      expect(mine).not.toHaveProperty('products');
    });

    it('moves the publish bar when a Phase 5 catalog changes', async () => {
      await wired.config.publish(ctx(PRU_OFFICE));
      expect((await wired.config.state(ctx(PRU_OFFICE))).hasUnpublishedChanges).toBe(false);

      const types = await wired.events.listTypes(ctx(PRU_OFFICE));
      await wired.events.updateType(ctx(PRU_OFFICE), types[0].id, { label: 'Pelatihan' });

      // Without the event types in the fingerprint the bar stays silent, agents keep reading the
      // old snapshot, and nothing on the screen says why.
      expect((await wired.config.state(ctx(PRU_OFFICE))).hasUnpublishedChanges).toBe(true);
    });

    it('reads an older snapshot back in one shape', async () => {
      // An office provisioned before these fields existed has a snapshot without them. Read as
      // empty rather than absent, so no screen has to know which phase its office was built in.
      await wired.config.publish(ctx(PRU_OFFICE));
      await mongoose.connection.db!.collection('configSnapshots').updateOne(
        { kpmId: PRU_OFFICE },
        { $unset: { 'payload.eventTypes': '', 'payload.capability': '', 'payload.activationChecklist': '' } },
      );

      const published = await wired.config.readPublished(ctx(PRU_OFFICE));
      expect(published.eventTypes).toEqual([]);
      expect(published.capability).toBeNull();
      expect(published.activationChecklist).toBeNull();
    });
  });

  describe('two companies, and neither sees the other (AC-5)', () => {
    it('seeds each office from its own company’s presets', async () => {
      await publish(PRUDENTIAL, 'event_types', {
        types: [{ code: 'TOWN_HALL', label: 'Town hall', emoji: '📣', color: '#2D9CDB' }],
      });
      await publish(ALLIANZ, 'event_types', {
        types: [
          { code: 'ROADSHOW', label: 'Roadshow', emoji: '🚐', color: '#EB5757' },
          { code: 'CLINIC', label: 'Product clinic', emoji: '🩺', color: '#27AE60' },
        ],
      });

      await provisionOffice(wired, PRU_OFFICE, PRUDENTIAL);
      await provisionOffice(wired, ALLIANZ_OFFICE, ALLIANZ);

      expect((await wired.events.listTypes(ctx(PRU_OFFICE))).map((t) => t.code))
        .toEqual(['TOWN_HALL']);
      expect((await wired.events.listTypes(ctx(ALLIANZ_OFFICE))).map((t) => t.code))
        .toEqual(['ROADSHOW', 'CLINIC']);
    });

    it('gives two offices of one company identical codes (AC-5)', async () => {
      await publish(PRUDENTIAL, 'capability_ladder', {
        stages: [{
          code: 'COMPETENT', label: 'Competent', requiredMilestoneCodes: ['SELLS'], stageOrder: 1,
        }],
        milestones: [{ code: 'SELLS', label: 'Sells independently' }],
        grids: [{ code: 'PERSONAL', label: 'Personal selling', items: [{ code: 'APPROACH', label: 'Approach' }] }],
      });

      await provisionOffice(wired, PRU_OFFICE, PRUDENTIAL);
      await provisionOffice(wired, PRU_OFFICE_2, PRUDENTIAL);

      const one = await wired.capability.read(ctx(PRU_OFFICE));
      const two = await wired.capability.read(ctx(PRU_OFFICE_2));
      expect(one.grids[0].items.map((i) => i.code)).toEqual(two.grids[0].items.map((i) => i.code));
      expect(one.stages.map((s) => s.code)).toEqual(['COMPETENT']);
    });

    it('keeps one company’s carrier rules out of the other’s offices', async () => {
      await publish(PRUDENTIAL, 'campaign_kinds', {
        rules: [{
          kind: 'production_club', code: 'PRU_STAR', name: 'Pru Star', rank: 1,
          criteriaGroups: [{
            mode: 'all', criteria: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 1 }],
          }],
        }],
      });
      await publish(ALLIANZ, 'campaign_kinds', {
        rules: [{
          kind: 'production_club', code: 'ALZ_ELITE', name: 'Allianz Elite', rank: 1,
          criteriaGroups: [{
            mode: 'all', criteria: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 2 }],
          }],
        }],
      });

      const of = async (companyId: string) => (await mongoose.connection.db!
        .collection('qualificationRules')
        .find({ companyId, deletedAt: null }).toArray()).map((r) => r.code);

      expect(await of(PRUDENTIAL)).toEqual(['PRU_STAR']);
      expect(await of(ALLIANZ)).toEqual(['ALZ_ELITE']);
    });
  });

  describe('what the company changes without anybody republishing (AC-2)', () => {
    it('stops an office selling a product the company withdraws, with no office action', async () => {
      /*
       * The reason products are **not** in the snapshot (ADR-0033). A withdrawal is one write at
       * company level, and it has to reach every office of that company on their next read — a
       * frozen copy could only do that if fifty Owners each pressed Publish.
       */
      await provisionOffice(wired, PRU_OFFICE, PRUDENTIAL);
      // The office record itself: `KpmProductService` resolves the company from it on every read,
      // which is what makes the catalog live rather than copied.
      await (wired.kpms as mongoose.Model<never>).create({
        _id: PRU_OFFICE, companyId: PRUDENTIAL, code: '0417', branchName: 'Jakarta Selatan',
        timezone: 'Asia/Jakarta',
      } as never);
      await wired.products.seedForCompany(PRUDENTIAL);
      const shelf = await wired.products.list(PRUDENTIAL, { withCommission: false });
      const target = shelf[0];

      await wired.kpmProducts.setActive(ctx(PRU_OFFICE), target.id, true);
      await wired.config.publish(ctx(PRU_OFFICE));

      await wired.products.setLifecycle(admin(), PRUDENTIAL, target.id, 'withdrawn');

      const after = await wired.kpmProducts.list(ctx(PRU_OFFICE));
      const row = after.find((p) => p.productId === target.id)!;
      expect(row.sellable).toBe(false);
      expect(row.lifecycle).toBe('withdrawn');
      // And the office's own snapshot is untouched: it never carried the product in the first place.
      expect((await wired.config.state(ctx(PRU_OFFICE))).hasUnpublishedChanges).toBe(false);
    });
  });
});
