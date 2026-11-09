import mongoose from 'mongoose';
import { SEED_PRODUCTS } from '@/domain/constants';

/**
 * *4b · If they push back — you say* becomes the reply the prototype renders (D-reply, Phase 14).
 *
 * P5-T4 seeded every product's `defaultAttackPlan.objectionYouSay` with the product's
 * **differentiator**, taken from a stale comment in `Overall.html` (`:9482-9484`) and the retired
 * section file. What the governing file renders is the need's reply (`REPLY_BY_NEED`,
 * `:9497-9506`), and the differentiator already prints under *How it stands out* in the same
 * drawer. The seed constant is corrected (`SEED_REPLY_BY_NEED`); this brings the companies that
 * already hold the old words with it.
 *
 * **Only a value nobody has touched.** A company product is rewritten when its code is a seeded
 * one and its reply **still equals that code's seeded differentiator** — the words P5-T4 wrote.
 * A reply the Super Admin edited is the company's own and is left alone, whatever it says; so is a
 * product the company added, whose code the seed never had. **No office's override is read or
 * written**: `kpmProductConfigs` is not opened, so an office that wrote its own reply, or approved
 * one, keeps it. Every other office's agents read the corrected words on their next read, as every
 * company edit reaches them (ADR-0033).
 *
 * **Idempotent**: a rewritten reply no longer equals the differentiator, so a second run matches
 * nothing. The version moves with the words, once, as any other edit to a product moves it.
 *
 * Recorded as the other migrations are, by what it prints: `rewritten` this run, `current`
 * already holding the seeded reply (a company created after the seed was corrected, or a second
 * run), and `edited` — a seeded code whose reply is neither, kept as the company wrote it.
 */
export async function up(
  db: mongoose.mongo.Db,
  now: Date,
): Promise<{ rewritten: number; current: number; edited: number }> {
  const products = db.collection('products');
  let rewritten = 0;
  let current = 0;
  let edited = 0;

  for (const seed of SEED_PRODUCTS) {
    const reply = seed.defaultAttackPlan.objectionYouSay;
    // The words P5-T4 wrote, compared exactly: a reply somebody edited by one character is theirs.
    const result = await products.updateMany(
      { code: seed.code, 'defaultAttackPlan.objectionYouSay': seed.differentiator },
      {
        $set: { 'defaultAttackPlan.objectionYouSay': reply, updatedAt: now },
        $inc: { version: 1 },
      },
    );
    rewritten += result.modifiedCount;

    current += await products.countDocuments({
      code: seed.code, 'defaultAttackPlan.objectionYouSay': reply,
    }) - result.modifiedCount;
    edited += await products.countDocuments({
      code: seed.code,
      // A row that holds a reply at all: since P19.4-T4 a product holds cards (`0054-product-objection-cards`), and
      // `$nin` alone would count each of those as a reply somebody edited.
      'defaultAttackPlan.objectionYouSay': { $exists: true, $nin: [reply, seed.differentiator] },
    });
  }

  return { rewritten, current, edited };
}
