import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { MissingTenantContextError } from '@/common/tenancy/tenant-scope.error';
import {
  ASSET_LIMITS, PRODUCT_AGE_BANDS, PRODUCT_BUDGET_BANDS, PRODUCT_LUMP_SUM_BUDGET_BAND, PRODUCT_NEEDS, PRODUCT_RUN_OFF_NOTE,
  SEED_PRODUCTS,
} from '@/domain/constants';
import { Kpm, KpmSchema } from '@/modules/tenants/kpm.schema';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { english, indonesian } from '../../../test/i18n';
import { readerIn, SOURCE_READER } from '@/common/i18n/reader';
import { configModule } from '../../../test/config-module';
import { OFFICE_0417, prototypeRender, shelf0417 } from '../../../test/sales-tools';
import { ProductCatalogService } from './product-catalog.service';

const NOW = new Date('2026-10-08T02:00:00Z');
const KPM_A = '66f0000000000000000000a1';
const KPM_B = '66f0000000000000000000b1';
const KPM_ALLIANZ = '66f0000000000000000000b2';
const KPM_BLANK = '66f0000000000000000000b3';
const PRUDENTIAL = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';
const BLANK = '66f0000000000000000000c3';

/** A field member of an office, signed in as themselves. `status` other than active holds no hierarchy grant. */
const agent = (kpmId: string, over: Record<string, unknown> = {}) =>
  new RequestContext(`u-${kpmId}`, 'none', {
    membershipId: `mem-${kpmId}`, kpmId, orgLevelCode: 'AGENT', hierarchyRole: 'agent',
    status: 'active', isKpmOwner: false, isKpmAdmin: false, directCount: 0, ...over,
  } as never).withReader(SOURCE_READER); // the API's English, as `english(...)` reads it: nobody's choice is Indonesian
/** The office's Owner, who writes its decisions on the settings screen. */
const owner = (kpmId: string) => agent(kpmId, { orgLevelCode: 'AB', hierarchyRole: 'ab', isKpmOwner: true });
const superAdmin = () => RequestContext.platform('root');

/** Every key of a JSON value, however deep — to prove what a payload does **not** carry. */
function keysOf(value: unknown): Set<string> {
  const keys = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        keys.add(k);
        walk(v);
      }
    }
  };
  walk(JSON.parse(JSON.stringify(value)));
  return keys;
}

/**
 * **The field reads of the office's shelf, and their isolation** (P14-T7 AC-3, AC-6, AC-7, AC-12;
 * P14-T8 AC-4, AC-9, AC-12; exit criteria 1, 2 and 3).
 *
 * Over the real services and a real database: the company's catalog seeded into two companies with the
 * same 31 codes, two offices of one company deciding differently, and an office of a company created
 * blank. Each claim the phase makes about *who reads what* is asserted here on the service; the HTTP
 * spec beside it asserts who the guard lets in.
 */
