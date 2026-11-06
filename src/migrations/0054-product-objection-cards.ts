import mongoose from 'mongoose';
import { plainTextLines } from '@/common/validation/plain-text';
import { PRODUCT_OBJECTIONS_MAX, type ObjectionCard } from '@/domain/constants';

/** Who the audit rows name: a job, as `RequestContext.forJob` names one. */
export const OBJECTION_CARDS_ACTOR = 'job:migration-0054-product-objection-cards';

/** The start of one numbered objection: `1. "`, `2) “` — at the start of the text, a line, or after a space. */
const ITEM_START = /(^|\s)(\d{1,2})[.)]\s*["“]/g;

/** One numbered objection: its number, the quoted words, the arrow, and the reply. */
const ITEM = /^\s*\d{1,2}[.)]\s*["“]([\s\S]+?)["”]\s*(?:→|->|=>)\s*([\s\S]*?)\s*$/;

/** A text compared the way a reader would: no quotation marks, one space, any case. */
const normal = (text: string) => text.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * **The merged *4b* text, split into cards** (P19.4-T4 AC-2, B1-1; ADR-0209 §9). The owner's session wrote three to
 * five objections per product into *you say* as `1. "…" → …`, one per line — or, where the save flattened its line
 * breaks before P19-T6, one after another on one line. This reads both:
 *
 * - each item is a number from 1 counting up, `.` or `)`, the customer's words in quotation marks, an arrow (`→`, `->`
 *   or `=>`) and the reply, which runs to the next item and keeps its own line breaks;
 * - **anything it cannot read stays one card**, the pair as it was: a text that is not a numbered list, a list whose
 *   numbers skip, an item without its arrow, or more items than `PRODUCT_OBJECTIONS_MAX`;
 * - *they say* (4a) that repeats one of the items is dropped, being that item; one that says something else is kept as
 *   a card of its own, first, with no reply — nothing typed is lost from sight, and the Super Admin answers it;
 * - a pair with neither side written is no card at all.
 *
 * Pure, so the test runs it on PRUProsper's text without a database.
 */
export function splitObjections(theySay: string, youSay: string): ObjectionCard[] {
  const they = plainTextLines(theySay);
  const you = plainTextLines(youSay);
  if (they === '' && you === '') return [];
  const asOne: ObjectionCard[] = [{ objection: they, answer: you }];

  const starts: number[] = [];
  for (const match of you.matchAll(ITEM_START)) {
    if (Number(match[2]) !== starts.length + 1) continue;
    starts.push(match.index + match[1].length);
  }
  // Text before the first item, or a single item: not a list this can read.
  if (starts.length < 2 || you.slice(0, starts[0]).trim() !== '') return asOne;

  const cards: ObjectionCard[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const parsed = ITEM.exec(you.slice(starts[i], starts[i + 1] ?? you.length));
    if (!parsed) return asOne;
    cards.push({ objection: plainTextLines(parsed[1]), answer: plainTextLines(parsed[2]) });
  }

  const repeats = they === '' || cards.some((card) => normal(card.objection) === normal(they));
  const all = repeats ? cards : [{ objection: they, answer: '' }, ...cards];
  return all.length > PRODUCT_OBJECTIONS_MAX ? asOne : all;
}

/** The old pair a plan or an override held, `''` for a side it lacks. */
interface Pair {
  objectionTheySay?: unknown;
  objectionYouSay?: unknown;
}

const has = (record: object | null | undefined, key: string) =>
  record !== null && record !== undefined && Object.prototype.hasOwnProperty.call(record, key);
const hasPair = (record: object | null | undefined) => has(record, 'objectionTheySay') || has(record, 'objectionYouSay');
const text = (value: unknown) => (typeof value === 'string' ? value : '');

export interface ProductObjectionCardsResult {
  /** Products whose pair became cards, each a new version with its original in the audit log. */
  products: number;
  /** Of those, the ones whose merged text split into more than one card. */
  split: number;
  /** Products whose pair was empty: given `objections: []`, no version. */
  empty: number;
  /** Offices' overrides — a draft or an approved copy — whose pair became cards. */
  overrides: number;
}

