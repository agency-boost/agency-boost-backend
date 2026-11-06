import { NotFoundException } from '@/common/errors/domain.exception';
import mongoose from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { SEED_PRODUCTS } from '@/domain/constants';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import type { ProductService } from './product.service';

const NOW = new Date('2026-09-18T02:00:00Z');
const PRUDENTIAL = '66f0000000000000000000c1';
const ALLIANZ = '66f0000000000000000000c2';

/** Super Admin belongs to no office, which is exactly why a product carries no `kpmId`. */
const superAdmin = () => new RequestContext('sa1', 'super_admin', null);

/**
 * A company's product catalog (P5-T4, ADR-0033).
 *
 * Named as the module's isolation spec: `products` is **company-partitioned**, so the boundary
 * this proves is `companyId`, not `kpmId`. A read that crossed it would put Allianz's shelf in
 * front of a Prudential office.
 */
describe('the company product catalog (P5-T4)', () => {
  let wired: ReturnType<typeof configModule>;
  let products: ProductService;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    products = wired.products;
  });
  afterAll(stopMongo);

  beforeEach(async () => {
    await clearCollections();
    await (wired.companies as mongoose.Model<never>).create([
      { _id: PRUDENTIAL, name: 'Prudential Indonesia', slug: 'prudential-indonesia' },
      { _id: ALLIANZ, name: 'Allianz Life', slug: 'allianz-life' },
    ] as never);
    await products.seedForCompany(PRUDENTIAL);
  });

  const byCode = async (companyId: string, code: string) => {
    const all = await products.list(companyId, { withCommission: true });
    return all.find((p) => p.code === code)!;
  };

  describe('the seed (AC-1)', () => {
    it('gives a company the 31 products, in order, owned from then on', async () => {
      const shelf = await products.list(PRUDENTIAL, { withCommission: true });

      expect(shelf).toHaveLength(31);
      expect(shelf.map((p) => p.sortOrder)).toEqual(SEED_PRODUCTS.map((p) => p.sortOrder));
      expect(shelf.every((p) => p.companyId === PRUDENTIAL)).toBe(true);
    });

    it('seeds no commission schedule, ever (parity F-15)', async () => {
      const shelf = await products.list(PRUDENTIAL, { withCommission: true });

      // The prototype's drawer invents 40% / 20%. A figure an agent reads as their pay is the
      // company's to state, and "not set" is the honest answer until it does.
      expect(shelf.every((p) => p.commissionSchedule!.length === 0)).toBe(true);
    });

    it('leaves a company that already has products alone', async () => {
      await products.create(superAdmin(), ALLIANZ, {
        code: 'ALZ_ONE', name: 'Allianz One', channel: 'conventional', category: 'life',
      });

      expect(await products.seedForCompany(ALLIANZ)).toBe(0);
      expect(await products.list(ALLIANZ, { withCommission: true })).toHaveLength(1);
    });
  });

  describe('isolation', () => {
    it('reads only the company named, never another company’s shelf', async () => {
      await products.seedForCompany(ALLIANZ);
      await products.update(
        superAdmin(), ALLIANZ, (await byCode(ALLIANZ, 'PRUMAPAN')).id, { name: 'Allianz Mapan' },
      );

      const prudential = await byCode(PRUDENTIAL, 'PRUMAPAN');
      expect(prudential.name).toBe('PRUMapan');
      expect((await byCode(ALLIANZ, 'PRUMAPAN')).name).toBe('Allianz Mapan');
    });

    it('refuses to write another company’s product as a 404, not a 403', async () => {
      const mine = await byCode(PRUDENTIAL, 'PRUMAPAN');

      // A 403 would confirm the id exists, which is the thing the boundary is hiding.
      await expect(products.update(superAdmin(), ALLIANZ, mine.id, { name: 'x' }))
        .rejects.toThrow(NotFoundException);
      await expect(products.setLifecycle(superAdmin(), ALLIANZ, mine.id, 'withdrawn'))
        .rejects.toThrow(NotFoundException);
    });

    it('refuses a catalog for a company that does not exist', async () => {
      await expect(products.list('66f0000000000000000000ff', { withCommission: true }))
        .rejects.toThrow(NotFoundException);
    });

    it('lets two companies hold the same code, because a code is unique within a company', async () => {
      await products.seedForCompany(ALLIANZ);

      expect((await byCode(PRUDENTIAL, 'PRUMAPAN')).id)
        .not.toBe((await byCode(ALLIANZ, 'PRUMAPAN')).id);
    });
  });

  describe('the code is the identity (AC-2)', () => {
    it('refuses a code the company already uses', async () => {
      await expect(products.create(superAdmin(), PRUDENTIAL, {
        code: 'prumapan', name: 'Another', channel: 'conventional', category: 'life',
      })).rejects.toThrow(/already has a product with the code PRUMAPAN/);
    });

    it('refuses a code a withdrawn product still holds', async () => {
      const mapan = await byCode(PRUDENTIAL, 'PRUMAPAN');
      await products.setLifecycle(superAdmin(), PRUDENTIAL, mapan.id, 'withdrawn');

      // Reusing a retired code would change the meaning of every policy still pointing at it.
      await expect(products.create(superAdmin(), PRUDENTIAL, {
        code: 'PRUMAPAN', name: 'Reborn', channel: 'conventional', category: 'life',
      })).rejects.toThrow(/never reused/);
    });

    it('never changes a code on update, whatever the body carries', async () => {
      const mapan = await byCode(PRUDENTIAL, 'PRUMAPAN');

      const updated = await products.update(
        superAdmin(), PRUDENTIAL, mapan.id,
        { code: 'SOMETHING_ELSE', name: 'PRUMapan Plus' } as never,
      );

      expect(updated.code).toBe('PRUMAPAN');
      expect(updated.name).toBe('PRUMapan Plus');
    });

    it('upper-cases a code as it is typed, and appends the product to the shelf', async () => {
      const created = await products.create(superAdmin(), PRUDENTIAL, {
        code: 'pru_baru', name: 'PRUBaru', channel: 'syariah', category: 'health',
      });

      expect(created.code).toBe('PRU_BARU');
      expect(created.sortOrder).toBe(32);
      expect(created.lifecycle).toBe('active');
      expect(created.version).toBe(1);
    });
  });

  describe('lifecycle (AC-4, AC-5)', () => {
    it('moves a product through its three transitions, recording who and when', async () => {
      const smart = await byCode(PRUDENTIAL, 'PRUSMART_PLAN');
      const mapan = await byCode(PRUDENTIAL, 'PRUMAPAN');

      const closed = await products.setLifecycle(
        superAdmin(), PRUDENTIAL, smart.id, 'closed_to_new_business', mapan.id,
      );
      expect(closed).toMatchObject({
        lifecycle: 'closed_to_new_business', replacedByProductId: mapan.id, version: 2,
      });

      const withdrawn = await products.setLifecycle(
        superAdmin(), PRUDENTIAL, smart.id, 'withdrawn',
      );
      expect(withdrawn.lifecycle).toBe('withdrawn');

      const reopened = await products.setLifecycle(superAdmin(), PRUDENTIAL, smart.id, 'active');
      expect(reopened).toMatchObject({ lifecycle: 'active', replacedByProductId: null });
    });

    it('keeps a withdrawn product on the read, because every record that names it still renders', async () => {
      const smart = await byCode(PRUDENTIAL, 'PRUSMART_PLAN');
      await products.setLifecycle(superAdmin(), PRUDENTIAL, smart.id, 'withdrawn');

      const shelf = await products.list(PRUDENTIAL, { withCommission: true });
      expect(shelf).toHaveLength(31);
      expect(shelf.find((p) => p.id === smart.id)!.lifecycle).toBe('withdrawn');
    });

    it('refuses a successor that is not on this company’s shelf', async () => {
      await products.seedForCompany(ALLIANZ);
      const smart = await byCode(PRUDENTIAL, 'PRUSMART_PLAN');
      const theirs = await byCode(ALLIANZ, 'PRUMAPAN');

      await expect(products.setLifecycle(
        superAdmin(), PRUDENTIAL, smart.id, 'closed_to_new_business', theirs.id,
      )).rejects.toThrow(/not on this company’s shelf/);
    });

    it('is one write, which is what makes a withdrawal reach every office at once (AC-5)', async () => {
      const smart = await byCode(PRUDENTIAL, 'PRUSMART_PLAN');
      await products.setLifecycle(superAdmin(), PRUDENTIAL, smart.id, 'withdrawn');

      // Nothing is copied into an office, so there is nothing for an Owner to publish. Every
      // office of this company reads the same row, and reads it withdrawn on its next read.
      const rows = await mongoose.connection.db!
        .collection('products').countDocuments({ companyId: PRUDENTIAL });
      expect(rows).toBe(31);
      expect((await byCode(PRUDENTIAL, 'PRUSMART_PLAN')).lifecycle).toBe('withdrawn');
    });

    it('P19.4-T4 AC-13 deletes only a withdrawn product, softly: a product on sale is refused', async () => {
      // The P5-T4 rule was "no delete at all"; ADR-0209 §10 admits one for a withdrawn product nothing names.
      const mapan = await byCode(PRUDENTIAL, 'PRUMAPAN');
      await expect(products.remove(superAdmin(), PRUDENTIAL, mapan.id))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { lifecycle: 'active' } });
      expect((await products.list(PRUDENTIAL, { withCommission: true })).map((p) => p.id)).toContain(mapan.id);
    });
  });

  describe('commission (ADR-0038)', () => {
    it('leaves the schedule out entirely for a reader without commission_rates:read', async () => {
      const mapan = await byCode(PRUDENTIAL, 'PRUMAPAN');
      await products.update(superAdmin(), PRUDENTIAL, mapan.id, {
        commissionSchedule: [{ year: 1, rate: 0.4 }, { year: 2, rate: 0.2 }],
      });

      const withIt = await products.list(PRUDENTIAL, { withCommission: true });
      const without = await products.list(PRUDENTIAL, { withCommission: false });

      expect(withIt.find((p) => p.id === mapan.id)!.commissionSchedule)
        .toEqual([{ year: 1, rate: 0.4 }, { year: 2, rate: 0.2 }]);
      // Absent, not empty: no screen has to remember to hide a field it never received.
      expect(without.find((p) => p.id === mapan.id)).not.toHaveProperty('commissionSchedule');
    });
  });

  describe('the attack plan is seven fields (AC-7)', () => {
    it('stores what was sent, with markup stripped', async () => {
      const mapan = await byCode(PRUDENTIAL, 'PRUMAPAN');

      const updated = await products.update(superAdmin(), PRUDENTIAL, mapan.id, {
        defaultAttackPlan: {
          goodFit: 'Young families',
          opening: '<b>Halo</b>, boleh saya tanya sebentar?',
          benefits: ['<i>Proteksi</i> jiwa', '  ', 'Dana pendidikan'],
          fullScript: 'Halo. <br>Ini scriptnya.',
          objections: [
            { objection: '<b>Terlalu</b> mahal.', answer: 'Preminya bisa disesuaikan.\n\nMulai Rp 200 rb.' },
            // Neither side written: dropped, as a blank bullet is (P19.4-T4 AC-1).
            { objection: '  ', answer: '' },
          ],
          nextAction: 'Boleh saya siapkan ilustrasinya?',
        },
      });

      expect(updated.defaultAttackPlan).toEqual({
        goodFit: 'Young families',
        opening: 'Halo, boleh saya tanya sebentar?',
        // The blank line goes: an empty bullet is a bullet an agent reads as a missing benefit.
        benefits: ['Proteksi jiwa', 'Dana pendidikan'],
        // A pasted `<br>` is the line break it meant since P19-T6 (AC-1, B1-2): the script keeps its lines.
        fullScript: 'Halo.\nIni scriptnya.',
        // The objections are cards, each side keeping its lines (P19.4-T4 AC-1, ADR-0209 §9).
        objections: [{ objection: 'Terlalu mahal.', answer: 'Preminya bisa disesuaikan.\n\nMulai Rp 200 rb.' }],
        nextAction: 'Boleh saya siapkan ilustrasinya?',
      });
    });

    it('sanitises the product’s own benefits, and takes the activeByDefault flag', async () => {
      const mapan = await byCode(PRUDENTIAL, 'PRUMAPAN');

      const updated = await products.update(superAdmin(), PRUDENTIAL, mapan.id, {
        benefits: ['<b>Santunan</b> meninggal', '', 'Nilai tunai'],
        // What an office sells before its Owner has an opinion about it (ADR-0033).
        activeByDefault: false,
      });

      expect(updated.benefits).toEqual(['Santunan meninggal', 'Nilai tunai']);
      expect(updated.activeByDefault).toBe(false);
    });

    it('refuses an update that changes nothing', async () => {
      const mapan = await byCode(PRUDENTIAL, 'PRUMAPAN');

      await expect(products.update(superAdmin(), PRUDENTIAL, mapan.id, {}))
        .rejects.toThrow(/nothing to change/i);
    });
  });

  describe('order is presentation', () => {
    it('renumbers the whole shelf and bumps no version', async () => {
      const shelf = await products.list(PRUDENTIAL, { withCommission: true });
      const reversed = [...shelf].reverse().map((p) => p.id);

      const after = await products.reorder(superAdmin(), PRUDENTIAL, reversed);

      expect(after.map((p) => p.id)).toEqual(reversed);
      expect(after.map((p) => p.sortOrder)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
      expect(after.every((p) => p.version === 1)).toBe(true);
    });

    it('refuses a partial order, so two people dragging cannot interleave', async () => {
      const shelf = await products.list(PRUDENTIAL, { withCommission: true });

      await expect(products.reorder(superAdmin(), PRUDENTIAL, [shelf[0].id]))
        .rejects.toThrow(/31 of them/);
      await expect(products.reorder(
        superAdmin(), PRUDENTIAL, [shelf[0].id, ...shelf.slice(0, 30).map((p) => p.id)],
      )).rejects.toThrow(/once each/);
    });
  });
});
