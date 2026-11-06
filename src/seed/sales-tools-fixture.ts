import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { KpmProductConfig, KpmProductConfigSchema } from '@/modules/products/kpm-product-config.schema';
import { Product, ProductSchema } from '@/modules/products/product.schema';
import { up as attackPlanReply } from '@/migrations/0024-attack-plan-reply';
import { up as productNamePlaceholder } from '@/migrations/0039-product-name-placeholder';
import { up as productKindAndCurrency } from '@/migrations/0053-product-kind-and-currency';
import { up as productObjectionCards } from '@/migrations/0054-product-objection-cards';
import { seedObjectId } from './coaching-fixture';

/**
 * **Sales tools, seeded** (Phase 14, *Seed*; P14-T7 AC-13; `functional/sales-tools.md`, *Seed*).
 *
 * The catalog is seeded already — the 31 products of Prudential and Allianz Life — and so are the five
 * office decisions P5-T5 and P5-T10 need (`configure` in `demo.ts`, on 0417 and 0555 alike). This adds
 * only what the sales tools are the first to show. Which account shows what:
 *
 * | What | Its state | Who to sign in as, and what they see |
 * |---|---|---|
 * | **0417 BSD City**, the decisions `configure` gives it | *PRUMapan* under the company's name (no rename since P18.7-T6); *PRUSmart Plan* turned off; *PRUFuture*'s opening **pending**; *PRUWarisan* approved and edited again; *PRUAnugerah* sent back | `rina@kpm0417.test` at `/product-catalog`: *PRUMapan*, no *PRUSmart Plan*, the company's words on *PRUFuture* and *PRUAnugerah*, the approved opening on *PRUWarisan* |
 * | **0417 keeps PRULink Generasi Baru (PGB) on** (new) | `active: true` on a product the company closed to new business | `rina@kpm0417.test`: an *In run-off* card under *Investment-linked*, its run-off sentence, no script. 0555 does not keep it on, so its agents do not see it |
 * | **An approved description** (new, OD-136) on *PRUMapan* | the office's *Short description (shown to agents)*, approved by the Owner six days ago | `rina@kpm0417.test`: the office's sentence on the card, the drawer and the plan, in the tagline's place. `owner@kpm0417.test` at `/kpm/settings/products` → *PRUMapan* → *Customize*: the field marked *Yours.*, the row *Approved* |
 * | **A pending description** (new, OD-136) on *PRUFuture* | written beside its pending opening, not yet approved | `rina@kpm0417.test`: the company's tagline still. `owner@kpm0417.test` or `admin@kpm0417.test` at *Script approvals*: *PRUFuture*, its description among the lines to decide; **Approve**, and the agent's next read has both |
 * | **Prudential's commission schedules** (new, OD-135) | *PRUMapan* three years, *PRUFuture* three, *PRULink NextGen* five — **demo figures, not Prudential's** — and every other product none | `rina@kpm0417.test`, the drawer's *Details*: *Commission rate*, a row per year; *PRUWarisan*'s is not set. `superadmin@agencyboost.test` at `/admin/companies` → *Prudential* → *Template* → *Products* → *Edit*: the schedule as percentages, to change |
 * | **0555 Kelapa Gading** | the same five, no PGB and no description | `agent@kpm0555.test`: the other office of the same company |
 * | **0701 Cempaka Putih** (Sejahtera Baru Life, `template-fixture.ts`) | its company was created blank: no product at all | `agent@kpm0701.test`: the empty shelf on both screens |
 *
 * **Not seeded here:** a product document — since Phase 17, `recruitment-fixture.ts` stores 0417's own
 * PRUMapan brochure where storage is configured (P17-T9) — and a product kept on with no script, since every
 * active seeded product has one; that layout is a test fixture.
 *
 * **Migration `0024-attack-plan-reply` runs here**, as a deployed database meets it, so a database seeded
 * before the reply was corrected (D-reply) is corrected by a re-seed without `--reset`; a fresh seed has
 * nothing for it to do. **So does `0039-product-name-placeholder`** (P18.7-T6, UI-023): a database seeded
 * while `configure` still renamed PRUMapan *"PRUMapan (nama kami)"* is given the company's name back.
 *
 * **Written once, until `--reset`.** Each write leaves the audit row its service would have — the same
 * action names, so `/admin/audit` reads what the demo did — and **that row is the marker**: a decision
 * already in the audit log, the fixture's own from an earlier run or a walk's through the API, is never
 * written again. So a re-seed without `--reset` never re-approves a description the Owner gave back,
 * re-drafts one the Owner approved, rejected or gave back, or re-writes a schedule the Super Admin changed
 * or cleared; `--reset` empties `auditLog` with the rows, and the next run writes all of it afresh.
 *
 * | Decision | Its marker in `auditLog` |
 * |---|---|
 * | PGB kept on | the row itself, by derived id (`seedObjectId`); and `kpm_product.activation_set` |
 * | A description, approved or pending | `kpm_product.override_saved` naming `description`, or `kpm_product.override_reset` of it, on 0417's row for the product |
 * | A schedule | `product.updated` carrying `commissionSchedule`, on the product |
 *
 * And, as before, only where the row has room: the descriptions are laid onto the rows `configure` wrote
 * only where the row holds no description and its state allows — the approved one onto a row with nothing
 * waiting, the pending one onto a row that is not sent back — and a schedule only where the product has
 * none, so a database seeded before the markers existed is not overwritten either. A re-seed without
 * `--reset` writes nothing.
 */

