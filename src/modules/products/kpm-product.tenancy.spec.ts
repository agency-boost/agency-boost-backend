import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';

const NOW = new Date('2026-09-18T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const KPM_OTHER = '66f0000000000000000000b2';
const PRUDENTIAL = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';

const member = (kpmId: string, over: Record<string, unknown> = {}) =>
  new RequestContext('u1', 'none', {
    membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AB', hierarchyRole: 'ab',
    status: 'active', isKpmOwner: true, isKpmAdmin: false, directCount: 0, ...over,
  } as never);

const superAdmin = () => RequestContext.platform('root');

/**
 * What an office decides about its company's products (P5-T5, ADR-0033).
 *
 * The thing worth proving here is the **inheritance**, because it is what the whole design rests
 * on: a product is never copied into an office, so a company edit to a field nobody overrode has
 * to reach every office on its next read — and a reset has to be an `$unset` rather than a copy,
 * or today's wording is frozen into the office for ever without anybody noticing.
 */
describe('an office’s product decisions (P5-T5)', () => {
  let wired: ReturnType<typeof configModule>;
  let mapanId: string;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await (wired.companies as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: PRUDENTIAL, name: 'Prudential', slug: 'prudential' },
      { _id: ALLIANZ, name: 'Allianz', slug: 'allianz' },
    ]);
    await (wired.kpms as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: KPM_A, companyId: PRUDENTIAL, code: '0417', branchName: 'A', timezone: 'Asia/Jakarta' },
      { _id: KPM_B, companyId: PRUDENTIAL, code: '0555', branchName: 'B', timezone: 'Asia/Jakarta' },
      { _id: KPM_OTHER, companyId: ALLIANZ, code: '0999', branchName: 'C', timezone: 'Asia/Jakarta' },
    ]);
    await wired.products.seedForCompany(PRUDENTIAL);
    await wired.products.seedForCompany(ALLIANZ);
    mapanId = (await wired.products.list(PRUDENTIAL, { withCommission: false }))
      .find((p) => p.code === 'PRUMAPAN')!.id;
  });

  const mine = async (ctx: RequestContext, code = 'PRUMAPAN') =>
    (await wired.kpmProducts.list(ctx)).find((p) => p.code === code)!;

  /** The stored document, not the read — the only place an `$unset` is distinguishable. */
  const stored = (kpmId: string, productId: string) => mongoose.connection.db!
    .collection('kpmProductConfigs').findOne({ kpmId, productId });

  describe('isolation (AC-1)', () => {
    it('shows an office only its own company’s products', async () => {
      const prudential = await wired.kpmProducts.list(member(KPM_A));
      const allianz = await wired.kpmProducts.list(member(KPM_OTHER));

      expect(prudential).toHaveLength(31);
      expect(allianz.every((p) => p.productId !== mapanId)).toBe(true);
    });

    it('refuses another company’s product as a 404, not a 403', async () => {
      // A 403 would confirm the id exists, which is the thing the boundary hides.
      await expect(wired.kpmProducts.setActive(member(KPM_OTHER), mapanId, true))
        .rejects.toMatchObject({ status: 404 });
    });

    it('keeps one office’s decision out of another’s, in the same company', async () => {
      await wired.kpmProducts.setActive(member(KPM_A), mapanId, false);

      expect((await mine(member(KPM_A))).active).toEqual({ value: false, overridden: true });
      // The sibling office has no opinion, so it still reads the company's default.
      expect((await mine(member(KPM_B))).active).toEqual({ value: true, overridden: false });
    });
  });

  describe('absent means inherit (AC-2)', () => {
    it('inherits the company’s default before the office has decided anything', async () => {
      const row = await mine(member(KPM_A));

      expect(row.active).toEqual({ value: true, overridden: false });
      expect(row.displayName).toEqual({ value: 'PRUMapan', overridden: false });
      expect(row.script.opening.overridden).toBe(false);
      // And no row is written just by looking.
      expect(await stored(KPM_A, mapanId)).toBeNull();
    });

    it('carries a company edit through to a field the office has not overridden', async () => {
      await wired.kpmProducts.saveOverrides(member(KPM_A), mapanId, { displayName: 'Mapan Plus' });

      await wired.products.update(superAdmin(), PRUDENTIAL, mapanId, {
        bestFor: 'Anybody at all',
        defaultAttackPlan: {
          goodFit: 'Anybody at all', opening: 'The company’s new opening', benefits: [],
          fullScript: 'x', objectionTheySay: 'y', objectionYouSay: 'z', nextAction: 'q?',
        },
      });

      const row = await mine(member(KPM_A));
      // The overridden field held; the rest moved with the company, with nobody republishing.
      expect(row.displayName).toEqual({ value: 'Mapan Plus', overridden: true });
      expect(row.script.opening)
        .toEqual({ value: 'The company’s new opening', overridden: false });
    });
  });

  describe('reset is an unset, not a copy (AC-3)', () => {
    it('removes the key rather than writing the company’s value of the day', async () => {
      await wired.kpmProducts.saveOverrides(member(KPM_A), mapanId, { displayName: 'Ours' });
      expect((await stored(KPM_A, mapanId))!.overrides).toMatchObject({ displayName: 'Ours' });

      await wired.kpmProducts.resetOverride(member(KPM_A), mapanId, 'displayName');

      // Asserted on the raw document: a copy of today's company value would read identically on
      // the API and then diverge silently the moment the company changed its wording.
      expect((await stored(KPM_A, mapanId))!.overrides).not.toHaveProperty('displayName');
      expect((await mine(member(KPM_A))).displayName.overridden).toBe(false);
    });
  });

  describe('what an office may change (AC-6)', () => {
    it('refuses a field that belongs to the company, naming it', async () => {
      await expect(wired.kpmProducts.saveOverrides(member(KPM_A), mapanId, {
        code: 'SOMETHING', commissionSchedule: [],
      })).rejects.toThrow(/code, commissionSchedule/);
    });

    it('takes the display name and the seven script fields', async () => {
      const row = await wired.kpmProducts.saveOverrides(member(KPM_A), mapanId, {
        displayName: 'Ours', opening: 'Halo!', benefits: ['Satu'],
      });

      expect(row.displayName.value).toBe('Ours');
      expect(row.script.opening.value).toBe('Halo!');
      expect(row.script.benefits.value).toEqual(['Satu']);
    });
  });

  describe('the office approves its own script (ADR-0037)', () => {
    it('puts a script edit back to pending, and clears the last decision', async () => {
      const row = await wired.kpmProducts.saveOverrides(member(KPM_A), mapanId, {
        opening: 'Halo!',
      });

      expect(row.reviewState).toBe('pending');
      expect(row.rejectionReason).toBeNull();
    });

    it('leaves the review alone when only the display name changes', async () => {
      // Renaming a product is not rewriting what an agent says about it.
      const row = await wired.kpmProducts.saveOverrides(member(KPM_A), mapanId, {
        displayName: 'Ours',
      });

      expect(row.reviewState).toBe('none');
    });
  });

  describe('the company decides what is on the shelf (AC-5)', () => {
    it('refuses to activate a product the company has withdrawn', async () => {
      await wired.products.setLifecycle(superAdmin(), PRUDENTIAL, mapanId, 'withdrawn');

      await expect(wired.kpmProducts.setActive(member(KPM_A), mapanId, true))
        .rejects.toThrow(/withdrawn by your company/);
    });

    it('stops a product being sellable the moment the company withdraws it, with no office action', async () => {
      await wired.kpmProducts.setActive(member(KPM_A), mapanId, true);
      expect((await mine(member(KPM_A))).sellable).toBe(true);

      await wired.products.setLifecycle(superAdmin(), PRUDENTIAL, mapanId, 'withdrawn');

      const row = await mine(member(KPM_A));
      expect(row.sellable).toBe(false);
      // The office's own decision is still recorded; it is simply no longer sellable.
      expect(row.active.value).toBe(true);
    });
  });

  describe('the three document slots (AC-7)', () => {
    const upload = async (ctx: RequestContext) => {
      const signed = await wired.assets.requestUpload(ctx, {
        folder: 'products', filename: 'brochure.pdf', mimeType: 'application/pdf', bytes: 1024,
      });
      await wired.assets.confirmUpload(ctx, signed.storageKey);
      return signed.storageKey;
    };

    it('starts with nothing in any slot, named in the prototype’s own order', async () => {
      const row = await mine(member(KPM_A));

      expect(row.documents.map((d) => d.slot)).toEqual(['brochure', 'illustration', 'productDoc']);
      expect(row.documents.map((d) => d.source)).toEqual(['none', 'none', 'none']);
      expect(row.documents[1].label).toBe('Illustration / Simulation');
    });

    it('fills one slot and leaves the other two alone', async () => {
      const ctx = member(KPM_A);
      const key = await upload(ctx);

      const row = await wired.kpmProducts.setDocument(ctx, mapanId, 'brochure', {
        storageKey: key, label: 'Our brochure',
      });

      expect(row.documents[0]).toMatchObject({ source: 'kpm', filename: 'Our brochure' });
      expect(row.documents.slice(1).every((d) => d.source === 'none')).toBe(true);
    });

    it('falls back on its own when the office removes its file', async () => {
      const ctx = member(KPM_A);
      await wired.kpmProducts.setDocument(ctx, mapanId, 'brochure', {
        storageKey: await upload(ctx), label: 'Our brochure',
      });

      const row = await wired.kpmProducts.resetDocument(ctx, mapanId, 'brochure');

      expect(row.documents[0].source).toBe('none');
      // Released, never deleted: somebody may put it back.
      expect(wired.storage.removed).toEqual([]);
    });

    it('refuses a slot a product does not have', async () => {
      await expect(wired.kpmProducts.resetDocument(member(KPM_A), mapanId, 'poster'))
        .rejects.toThrow(/not a document slot/);
    });
  });
});