describe('the Product Catalog and the Sales Attack Plan, read by an office’s members (Phase 14)', () => {
  let wired: ReturnType<typeof configModule>;
  let service: ProductCatalogService;
  const ids: Record<string, string> = {};
  const allianzIds: Record<string, string> = {};

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    service = new ProductCatalogService(wired.kpmProducts, wired.clock);
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await (wired.companies as { create: (d: unknown) => Promise<unknown> }).create([
      { _id: PRUDENTIAL, name: 'Prudential', slug: 'prudential' },
      { _id: ALLIANZ, name: 'Allianz Life', slug: 'allianz' },
      { _id: BLANK, name: 'Sejahtera Baru Life', slug: 'sejahtera' },
    ]);
    const office = (_id: string, companyId: string, code: string) =>
      ({ _id, companyId, code, branchName: code, timezone: 'Asia/Jakarta' });
    await mongoose.model(Kpm.name, KpmSchema).create([
      office(KPM_A, PRUDENTIAL, '0417'), office(KPM_B, PRUDENTIAL, '0555'),
      office(KPM_ALLIANZ, ALLIANZ, '0999'), office(KPM_BLANK, BLANK, '0701'),
    ]);
    await wired.products.seedForCompany(PRUDENTIAL);
    await wired.products.seedForCompany(ALLIANZ);
    for (const p of await wired.products.list(PRUDENTIAL, { withCommission: false })) ids[p.code] = p.id;
    for (const p of await wired.products.list(ALLIANZ, { withCommission: false })) allianzIds[p.code] = p.id;
  });

  /** 0417's shelf-moving decisions, as the seed writes them: PRUSmart Plan off, PGB kept on. */
  async function decide0417() {
    for (const code of OFFICE_0417.off) await wired.kpmProducts.setActive(owner(KPM_A), ids[code], false);
    for (const code of OFFICE_0417.on) await wired.kpmProducts.setActive(owner(KPM_A), ids[code], true);
  }

  /**
   * P5-T5's and P5-T10's five decisions: renamed, turned off, pending, approved-then-edited, sent back — as
   * `demo.ts` wrote them for 0417 and 0555 until P18.7-T6, which dropped its placeholder rename (UI-023).
   */
  async function fiveStates(kpmId: string) {
    const ctx = owner(kpmId);
    await wired.kpmProducts.saveOverrides(ctx, ids.PRUMAPAN, { displayName: 'PRUMapan BSD' });
    await wired.kpmProducts.setActive(ctx, ids.PRUSMART_PLAN, false);
    await wired.kpmProducts.saveOverrides(ctx, ids.PRUFUTURE, {
      opening: 'Halo Pak/Bu, boleh saya cerita sebentar soal proteksi keluarga?',
    });
    await wired.kpmProducts.saveOverrides(ctx, ids.PRUWARISAN, {
      opening: 'Halo Pak/Bu, boleh saya cerita sebentar soal dana pendidikan?',
    });
    await wired.kpmProducts.approveScript(ctx, ids.PRUWARISAN);
    await wired.kpmProducts.saveOverrides(ctx, ids.PRUWARISAN, {
      opening: 'Halo Pak/Bu, ada waktu lima menit? Saya ingin cerita soal dana pendidikan.',
    });
    await wired.kpmProducts.saveOverrides(ctx, ids.PRUANUGERAH, { fullScript: 'Produk ini pasti untung besar, dijamin.' });
    await wired.kpmProducts.rejectScript(ctx, ids.PRUANUGERAH, 'Klaim "pasti untung" melebihi ilustrasi resmi.');
  }

  const codes = async (kpmId: string) => (await service.catalog(agent(kpmId))).products.map((p) => p.code);

  describe('the office’s shelf (D-shelf; P14-T7 AC-3, exit criterion 1)', () => {
    it('P14-T7 AC-3 lists what the office keeps on, in the company’s order, under its display names', async () => {
      await fiveStates(KPM_A);
      await decide0417();
      const { products } = await service.catalog(agent(KPM_A));

      expect(products.map((p) => p.code)).toEqual(shelf0417().map((p) => p.code));
      expect(products[0]).toEqual({
        code: 'PRUMAPAN', name: 'PRUMapan BSD',
        tagline: 'Endowment-style life with guaranteed retirement payouts from age 55.',
        category: { code: 'life', label: 'Life' }, channel: 'conventional', lifecycle: 'active', needs: ['retirement'],
        currencies: ['IDR'],
      });
    });

    it('P14-T7 AC-3 leaves out a product the office turned off, and one in run-off it never turned on', async () => {
      await decide0417();
      const shelf = await codes(KPM_A);
      expect(shelf).not.toContain('PRUSMART_PLAN');
      expect(shelf).not.toContain('PRULINK_SYARIAH_GENERASI_BARU_PSGB');
    });

    it('P14-T7 AC-3 lists a run-off product the office keeps on, marked by its lifecycle', async () => {
      await decide0417();
      const pgb = (await service.catalog(agent(KPM_A))).products.find((p) => p.code === 'PRULINK_GENERASI_BARU_PGB');
      expect(pgb).toMatchObject({ lifecycle: 'closed_to_new_business', category: { code: 'investment', label: 'Investment-linked' } });
    });

    it('exit criterion 1: two offices of one company each read their own decisions', async () => {
      await fiveStates(KPM_A);
      await decide0417();

      const b = (await service.catalog(agent(KPM_B))).products;
      // 0555 decided nothing: the company's defaults, the company's names, no run-off product.
      expect(b.map((p) => p.code)).toContain('PRUSMART_PLAN');
      expect(b.map((p) => p.code)).not.toContain('PRULINK_GENERASI_BARU_PGB');
      expect(b.find((p) => p.code === 'PRUMAPAN')!.name).toBe('PRUMapan');
      await expect(service.product(agent(KPM_B), 'PRULINK_GENERASI_BARU_PGB')).rejects.toMatchObject({ status: 404 });
      expect((await service.product(agent(KPM_A), 'PRULINK_GENERASI_BARU_PGB')).lifecycle).toBe('closed_to_new_business');
    });

    it('exit criterion 1: a product the company withdraws is gone from every office’s next read, with no office action', async () => {
      await wired.kpmProducts.setActive(owner(KPM_A), ids.PRUSEHAT, true);
      expect(await codes(KPM_A)).toContain('PRUSEHAT');

      await wired.products.setLifecycle(superAdmin(), PRUDENTIAL, ids.PRUSEHAT, 'withdrawn');

      expect(await codes(KPM_A)).not.toContain('PRUSEHAT');
      expect(await codes(KPM_B)).not.toContain('PRUSEHAT');
      await expect(service.product(agent(KPM_A), 'PRUSEHAT')).rejects.toMatchObject({ status: 404 });
      const plan = await service.attackPlan(agent(KPM_A), { need: 'health', age: 2, budget: 2 });
      expect([plan.product!.code, ...plan.alternatives.map((a) => a.code)]).not.toContain('PRUSEHAT');
    });

    it('P14-T7 AC-10 an office of a blank company has an empty shelf — a state, not an error', async () => {
      expect(await service.catalog(agent(KPM_BLANK))).toEqual({ products: [] });
      expect(await service.attackPlan(agent(KPM_BLANK), { need: 'health', age: 2, budget: 2 })).toEqual({
        brief: { need: 'health', age: 2, budget: 2 },
        product: null, verdict: null, outside: [], alternatives: [], moreCount: 0, shelfEmpty: true,
      });
    });

    it('P14-T7 AC-10 an office that keeps nothing on has an empty shelf too', async () => {
      for (const id of Object.values(ids)) {
        await wired.kpmProducts.setActive(owner(KPM_B), id, false);
      }
      expect(await codes(KPM_B)).toEqual([]);
      // The plan says so with its answer, so the screen draws the empty shelf without reading the catalog.
      expect((await service.attackPlan(agent(KPM_B), { need: 'health', age: 2, budget: 2 })).shelfEmpty).toBe(true);
      expect((await service.attackPlan(agent(KPM_A), { need: 'health', age: 2, budget: 2 })).shelfEmpty).toBe(false);
    });
  });

  describe('company isolation (P14-T7 AC-12; the 31 codes exist in both seeded companies)', () => {
    it('P14-T7 AC-12 a code both companies hold answers the reader’s company’s row', async () => {
      await wired.products.update(superAdmin(), ALLIANZ, allianzIds.PRUMAPAN, { tagline: 'Allianz’s own sentence.' });

      expect((await service.product(agent(KPM_ALLIANZ), 'PRUMAPAN')).tagline).toBe('Allianz’s own sentence.');
      expect((await service.product(agent(KPM_A), 'PRUMAPAN')).tagline)
        .toBe('Endowment-style life with guaranteed retirement payouts from age 55.');
      expect((await service.catalog(agent(KPM_A))).products.find((p) => p.code === 'PRUMAPAN')!.tagline)
        .not.toBe('Allianz’s own sentence.');
    });

    it('P14-T7 AC-12 a code of another company only is 404 on every read, never 403', async () => {
      await wired.products.create(superAdmin(), ALLIANZ, {
        code: 'ALLIANZ_ONLY', name: 'Allianz Only', channel: 'conventional', category: 'health',
        primaryNeeds: ['health'], eligibleAgeBands: [2], eligibleBudgetBands: [2], activeByDefault: true,
      });
      expect((await service.catalog(agent(KPM_ALLIANZ))).products.map((p) => p.code)).toContain('ALLIANZ_ONLY');

      await expect(service.product(agent(KPM_A), 'ALLIANZ_ONLY')).rejects.toMatchObject({ status: 404 });
      await expect(service.documentUrl(agent(KPM_A), 'ALLIANZ_ONLY', 'brochure')).rejects.toMatchObject({ status: 404 });
      await expect(service.attackPlan(agent(KPM_A), { need: 'health', age: 2, budget: 2 }, 'ALLIANZ_ONLY'))
        .rejects.toMatchObject({ status: 404 });
      expect(await codes(KPM_A)).not.toContain('ALLIANZ_ONLY');
    });

    it('P14-T7 AC-12 a code nobody holds is 404, the same answer', async () => {
      await expect(service.product(agent(KPM_A), 'NOT_A_PRODUCT')).rejects.toMatchObject({ status: 404 });
    });

    it('P14-T7 AC-12 refuses a Super Admin outside a support session: no office, so no shelf', async () => {
      for (const read of [
        () => service.catalog(superAdmin()),
        () => service.product(superAdmin(), 'PRUMAPAN'),
        () => service.documentUrl(superAdmin(), 'PRUMAPAN', 'brochure'),
        () => service.attackPlan(superAdmin(), { need: 'health', age: 2, budget: 2 }),
      ]) {
        await expect(read()).rejects.toBeInstanceOf(MissingTenantContextError);
      }
    });
  });

  describe('only approved words (D-api; exit criterion 2, P14-T7 AC-6, P14-T8 AC-9)', () => {
    const STATES = ['PRUMAPAN', 'PRUFUTURE', 'PRUWARISAN', 'PRUANUGERAH'] as const;

    it('exit criterion 2: for each seeded state, the drawer and the plan answer exactly what the effective read answers', async () => {
      await fiveStates(KPM_A);
      for (const code of STATES) {
        const effective = await wired.kpmProducts.effectiveScript(owner(KPM_A), ids[code]);
        const drawer = await service.product(agent(KPM_A), code);
        expect([code, drawer.script]).toEqual([code, effective.script]);
        expect([code, drawer.tagline]).toEqual([code, effective.description]);
      }
      // The plan shows its product through the same read.
      const plan = await service.attackPlan(agent(KPM_A), { need: 'legacy', age: 3, budget: 3 }, 'PRUWARISAN');
      const effective = await wired.kpmProducts.effectiveScript(owner(KPM_A), ids.PRUWARISAN);
      expect(plan.product!.script).toEqual(effective.script);
    });

    it('exit criterion 2: pending and sent-back words never reach a field read; approved-then-edited serves the approved', async () => {
      await fiveStates(KPM_A);
      const company = (code: string) => wired.products.list(PRUDENTIAL, { withCommission: false })
        .then((all) => all.find((p) => p.code === code)!.defaultAttackPlan);

      expect((await service.product(agent(KPM_A), 'PRUFUTURE')).script.opening).toBe((await company('PRUFUTURE')).opening);
      expect((await service.product(agent(KPM_A), 'PRUWARISAN')).script.opening)
        .toBe('Halo Pak/Bu, boleh saya cerita sebentar soal dana pendidikan?');
      expect((await service.product(agent(KPM_A), 'PRUANUGERAH')).script.fullScript)
        .toBe((await company('PRUANUGERAH')).fullScript);
      // The sibling office approved nothing, so it reads the company's words throughout.
      expect((await service.product(agent(KPM_B), 'PRUWARISAN')).script.opening).toBe((await company('PRUWARISAN')).opening);
    });

    it('exit criterion 2: no payload carries the office’s drafts or its review state', async () => {
      await fiveStates(KPM_A);
      await decide0417();
      const payloads = [
        await service.catalog(agent(KPM_A)),
        ...await Promise.all(STATES.map((code) => service.product(agent(KPM_A), code))),
        await service.attackPlan(agent(KPM_A), { need: 'legacy', age: 3, budget: 3 }),
        await service.attackPlan(agent(KPM_A), { need: 'retirement', age: 5, budget: 6 }, 'PRUANUGERAH'),
      ];
      const forbidden = ['overrides', 'approvedOverrides', 'reviewState', 'rejectionReason', 'reviewedByMembershipId', 'storageKey'];
      for (const payload of payloads) {
        const keys = keysOf(payload);
        expect(forbidden.filter((k) => keys.has(k))).toEqual([]);
      }
      // And no draft's words, anywhere.
      const text = JSON.stringify(payloads);
      expect(text).not.toContain('ada waktu lima menit');
      expect(text).not.toContain('pasti untung besar');
      expect(text).not.toContain('soal proteksi keluarga');
    });

    it('P14-T7 AC-8 the office’s description reaches agents only once approved, in place of the tagline everywhere', async () => {
      const ctx = owner(KPM_A);
      await wired.kpmProducts.saveOverrides(ctx, ids.PRUMAPAN, { description: 'Pensiun tenang mulai Rp200 ribu sebulan.' });
      const tagline = 'Endowment-style life with guaranteed retirement payouts from age 55.';
      // Pending: the company's tagline on the card, the drawer and the plan.
      expect((await service.catalog(agent(KPM_A))).products[0].tagline).toBe(tagline);
      expect((await service.product(agent(KPM_A), 'PRUMAPAN')).tagline).toBe(tagline);

      await wired.kpmProducts.approveScript(ctx, ids.PRUMAPAN);
      const approved = 'Pensiun tenang mulai Rp200 ribu sebulan.';
      expect((await service.catalog(agent(KPM_A))).products[0].tagline).toBe(approved);
      expect((await service.product(agent(KPM_A), 'PRUMAPAN')).tagline).toBe(approved);
      const plan = await service.attackPlan(agent(KPM_A), { need: 'retirement', age: 2, budget: 2 });
      expect([plan.product!.code, plan.product!.tagline]).toEqual(['PRUMAPAN', approved]);
      // Another office of the company reads the company's sentence.
      expect((await service.product(agent(KPM_B), 'PRUMAPAN')).tagline).toBe(tagline);
    });
  });

  describe('one product, as the drawer reads it (P14-T7 AC-5, AC-6)', () => {
    it('P14-T7 AC-5 carries the company’s details, the bands by label, and no run-off note for an active product', async () => {
      const mapan = await service.product(agent(KPM_A), 'prumapan');
      expect(mapan).toMatchObject({
        code: 'PRUMAPAN', name: 'PRUMapan', lifecycle: 'active', needs: ['retirement'],
        ageBands: ['< 25', '25–34', '35–49'], budgetBands: ['< Rp 500 rb', 'Rp 500 rb–Rp 2 Jt', 'Rp 2 Jt–Rp 5 Jt'],
        runOffNote: null, successorCode: null,
      });
      expect(mapan.benefits.length).toBeGreaterThan(0);
      expect(mapan.differentiator).toMatch(/^The accessible retirement-income option/);
      expect(mapan.bestFit).toMatch(/^Sandwich-generation/);
      // The one pair became a list of cards in P19.4-T4 (ADR-0209 §9).
      expect(Object.keys(mapan.script)).toEqual([
        'goodFit', 'opening', 'benefits', 'fullScript', 'objections', 'nextAction',
      ]);
    });

    it('P18.10-T7 a band that is a word, *Lump-sum*, is written for the reader; a range of sums reads the same', async () => {
      const lumpSum = SEED_PRODUCTS.find((p) => p.activeByDefault && p.eligibleBudgetBands.includes(PRODUCT_LUMP_SUM_BUDGET_BAND))!;
      const english = await service.product(agent(KPM_A), lumpSum.code);
      const inIndonesian = await service.product(agent(KPM_A).withReader(readerIn('id')), lumpSum.code);
      expect(english.budgetBands).toContain('Lump-sum');
      expect(inIndonesian.budgetBands).toContain('Sekaligus');
      expect(inIndonesian.budgetBands).not.toContain('Lump-sum');
      expect(inIndonesian.budgetBands.filter((b) => b !== 'Sekaligus'))
        .toEqual(english.budgetBands.filter((b) => b !== 'Lump-sum'));
      expect(inIndonesian.documents.map((d) => d.label)).toEqual(['Brosur', 'Ilustrasi / Simulasi', 'Dokumen produk']);
      expect(english.documents.map((d) => d.label)).toEqual(['Brochure', 'Illustration / Simulation', 'Product Document']);
    });

    it('P14-T7 AC-5 a run-off product carries the drawer’s note, its blank script, and its successor’s code', async () => {
      await decide0417();
      await wired.products.setLifecycle(
        superAdmin(), PRUDENTIAL, ids.PRULINK_GENERASI_BARU_PGB, 'closed_to_new_business', ids.PRULINK_NEXTGEN,
      );
      const pgb = await service.product(agent(KPM_A), 'PRULINK_GENERASI_BARU_PGB');
      expect(pgb.runOffNote).toBe(english(PRODUCT_RUN_OFF_NOTE));
      // P18.10-T5 AC-4: written for the reader — an Indonesian one reads it in Indonesian.
      const inIndonesian = await service.product(agent(KPM_A).withReader(readerIn('id')), 'PRULINK_GENERASI_BARU_PGB');
      expect(inIndonesian.runOffNote).toBe(indonesian(PRODUCT_RUN_OFF_NOTE));
      expect(inIndonesian.runOffNote).toMatch(/^Dalam masa run-off/);
      expect(pgb.script.fullScript).toBe('');
      expect(pgb.successorCode).toBe('PRULINK_NEXTGEN');
    });

    it('P14-T7 AC-5 sends the company’s commission schedule, by year, to a reader holding the grant — empty while unset, never a default', async () => {
      expect((await service.product(agent(KPM_A), 'PRUMAPAN')).commissionSchedule).toEqual([]);

      await wired.products.update(superAdmin(), PRUDENTIAL, ids.PRUMAPAN, {
        commissionSchedule: [{ year: 2, rate: 0.2 }, { year: 1, rate: 0.4 }],
      });
      expect((await service.product(agent(KPM_A), 'PRUMAPAN')).commissionSchedule)
        .toEqual([{ year: 1, rate: 0.4 }, { year: 2, rate: 0.2 }]);
      const plan = await service.attackPlan(agent(KPM_A), { need: 'retirement', age: 2, budget: 2 });
      expect(plan.product!.commissionSchedule).toEqual([{ year: 1, rate: 0.4 }, { year: 2, rate: 0.2 }]);
    });

    it('P14-T7 AC-5 leaves the schedule out entirely for a reader without commission_rates:read', async () => {
      await wired.products.update(superAdmin(), PRUDENTIAL, ids.PRUMAPAN, { commissionSchedule: [{ year: 1, rate: 0.4 }] });
      // A member who is not active holds no hierarchy grant at all — the one reader of the service the
      // guard would let through without it is none, so the service's own rule is asserted here.
      const without = agent(KPM_A, { status: 'pending' });
      const mapan = await service.product(without, 'PRUMAPAN');
      expect('commissionSchedule' in mapan).toBe(false);
    });
  });

  describe('documents (P14-T7 AC-7)', () => {
    const officeUpload = async (ctx: RequestContext) => {
      const signed = await wired.assets.requestUpload(ctx, {
        folder: 'products', filename: 'brochure.pdf', mimeType: 'application/pdf', bytes: 1024,
      });
      await wired.assets.confirmUpload(ctx, signed.storageKey);
      return signed.storageKey;
    };
    const companyDocument = async (code: string, slot: string) => {
      const signed = await wired.assets.requestCompanyUpload(PRUDENTIAL, {
        folder: 'products', filename: 'illustration.pdf', mimeType: 'application/pdf', bytes: 2048,
      });
      await wired.assets.confirmCompanyUpload(PRUDENTIAL, signed.storageKey);
      await mongoose.connection.db!.collection('products').updateOne(
        { _id: new mongoose.Types.ObjectId(ids[code]) },
        { $set: { [`defaultDocuments.${slot}`]: { storageKey: signed.storageKey, label: 'Ilustrasi', mimeType: 'application/pdf', bytes: 2048 } } },
      );
    };

    it('P14-T7 AC-7 says which slots can be opened, in their order, the office’s file else the company’s', async () => {
      const ctx = owner(KPM_A);
      await wired.kpmProducts.setDocument(ctx, ids.PRUMAPAN, 'brochure', { storageKey: await officeUpload(ctx), label: 'Brosur' });
      await companyDocument('PRUMAPAN', 'illustration');

      expect((await service.product(agent(KPM_A), 'PRUMAPAN')).documents).toEqual([
        // P19.6-T2: each says what it holds, so an HTML page is drawn in the frame and never opened in a tab.
        { slot: 'brochure', label: 'Brochure', available: true, mimeType: 'application/pdf' },
        { slot: 'illustration', label: 'Illustration / Simulation', available: true, mimeType: 'application/pdf' },
        { slot: 'productDoc', label: 'Product Document', available: false, mimeType: null },
      ]);
    });

    it('P14-T7 AC-7 signs a link valid 300 seconds from the office’s file, else the company’s; 404 when neither', async () => {
      const ctx = owner(KPM_A);
      const key = await officeUpload(ctx);
      await wired.kpmProducts.setDocument(ctx, ids.PRUMAPAN, 'brochure', { storageKey: key, label: 'Brosur' });
      await companyDocument('PRUMAPAN', 'illustration');

      const own = await service.documentUrl(agent(KPM_A), 'PRUMAPAN', 'brochure');
      expect(own).toEqual({
        url: `https://cdn.test/${key}?sig=abc`,
        expiresAt: new Date(NOW.getTime() + ASSET_LIMITS.SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
      });
      expect(ASSET_LIMITS.SIGNED_URL_TTL_SECONDS).toBe(300);
      expect((await service.documentUrl(agent(KPM_A), 'PRUMAPAN', 'illustration')).url).toMatch(/company\//);
      await expect(service.documentUrl(agent(KPM_A), 'PRUMAPAN', 'productDoc')).rejects.toMatchObject({ status: 404 });
    });

    it('P14-T7 AC-7 another office’s file is not this office’s: its slot is 404 here', async () => {
      const ctxB = owner(KPM_B);
      await wired.kpmProducts.setDocument(ctxB, ids.PRUMAPAN, 'brochure', { storageKey: await officeUpload(ctxB), label: 'B' });

      expect((await service.product(agent(KPM_B), 'PRUMAPAN')).documents[0].available).toBe(true);
      expect((await service.product(agent(KPM_A), 'PRUMAPAN')).documents[0].available).toBe(false);
      await expect(service.documentUrl(agent(KPM_A), 'PRUMAPAN', 'brochure')).rejects.toMatchObject({ status: 404 });
    });

    it('P14-T7 AC-7 signs nothing for a product the office does not keep on', async () => {
      await companyDocument('PRUSMART_PLAN', 'brochure');
      expect((await service.documentUrl(agent(KPM_A), 'PRUSMART_PLAN', 'brochure')).url).toMatch(/company\//);

      await wired.kpmProducts.setActive(owner(KPM_A), ids.PRUSMART_PLAN, false);
      await expect(service.documentUrl(agent(KPM_A), 'PRUSMART_PLAN', 'brochure')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('the plan, through the service (D-scoring; P14-T8 AC-4, AC-5, exit criterion 3)', () => {
    const BRIEFS = PRODUCT_NEEDS.flatMap((need) =>
      PRODUCT_AGE_BANDS.flatMap((age) => PRODUCT_BUDGET_BANDS.map((budget) => ({ need, age, budget }))));

    it('exit criterion 3: all 280 briefs over 0417’s shelf equal the prototype’s findMatches in sortOrder', async () => {
      await fiveStates(KPM_A);
      await decide0417();
      const prototype = shelf0417();
      const ctx = agent(KPM_A);
      const drift: string[] = [];
      for (const brief of BRIEFS) {
        const plan = await service.attackPlan(ctx, brief);
        const ours = {
          top: plan.product?.code ?? null, verdict: plan.verdict,
          alternatives: plan.alternatives.map((a) => a.code), more: plan.moreCount,
        };
        const theirs = prototypeRender(prototype, brief);
        if (JSON.stringify(ours) !== JSON.stringify(theirs)) drift.push(`${JSON.stringify(brief)}: ${JSON.stringify(ours)} ≠ ${JSON.stringify(theirs)}`);
      }
      expect(BRIEFS).toHaveLength(280);
      expect(drift).toEqual([]);
    });

    it('P14-T8 AC-4 a product the office turned off is never a candidate there, and is in its sibling office', async () => {
      await decide0417();
      const brief = { need: 'life-protection', age: 3, budget: 4 } as const;
      const a = await service.attackPlan(agent(KPM_A), brief);
      const b = await service.attackPlan(agent(KPM_B), brief);
      expect([a.product!.code, ...a.alternatives.map((x) => x.code)]).not.toContain('PRUSMART_PLAN');
      expect(b.product!.code).toBe('PRUSMART_PLAN');
    });

    it('P14-T8 AC-3 answers the result card’s facts: the display name, the verdict and what is outside', async () => {
      await fiveStates(KPM_A);
      const good = await service.attackPlan(agent(KPM_A), { need: 'retirement', age: 2, budget: 2 });
      expect(good).toMatchObject({
        brief: { need: 'retirement', age: 2, budget: 2 },
        product: { code: 'PRUMAPAN', name: 'PRUMapan BSD' },
        verdict: 'good_fit', outside: [], alternatives: [{ code: 'PRUANUGERAH', name: 'PRUAnugerah' }], moreCount: 0,
      });
      const check = await service.attackPlan(agent(KPM_A), { need: 'retirement', age: 5, budget: 6 });
      expect([check.product!.code, check.verdict, check.outside]).toEqual(['PRUANUGERAH', 'check_fit', ['age']]);
    });

    it('P14-T8 AC-5 a switch re-fits the chosen product, keeps the list, and names the alternatives as the office does', async () => {
      await fiveStates(KPM_A);
      const switched = await service.attackPlan(agent(KPM_A), { need: 'retirement', age: 2, budget: 2 }, 'pruanugerah');
      expect(switched).toMatchObject({
        product: { code: 'PRUANUGERAH' }, verdict: 'check_fit', outside: ['age', 'budget'],
        alternatives: [{ code: 'PRUMAPAN', name: 'PRUMapan BSD' }], moreCount: 0,
      });
    });

    it('P14-T8 AC-5 a switch to a product that does not match the brief is not found', async () => {
      await expect(service.attackPlan(agent(KPM_A), { need: 'retirement', age: 2, budget: 2 }, 'PRUSEHAT'))
        .rejects.toMatchObject({ status: 404 });
    });

    it('P14-T8 AC-3 no product the office keeps on serves the need: nothing shown, nothing to switch to', async () => {
      await wired.kpmProducts.setActive(owner(KPM_A), ids.PRUCERAH, false);
      expect(await service.attackPlan(agent(KPM_A), { need: 'education', age: 2, budget: 2 })).toEqual({
        brief: { need: 'education', age: 2, budget: 2 },
        // Nothing serves the need, but the shelf is not empty: the screen says *no match*, not *no shelf*.
        product: null, verdict: null, outside: [], alternatives: [], moreCount: 0, shelfEmpty: false,
      });
    });

    it('P14-T8 AC-6 a run-off product is never recommended, though the office keeps it on', async () => {
      await decide0417();
      const plan = await service.attackPlan(agent(KPM_A), { need: 'investment', age: 3, budget: 4 });
      expect([plan.product!.code, ...plan.alternatives.map((a) => a.code)]).not.toContain('PRULINK_GENERASI_BARU_PGB');
      await expect(service.attackPlan(agent(KPM_A), { need: 'investment', age: 3, budget: 4 }, 'PRULINK_GENERASI_BARU_PGB'))
        .rejects.toMatchObject({ status: 404 });
    });

    it('writes nothing: a plan leaves no row behind (OD-133)', async () => {
      const before = await mongoose.connection.db!.listCollections().toArray();
      const counts = async () => Object.fromEntries(await Promise.all(before.map(async (c) =>
        [c.name, await mongoose.connection.db!.collection(c.name).countDocuments()] as const)));
      const was = await counts();
      await service.attackPlan(agent(KPM_A), { need: 'health', age: 2, budget: 2 });
      await service.catalog(agent(KPM_A));
      await service.product(agent(KPM_A), 'PRUMAPAN');
      expect(await counts()).toEqual(was);
    });
  });
});