const RECOMPILE = { overwriteModels: true } as const;
const DAY_MS = 86_400_000;

/** 0417's three new decisions, by product code. */
export const SALES_TOOLS_DECISIONS = {
  /** A run-off product kept on: the catalog's *In run-off* card. */
  keptOnRunOff: { code: 'PRULINK_GENERASI_BARU_PGB' },
  /** Approved: agents read it in place of the company's tagline. */
  approvedDescription: {
    code: 'PRUMAPAN',
    description: 'Dana pensiun yang cair rutin dari usia 55, mulai sekitar Rp200 ribu sebulan.',
    approvedDaysAgo: 6,
  },
  /** Written, not approved: agents read the company's tagline until it is. */
  pendingDescription: {
    code: 'PRUFUTURE',
    description: 'Proteksi jiwa seumur hidup sampai usia 100, dalam Rupiah atau USD.',
  },
} as const;

/**
 * **Demo figures, not the company's** — a rate per policy year, as a proportion.
 *
 * The seeded catalog states no commission (parity F-15) and still does not: these are written on the
 * demo's Prudential only, so the drawer's *Commission rate* and the Super Admin's editor can be walked.
 * The client's real rates replace them before go-live. Every other product is left with none.
 */
export const SALES_TOOLS_COMMISSION: Readonly<Record<string, readonly { year: number; rate: number }[]>> = {
  PRUMAPAN: [{ year: 1, rate: 0.3 }, { year: 2, rate: 0.15 }, { year: 3, rate: 0.05 }],
  PRUFUTURE: [{ year: 1, rate: 0.35 }, { year: 2, rate: 0.15 }, { year: 3, rate: 0.1 }],
  PRULINK_NEXTGEN: [
    { year: 1, rate: 0.25 }, { year: 2, rate: 0.1 }, { year: 3, rate: 0.05 },
    { year: 4, rate: 0.05 }, { year: 5, rate: 0.025 },
  ],
};

/** The product the guide names for the drawer's *not set* line. */
export const SALES_TOOLS_NOT_SET = 'PRUWARISAN';

/**
 * **A rider on Prudential's demo shelf** (P19.4-T4; the riders spec; ADR-0209 §1–§3): *PRUPersonal Accident D&D Plus*,
 * which the seed catalogue already calls an accident-only rider, attached to two bases. Agents of 0417 meet it only
 * inside *PRUMapan*'s and *PRUTect Care*'s drawer and plan, as *"Bisa ditambah: PRUPersonal Accident D&D Plus"*; it
 * leaves the list, its filters and the needs finder. **A demo attachment, not Prudential's own** (OD-262): the owner
 * names the real ones.
 */
