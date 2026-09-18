import mongoose from 'mongoose';
import { SEED_PRODUCTS } from '@/domain/constants';

/**
 * Give every company that already exists the catalog a new one is created with (P5-T4, ADR-0033).
 *
 * `TenantService.createCompany` seeds a company at creation; this is the same 31 products for the
 * companies that predate the feature. The catalog belongs to the company from the moment it lands:
 * nothing here ever runs over it again.
 *
 * **Idempotent per company, not per run.** A company that already has a product is skipped whole —
 * not topped up — because a Super Admin who has withdrawn a seeded product should not find it back
 * on the shelf after a deployment.
 */
export async function up(
  db: mongoose.mongo.Db,
  now: Date,
): Promise<{ seeded: number; products: number; skipped: number }> {
  const companies = db.collection('companies');
  const products = db.collection('products');

  const rows = await companies.find({ deletedAt: null }, { projection: { _id: 1 } }).toArray();
  let seeded = 0;
  let skipped = 0;

  for (const company of rows) {
    const companyId = String(company._id);
    if (await products.findOne({ companyId, deletedAt: null })) {
      skipped += 1;
      continue;
    }

    // Timestamps by hand: this insert has no Mongoose in between to stamp it.
    await products.insertMany(SEED_PRODUCTS.map((product) => ({
      ...product,
      primaryNeeds: [...product.primaryNeeds],
      eligibleAgeBands: [...product.eligibleAgeBands],
      eligibleBudgetBands: [...product.eligibleBudgetBands],
      benefits: [...product.benefits],
      defaultAttackPlan: {
        ...product.defaultAttackPlan,
        benefits: [...product.defaultAttackPlan.benefits],
      },
      companyId,
      // The company states its own rates. Seeding a figure an agent reads as their pay is the
      // defect parity F-15 records, not a convenience.
      commissionSchedule: [],
      replacedByProductId: null,
      lifecycleChangedAt: null,
      lifecycleChangedBy: null,
      version: 1,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
      createdAt: now,
      updatedAt: now,
    })));
    seeded += 1;
  }

  return { seeded, products: seeded * SEED_PRODUCTS.length, skipped };
}