/**
 * **Every product's objection pair becomes a list of cards** (P19.4-T4 AC-2; ADR-0209 §9). `defaultAttackPlan` held
 * one pair, `objectionTheySay` and `objectionYouSay`; it holds `objections`, a list. And so does an office's override
 * of the plan, its draft (`overrides`) and its approved copy (`approvedOverrides`) alike.
 *
 * - **Each pair through {@link splitObjections}**: the merged *`1. "…" → …`* text in cards, anything else one card.
 * - **The original stays in the product's history**: each product changed gets a new version and an audit row,
 *   `product.objections_split`, its pair as `before` and its cards as `after`; an office's row the same,
 *   `kpm_product.objections_split`, in its office. The old fields are then removed.
 * - **An office that replaced one side** had the company's other side beside it, and reads the two together now: its
 *   override is the pair it read — its side and the company's — as cards, so what its agents read does not move. The
 *   offices go first, while the company's pair is still there to read.
 * - **No office's words are re-approved or sent back**: the review state is not touched.
 *
 * **Idempotent**: it reads only rows that still hold a pair, and removes the pair from each; a second run finds none.
 * On an empty database there is nothing to read, and it writes nothing.
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<ProductObjectionCardsResult> {
  const products = db.collection('products');
  const configs = db.collection('kpmProductConfigs');
  const audit = db.collection('auditLog');
  const result: ProductObjectionCardsResult = { products: 0, split: 0, empty: 0, overrides: 0 };

  /** The company's pair for a product, whether this run has reached it yet or a run before did. */
  const companyPair = async (productId: unknown): Promise<{ they: string; you: string }> => {
    const product = await products.findOne(
      { _id: mongoose.isValidObjectId(productId) ? new mongoose.Types.ObjectId(String(productId)) : productId as never },
      { projection: { defaultAttackPlan: 1 } },
    );
    const plan = (product?.defaultAttackPlan ?? {}) as Pair & { objections?: ObjectionCard[] };
    if (hasPair(plan)) return { they: text(plan.objectionTheySay), you: text(plan.objectionYouSay) };
    const first = plan.objections?.[0];
    return { they: first?.objection ?? '', you: first?.answer ?? '' };
  };

  // ---------------------------------------------------------------- offices' overrides first
  const officeRows = configs.find({
    $or: [
      { 'overrides.objectionTheySay': { $exists: true } }, { 'overrides.objectionYouSay': { $exists: true } },
      { 'approvedOverrides.objectionTheySay': { $exists: true } },
      { 'approvedOverrides.objectionYouSay': { $exists: true } },
    ],
  });
  for await (const row of officeRows) {
    const company = await companyPair(row.productId);
    const set: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};
    for (const field of ['overrides', 'approvedOverrides'] as const) {
      const held = (row[field] ?? {}) as Pair;
      if (!hasPair(held)) continue;
      const they = has(held, 'objectionTheySay') ? text(held.objectionTheySay) : company.they;
      const you = has(held, 'objectionYouSay') ? text(held.objectionYouSay) : company.you;
      set[`${field}.objections`] = splitObjections(they, you);
      before[field] = {
        ...(has(held, 'objectionTheySay') ? { objectionTheySay: held.objectionTheySay } : {}),
        ...(has(held, 'objectionYouSay') ? { objectionYouSay: held.objectionYouSay } : {}),
      };
    }
    await configs.updateOne({ _id: row._id }, {
      $set: { ...set, updatedAt: now },
      $unset: {
        'overrides.objectionTheySay': '', 'overrides.objectionYouSay': '',
        'approvedOverrides.objectionTheySay': '', 'approvedOverrides.objectionYouSay': '',
      },
      $inc: { version: 1 },
    });
    await audit.insertOne({
      kpmId: row.kpmId ?? null, actorUserId: OBJECTION_CARDS_ACTOR, effectiveUserId: OBJECTION_CARDS_ACTOR,
      actorMembershipId: null, action: 'kpm_product.objections_split', targetCollection: 'kpmProductConfigs',
      targetId: String(row._id), targetMembershipId: null, before, after: set, onBehalfOf: false, ip: null,
      userAgent: null, createdAt: now, updatedAt: now,
    });
    result.overrides += 1;
  }

  // ---------------------------------------------------------------- then the company's products
  const productRows = products.find({
    $or: [
      { 'defaultAttackPlan.objectionTheySay': { $exists: true } },
      { 'defaultAttackPlan.objectionYouSay': { $exists: true } },
      { 'defaultAttackPlan.objections': { $exists: false } },
    ],
  });
  for await (const product of productRows) {
    const plan = (product.defaultAttackPlan ?? {}) as Pair & { objections?: ObjectionCard[] };
    const unset = { 'defaultAttackPlan.objectionTheySay': '', 'defaultAttackPlan.objectionYouSay': '' };
    if (!hasPair(plan) && Array.isArray(plan.objections)) continue;
    const they = text(plan.objectionTheySay);
    const you = text(plan.objectionYouSay);
    const cards = splitObjections(they, you);

    if (cards.length === 0) {
      // Nothing was written: the shape moves, the version and the words do not.
      await products.updateOne({ _id: product._id }, { $set: { 'defaultAttackPlan.objections': [] }, $unset: unset });
      result.empty += 1;
      continue;
    }
    await products.updateOne({ _id: product._id }, {
      $set: { 'defaultAttackPlan.objections': cards, updatedAt: now },
      $unset: unset,
      $inc: { version: 1 },
    });
    await audit.insertOne({
      kpmId: null, actorUserId: OBJECTION_CARDS_ACTOR, effectiveUserId: OBJECTION_CARDS_ACTOR,
      actorMembershipId: null, action: 'product.objections_split', targetCollection: 'products',
      targetId: String(product._id), targetMembershipId: null,
      before: { code: product.code, objectionTheySay: they, objectionYouSay: you },
      after: { code: product.code, objections: cards }, onBehalfOf: false, ip: null, userAgent: null,
      createdAt: now, updatedAt: now,
    });
    result.products += 1;
    if (cards.length > 1) result.split += 1;
  }

  return result;
}