export const SALES_TOOLS_RIDER = {
  code: 'PRUPERSONAL_ACCIDENT_D_D_PLUS',
  bases: ['PRUMAPAN', 'PRUTECT_CARE'],
} as const;

/** The derived id of a decision row this fixture creates. */
export const salesToolsConfigId = (code: string) => seedObjectId('sales-tools-fixture', 'kpmProductConfig', '0417', code);

export interface SalesToolsFixtureDeps {
  clock: Clock;
  /** Prudential: whose products carry the schedules, and 0417's company. */
  companyId: string;
  /** Office 0417, whose decisions these are. */
  kpm0417: string;
  /** 0417's Owner, who approved the description. */
  ownerMembershipId: string;
  /** The Owner's account, the actor on the audit rows of the office's decisions. */
  ownerUserId: string;
  /** The Super Admin's account, the actor on the audit rows of the schedules. */
  superAdminUserId: string;
}

export interface SalesToolsFixture {
  /** Rows this run wrote or completed: office decisions and schedules, or nothing on a re-run. */
  written: number;
  /** What migration `0024` did on this run: nothing on a fresh seed. */
  reply: Awaited<ReturnType<typeof attackPlanReply>>;
  /** What migration `0039` did on this run: nothing on a fresh seed. */
  named: Awaited<ReturnType<typeof productNamePlaceholder>>;
  /** What migrations `0053` and `0054` did on this run: the Template company's catalogue, the first time. */
  kinds: Awaited<ReturnType<typeof productKindAndCurrency>>;
  objections: Awaited<ReturnType<typeof productObjectionCards>>;
  guide: string;
}

