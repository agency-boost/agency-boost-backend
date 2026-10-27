import mongoose from 'mongoose';
import { FixedClock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { SEED_PRODUCTS, SEED_REPLY_BY_NEED } from '@/domain/constants';
import { up as attackPlanReply } from '@/migrations/0024-attack-plan-reply';
import { up as productNamePlaceholder } from '@/migrations/0039-product-name-placeholder';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import {
  SALES_TOOLS_COMMISSION, SALES_TOOLS_DECISIONS, SALES_TOOLS_NOT_SET, salesToolsConfigId,
  seedSalesToolsFixture,
} from '../sales-tools-fixture';
import { EMPTY_OFFICE } from '../template-fixture';
import { seedDemo } from '../demo';

/**
 * **Phase 14 — the sales tools, seeded** (P14-T7 AC-13; `sales-tools-fixture.ts`).
 *
 * Run as the command runs it and read back through the services the screens read, so what is
 * asserted is what 0417's Owner, its agents and the Super Admin see.
 */
const RUN_MS = 240_000;
const quiet = () => undefined;
const col = (name: string) => mongoose.connection.db!.collection(name);
const seedOf = (code: string) => SEED_PRODUCTS.find((p) => p.code === code)!;

async function as(email: string, owner = false): Promise<RequestContext> {
  const account = await col('users').findOne({ email });
  const member = (await col('memberships').findOne({ userId: String(account!._id), status: 'active' }))!;
  return new RequestContext(String(member.userId), 'none', {
    membershipId: String(member._id), kpmId: member.kpmId, orgLevelCode: member.orgLevelCode,
    hierarchyRole: member.role, status: 'active', isKpmOwner: owner, isKpmAdmin: false, directCount: 0,
  } as never);
}

describe('Phase 14 the sales tools seed — a run at 10:00 on 8 October 2026 in Jakarta', () => {
  const clock = new FixedClock(new Date('2026-10-08T03:00:00Z'));
  let wired: ReturnType<typeof configModule>;
  let prudentialId: string;
  let owner0417: RequestContext;
  let agent0417: RequestContext;

  beforeAll(async () => {
    await startMongo();
    await clearCollections();
    await seedDemo({ clock, log: quiet });
    wired = configModule(clock.now());
    prudentialId = String((await col('companies').findOne({ slug: 'prudential' }))!._id);
    owner0417 = await as('owner@kpm0417.test', true);
    agent0417 = await as('rina@kpm0417.test');
  }, RUN_MS);
  afterAll(stopMongo);

  const shelfOf = async (ctx: RequestContext) => wired.kpmProducts.list(ctx);
  const rowOf = async (ctx: RequestContext, code: string) => (await shelfOf(ctx)).find((p) => p.code === code)!;

  describe('office 0417', () => {
    it('keeps P5’s five decisions, as the phase file lists them', async () => {
      const shelf = await shelfOf(owner0417);
      const by = (code: string) => shelf.find((p) => p.code === code)!;

      // P18.95-T6 AC-4 (UI-023): no placeholder rename — the office reads the company's name.
      expect(by('PRUMAPAN').displayName).toEqual({ value: 'PRUMapan', overridden: false });
      expect(by('PRUSMART_PLAN').active).toEqual({ value: false, overridden: true });
      expect(by('PRUFUTURE').reviewState).toBe('pending');
      expect(by('PRUWARISAN').reviewState).toBe('pending');
      expect(by('PRUANUGERAH').reviewState).toBe('rejected');
      // PRUFuture's opening waits, so its agents read the company's words.
      expect((await wired.kpmProducts.effectiveScript(agent0417, by('PRUFUTURE').productId)).source)
        .toBe('company');
    });

    it('keeps PRULink Generasi Baru on, a product its company closed to new business', async () => {
      const pgb = await rowOf(owner0417, SALES_TOOLS_DECISIONS.keptOnRunOff.code);

      expect(pgb).toMatchObject({ lifecycle: 'closed_to_new_business', sellable: true });
      expect(pgb.active).toEqual({ value: true, overridden: true });
    });

    it('serves its approved description to agents in place of the tagline', async () => {
      const { code, description } = SALES_TOOLS_DECISIONS.approvedDescription;
      const row = await rowOf(owner0417, code);

      expect(row).toMatchObject({ reviewState: 'approved', description: { value: description, overridden: true } });
      // Laid onto the row P5 seeded, which renames nothing since P18.95-T6: the company's name, the office's words.
      expect(row.displayName).toEqual({ value: 'PRUMapan', overridden: false });
      const served = await wired.kpmProducts.effectiveScript(agent0417, row.productId);
      expect(served).toMatchObject({ source: 'kpm', description });
      // Only the description was approved: the script is still the company's.
      expect(served.script.opening).toBe(seedOf(code).defaultAttackPlan.opening);
      // Approved by the Owner, with a time — the record ADR-0037 keeps.
      const stored = await col('kpmProductConfigs').findOne({ kpmId: owner0417.kpmId, productId: row.productId });
      expect(stored).toMatchObject({ reviewedByMembershipId: owner0417.membershipId });
      expect(stored!.reviewedAt).toEqual(new Date(clock.now().getTime() - 6 * 86_400_000));
      expect(stored!.approvedOverrideVersion).toBe(stored!.version);
    });

    it('holds its pending description back: agents read the company’s tagline, and the queue has it', async () => {
      const { code, description } = SALES_TOOLS_DECISIONS.pendingDescription;
      const row = await rowOf(owner0417, code);

      expect(row).toMatchObject({ reviewState: 'pending', description: { value: description, overridden: true } });
      // Beside P5's pending opening, which waits with it.
      expect(row.script.opening.overridden).toBe(true);
      expect(await wired.kpmProducts.effectiveScript(agent0417, row.productId))
        .toMatchObject({ source: 'company', description: seedOf(code).tagline });
      expect((await wired.kpmProducts.pendingReviews(owner0417)).map((p) => p.code)).toContain(code);
    });

    it('creates PGB’s row by a derived id', async () => {
      const pgb = await rowOf(owner0417, SALES_TOOLS_DECISIONS.keptOnRunOff.code);
      expect(await col('kpmProductConfigs').findOne({ kpmId: owner0417.kpmId, productId: pgb.productId }))
        .toMatchObject({ _id: new mongoose.Types.ObjectId(salesToolsConfigId(SALES_TOOLS_DECISIONS.keptOnRunOff.code)) });
    });
  });

  it('gives office 0555, of the same company, none of the three', async () => {
    const shelf = await shelfOf(await as('owner@kpm0555.test', true));
    const by = (code: string) => shelf.find((p) => p.code === code)!;

    expect(by('PRULINK_GENERASI_BARU_PGB').active).toEqual({ value: false, overridden: false });
    expect(by('PRUMAPAN').description.overridden).toBe(false);
    expect(by('PRUFUTURE').description.overridden).toBe(false);
  });

  it('states demo schedules on Prudential’s three products, none on the rest, none on Allianz', async () => {
    const shelf = await wired.products.list(prudentialId, { withCommission: true });

    for (const product of shelf) {
      expect(product.commissionSchedule).toEqual(SALES_TOOLS_COMMISSION[product.code] ?? []);
    }
    expect(shelf.find((p) => p.code === SALES_TOOLS_NOT_SET)!.commissionSchedule).toEqual([]);
    // Every schedule is the shape the editor writes: from year 1, none missing, a proportion.
    for (const schedule of Object.values(SALES_TOOLS_COMMISSION)) {
      expect(schedule.map((row) => row.year)).toEqual(schedule.map((_, i) => i + 1));
      for (const { rate } of schedule) expect(rate).toBeGreaterThanOrEqual(0);
      for (const { rate } of schedule) expect(rate).toBeLessThanOrEqual(1);
    }

    const allianz = String((await col('companies').findOne({ slug: 'allianz-life' }))!._id);
    expect(await col('products').countDocuments({ companyId: allianz, 'commissionSchedule.0': { $exists: true } }))
      .toBe(0);
  });

  it('seeds the push-back’s reply as the need’s, and migration 0024 finds nothing to rewrite', async () => {
    const mapan = await col('products').findOne({ companyId: prudentialId, code: 'PRUMAPAN' });
    expect(mapan!.defaultAttackPlan.objectionYouSay).toBe(SEED_REPLY_BY_NEED.retirement);

    for (let run = 0; run < 2; run += 1) {
      expect(await attackPlanReply(mongoose.connection.db!, clock.now()))
        .toMatchObject({ rewritten: 0, edited: 0 });
    }
  });

  it('P18.95-T6 AC-4 the name fix + migration: no office’s product is named with the placeholder, and 0039 finds nothing to clear', async () => {
    expect(await col('kpmProductConfigs').countDocuments({ 'overrides.displayName': /\(nama kami\)/ })).toBe(0);
    expect(await col('products').countDocuments({ name: /\(nama kami\)/ })).toBe(0);
    for (let run = 0; run < 2; run += 1) {
      expect(await productNamePlaceholder(mongoose.connection.db!, clock.now())).toEqual({ cleared: 0 });
    }
  });

  it('leaves office 0701’s company with no product: the empty shelf', async () => {
    const office = await col('kpms').findOne({ _id: new mongoose.Types.ObjectId(EMPTY_OFFICE._id) });
    expect(await col('products').countDocuments({ companyId: office!.companyId })).toBe(0);
  });

  it('leaves the audit rows its writes imply, under the services’ own action names — the markers a re-seed reads', async () => {
    const audit = (filter: Record<string, unknown>) => col('auditLog').countDocuments(filter);
    const mapan = await rowOf(owner0417, SALES_TOOLS_DECISIONS.approvedDescription.code);
    const mapanRow = await col('kpmProductConfigs').findOne({ kpmId: owner0417.kpmId, productId: mapan.productId });
    const future = await rowOf(owner0417, SALES_TOOLS_DECISIONS.pendingDescription.code);
    const futureRow = await col('kpmProductConfigs').findOne({ kpmId: owner0417.kpmId, productId: future.productId });

    for (const [rowId, actions] of [
      [String(mapanRow!._id), ['kpm_product.override_saved', 'sales_script.approved']],
      [String(futureRow!._id), ['kpm_product.override_saved']],
      [salesToolsConfigId(SALES_TOOLS_DECISIONS.keptOnRunOff.code), ['kpm_product.activation_set']],
    ] as const) {
      for (const action of actions) {
        expect([action, await audit({ action, targetId: rowId, kpmId: owner0417.kpmId, actorMembershipId: owner0417.membershipId })])
          .toEqual([action, 1]);
      }
    }
    for (const code of Object.keys(SALES_TOOLS_COMMISSION)) {
      const product = await col('products').findOne({ companyId: prudentialId, code });
      expect(await col('auditLog').findOne({ action: 'product.updated', targetId: String(product!._id) }))
        .toMatchObject({ kpmId: null, before: { commissionSchedule: [] }, after: { commissionSchedule: SALES_TOOLS_COMMISSION[code] } });
    }
  });

  it('P14 exit review: writes nothing on a second run, and keeps what a walk changed — a give-back and a clear included', async () => {
    /*
     * A walk: the Owner approves PRUFuture's description, then gives PRUMapan's back; the Super Admin
     * changes one schedule and clears another. Before the markers, a re-seed re-approved the
     * description given back (the row held none again) and re-wrote the cleared schedule (it was empty
     * again) — a walk's decision undone by `pnpm seed:demo` without `--reset`.
     */
    const future = await rowOf(owner0417, SALES_TOOLS_DECISIONS.pendingDescription.code);
    await wired.kpmProducts.approveScript(owner0417, future.productId);
    const mapan = await rowOf(owner0417, SALES_TOOLS_DECISIONS.approvedDescription.code);
    await wired.kpmProducts.saveOverrides(owner0417, mapan.productId, { description: null });
    const superAdmin = RequestContext.platform(String((await col('users').findOne({ email: 'superadmin@agencyboost.test' }))!._id));
    const productId = async (code: string) => String((await col('products').findOne({ companyId: prudentialId, code }))!._id);
    await wired.products.update(superAdmin, prudentialId, await productId('PRUFUTURE'), {
      commissionSchedule: [{ year: 1, rate: 0.4 }],
    });
    await wired.products.update(superAdmin, prudentialId, await productId('PRUMAPAN'), { commissionSchedule: [] });

    const again = await seedSalesToolsFixture({
      clock, companyId: prudentialId, kpm0417: owner0417.kpmId!, ownerMembershipId: owner0417.membershipId!,
      ownerUserId: owner0417.userId, superAdminUserId: superAdmin.userId,
    });

    expect(again.written).toBe(0);
    expect(again.reply).toMatchObject({ rewritten: 0 });
    expect((await rowOf(owner0417, future.code)).reviewState).toBe('approved');
    // Given back stays given back: the company's tagline, nothing approved in its place.
    const given = await rowOf(owner0417, mapan.code);
    expect(given.description).toEqual({ value: seedOf(mapan.code).tagline, overridden: false });
    expect((await wired.kpmProducts.effectiveScript(agent0417, mapan.productId)).description).toBe(seedOf(mapan.code).tagline);
    const schedule = async (code: string) => (await col('products').findOne({ companyId: prudentialId, code }))!.commissionSchedule;
    expect(await schedule('PRUFUTURE')).toEqual([{ year: 1, rate: 0.4 }]);
    // Cleared stays cleared.
    expect(await schedule('PRUMAPAN')).toEqual([]);
  });

  it('P14 exit review: a pending description the Owner gave back is not drafted again', async () => {
    const future = await rowOf(owner0417, SALES_TOOLS_DECISIONS.pendingDescription.code);
    // Approved in the walk above, then given back here: the row holds no description and is not sent back.
    await wired.kpmProducts.resetOverride(owner0417, future.productId, 'description');
    expect((await rowOf(owner0417, future.code)).description.overridden).toBe(false);

    const again = await seedSalesToolsFixture({
      clock, companyId: prudentialId, kpm0417: owner0417.kpmId!, ownerMembershipId: owner0417.membershipId!,
      ownerUserId: owner0417.userId, superAdminUserId: 'u-root',
    });

    expect(again.written).toBe(0);
    expect((await rowOf(owner0417, future.code)).description.overridden).toBe(false);
  });
});