export async function seedSalesToolsFixture(deps: SalesToolsFixtureDeps): Promise<SalesToolsFixture> {
  const { companyId, kpm0417: kpmId } = deps;
  const Products = mongoose.model(Product.name, ProductSchema, undefined, RECOMPILE);
  const Configs = mongoose.model(KpmProductConfig.name, KpmProductConfigSchema, undefined, RECOMPILE);
  const Audit = mongoose.model(AuditLog.name, AuditLogSchema, undefined, RECOMPILE);
  const now = deps.clock.now();
  let written = 0;

  /** Has anybody — this fixture on an earlier run, or a walk through the API — already decided this? */
  const decided = async (filter: Record<string, unknown>) => (await Audit.exists(filter).exec()) !== null;
  /** A description of 0417's row for the product, drafted, given back or reset, by anybody. */
  const descriptionDecided = (rowId: string) => decided({
    kpmId, targetCollection: 'kpmProductConfigs', targetId: rowId,
    $or: [
      { action: 'kpm_product.override_saved', 'after.fields': 'description' },
      { action: 'kpm_product.override_reset', 'after.field': 'description' },
    ],
  });
  /** The audit row the office's service would have written, as 0417's Owner, at `at`. */
  const ownersRow = (action: string, rowId: string, after: Record<string, unknown>, at: Date) => Audit.create({
    kpmId, actorUserId: deps.ownerUserId, actorMembershipId: deps.ownerMembershipId,
    action, targetCollection: 'kpmProductConfigs', targetId: rowId, after, createdAt: at, updatedAt: at,
  });

  const reply = await attackPlanReply(mongoose.connection.db!, now);
  const named = await productNamePlaceholder(mongoose.connection.db!, now);
  // P19.4-T4 (ADR-0209): the Template company's catalogue is written by migration `0037`, in the shape of its day — so
  // the two product migrations run here too, as a deployed database meets them; a re-seed finds nothing for either.
  const kinds = await productKindAndCurrency(mongoose.connection.db!);
  const objections = await productObjectionCards(mongoose.connection.db!, now);

  const productIdOf = async (code: string): Promise<string> => {
    const product = await Products.findOne({ companyId, code, deletedAt: null }).select('_id').lean().exec();
    if (!product) {
      throw new Error(`${code} is not on Prudential's shelf: the sales tools fixture runs after the catalog is seeded.`);
    }
    return String(product._id);
  };
  /** A row of 0417's for the product, whoever wrote it. */
  const rowOf = async (productId: string) => Configs.findOne({ kpmId, productId, deletedAt: null }).exec();
  const create = async (code: string, productId: string, fields: Record<string, unknown>) => {
    await Configs.create({
      _id: salesToolsConfigId(code), kpmId, productId, active: null, overrides: {}, reviewState: 'none',
      reviewedByMembershipId: null, reviewedAt: null, rejectionReason: null,
      approvedOverrideVersion: 0, approvedOverrides: {},
      version: 1, deletedAt: null, createdBy: null, updatedBy: null,
      ...fields,
    });
    written += 1;
  };
  /** No description on the row at all, drafted or approved: never decided by anybody. */
  const undescribed = (row: { overrides?: unknown; approvedOverrides?: unknown }) =>
    !Object.prototype.hasOwnProperty.call(row.overrides ?? {}, 'description')
    && !Object.prototype.hasOwnProperty.call(row.approvedOverrides ?? {}, 'description');

  // A schedule nobody has written yet, where the product has none: one entered or cleared in a walk is the walk's.
  for (const [code, schedule] of Object.entries(SALES_TOOLS_COMMISSION)) {
    const productId = await productIdOf(code);
    const markers = {
      action: 'product.updated', targetCollection: 'products', targetId: productId,
      'after.commissionSchedule': { $exists: true },
    };
    if (await decided(markers)) continue;
    const rows = schedule.map((row) => ({ ...row }));
    const result = await Products.updateOne(
      { _id: productId, companyId, deletedAt: null, commissionSchedule: { $size: 0 } },
      { $set: { commissionSchedule: rows } },
    ).exec();
    if (result.modifiedCount === 0) continue;
    await Audit.create({
      kpmId: null, actorUserId: deps.superAdminUserId, action: 'product.updated', targetCollection: 'products',
      targetId: productId, before: { commissionSchedule: [] }, after: { commissionSchedule: rows },
    });
    written += 1;
  }

  // The rider, once: a product the Super Admin made a base again, or attached elsewhere, in a walk is the walk's.
  const riderId = await productIdOf(SALES_TOOLS_RIDER.code);
  const riderMarker = { action: 'product.updated', targetCollection: 'products', targetId: riderId, 'after.kind': 'rider' };
  if (!(await decided(riderMarker))) {
    const bases = await Promise.all(SALES_TOOLS_RIDER.bases.map(productIdOf));
    const result = await Products.updateOne(
      { _id: riderId, companyId, deletedAt: null, kind: { $ne: 'rider' } },
      { $set: { kind: 'rider', attachesTo: bases }, $inc: { version: 1 } },
    ).exec();
    if (result.modifiedCount > 0) {
      await Audit.create({
        kpmId: null, actorUserId: deps.superAdminUserId, action: 'product.updated', targetCollection: 'products',
        targetId: riderId, before: { kind: 'base', attachesTo: [] }, after: { kind: 'rider', attachesTo: bases },
      });
      written += 1;
    }
  }

  const { keptOnRunOff, approvedDescription, pendingDescription } = SALES_TOOLS_DECISIONS;

  // PGB kept on, where 0417 has no opinion about it yet.
  const pgbId = await productIdOf(keptOnRunOff.code);
  if (!(await rowOf(pgbId))) {
    await create(keptOnRunOff.code, pgbId, { active: true });
    await ownersRow('kpm_product.activation_set', salesToolsConfigId(keptOnRunOff.code), {
      code: keptOnRunOff.code, active: true,
    }, now);
  }

  // The approved description: frozen into the approved copy, as `approveScript` freezes it.
  const approvedId = await productIdOf(approvedDescription.code);
  const approvedRow = await rowOf(approvedId);
  const approval = {
    reviewState: 'approved',
    reviewedByMembershipId: deps.ownerMembershipId,
    reviewedAt: new Date(now.getTime() - approvedDescription.approvedDaysAgo * DAY_MS),
    rejectionReason: null,
  };
  /** The two rows the approval leaves: the draft saved, then approved — `saveOverrides`, `approveScript`. */
  const approvedRows = async (rowId: string, version: number) => {
    const draftedAt = new Date(approval.reviewedAt.getTime() - 3_600_000);
    await ownersRow('kpm_product.override_saved', rowId, {
      code: approvedDescription.code, fields: ['description'], reviewState: 'pending',
    }, draftedAt);
    await ownersRow('sales_script.approved', rowId, { code: approvedDescription.code, version }, approval.reviewedAt);
  };
  if (!approvedRow) {
    await create(approvedDescription.code, approvedId, {
      ...approval,
      overrides: { description: approvedDescription.description },
      approvedOverrideVersion: 1,
      approvedOverrides: { description: approvedDescription.description },
    });
    await approvedRows(salesToolsConfigId(approvedDescription.code), 1);
  } else if (
    !(await descriptionDecided(String(approvedRow._id)))
    && undescribed(approvedRow) && ['none', 'approved'].includes(approvedRow.reviewState)
  ) {
    // Nothing waiting on the row, so approving it approves only what is added here — and whatever it
    // already had approved stays approved beside it.
    await Configs.updateOne({ _id: approvedRow._id }, {
      $set: {
        ...approval,
        'overrides.description': approvedDescription.description,
        'approvedOverrides.description': approvedDescription.description,
        approvedOverrideVersion: approvedRow.version + 1,
      },
      $inc: { version: 1 },
    }).exec();
    await approvedRows(String(approvedRow._id), approvedRow.version + 1);
    written += 1;
  }

  // The pending description: a new draft, which is what puts a row to pending.
  const pendingId = await productIdOf(pendingDescription.code);
  const pendingRow = await rowOf(pendingId);
  const draft = { reviewState: 'pending', reviewedByMembershipId: null, reviewedAt: null, rejectionReason: null };
  const draftRow = (rowId: string) => ownersRow('kpm_product.override_saved', rowId, {
    code: pendingDescription.code, fields: ['description'], reviewState: 'pending',
  }, now);
  if (!pendingRow) {
    await create(pendingDescription.code, pendingId, {
      ...draft, overrides: { description: pendingDescription.description },
    });
    await draftRow(salesToolsConfigId(pendingDescription.code));
  } else if (
    !(await descriptionDecided(String(pendingRow._id)))
    && undescribed(pendingRow) && pendingRow.reviewState !== 'rejected'
  ) {
    await Configs.updateOne({ _id: pendingRow._id }, {
      $set: { ...draft, 'overrides.description': pendingDescription.description },
      $inc: { version: 1 },
    }).exec();
    await draftRow(String(pendingRow._id));
    written += 1;
  }

  const guide = `
  SALES TOOLS at /product-catalog and /attack-plan  (from src/seed/sales-tools-fixture.ts; walk as an agent
             of 0417, e.g. rina@kpm0417.test. PRUMapan's own brochure is RECRUITMENT's, below, where storage
             is configured; otherwise upload one on /kpm/settings/products as the Owner first)
    KPM 0417 · BSD City          P5's decisions: PRUSmart Plan off; PRUFuture's opening pending; PRUWarisan
                                 approved and edited again; PRUAnugerah sent back. PRUMapan under its own name.
                                 Search the catalog by name ("mapan"); the category pills scroll on a phone.
                                 New: PRULink Generasi Baru (PGB) kept on — an In run-off card. PRUMapan's own
                                 description, approved — on its card in the tagline's place; PRUFuture's,
                                 pending — the company's tagline until the Owner approves it at Script approvals
    KPM 0555 · Kelapa Gading     agent@kpm0555.test — P5's five, no PGB and no description
    KPM 0701 · Cempaka Putih     agent@kpm0701.test — the empty shelf: its company has no product
    Prudential commission        DEMO figures on PRUMapan, PRUFuture and PRULink NextGen; PRUWarisan and the
                                 rest not set. Edit at /admin/companies → Prudential → Template → Products
    Prudential rider             PRUPersonal Accident D&D Plus is a RIDER on PRUMapan and PRUTect Care (a demo
                                 attachment). Not in 0417's catalog list; open PRUMapan → "Bisa ditambah: …".
                                 On /kpm/settings/products it sits under both bases with no switch of its own.
                                 Super Admin: Produk tab, chip "Rider", "Untuk: PRUMapan, PRUTect Care"
`;

  return { written, reply, named, kinds, objections, guide };
}
