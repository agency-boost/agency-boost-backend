import mongoose from 'mongoose';
import { clearCollections, startMongo, stopMongo } from '../../../test/mongo';
import { configModule } from '../../../test/config-module';
import { SUPER_ADMIN } from '../../../test/http-permissions';
import { productDataFor } from '../../../test/product-data';
import { agent, CLIENT, COMPANY, NOW, PRODUCT_IDS, seedProposalOffice, viewAsAgent } from '../../../test/proposals';
import type { EngineRow } from './premium-engine';

const JT = 1_000_000;
const rp = (rupiah: number) => rupiah * 100;

/** A made-up table for the shelf's `CI` product (PCB88-like): ages 30–40, both genders, the smoker rate, 5 and 10 years. */
function rows(bump = 0): EngineRow[] {
  const out: EngineRow[] = [];
  for (let age = 30; age <= 40; age += 1) {
    for (const gender of ['male', 'female'] as const) {
      for (const smoker of [false, true]) {
        for (const payTerm of ['y5', 'y10']) {
          const base = 11.1 + (age - 30) * 0.25 + bump;
          const rate = Math.round(base * (gender === 'female' ? 0.85 : 1) * (smoker ? 1.25 : 1) * (payTerm === 'y5' ? 1.8 : 1) * 1e4) / 1e4;
          out.push({ age, gender, smoker, plan: null, payTerm, currency: 'IDR', frequency: null, basis: 'per_mille', rate, bandMin: null, bandMax: null });
        }
      }
    }
  }
  return out;
}

/**
 * **P19.15-T1 AC-5 to AC-7 — the agent's card calculates** (ADR-0258 §5): the item's `PATCH` answers the calculated
 * amounts, the fixed field, the note, the version and its date; a saved proposal keeps its version; a re-opened draft
 * after a new version takes effect is calculated again with *"Premi diperbarui"*; a table turned off empties what it
 * calculated; *Uji coba* gives exactly the card's numbers.
 */
describe('P19.15-T1 the agent’s card calculates', () => {
  let wired: ReturnType<typeof configModule>;
  let pd: ReturnType<typeof productDataFor>;
  let leads: Awaited<ReturnType<typeof seedProposalOffice>>;
  let tableId: string;

  beforeAll(async () => {
    await startMongo();
    wired = configModule(NOW);
    pd = productDataFor(wired);
  });
  afterAll(stopMongo);
  beforeEach(async () => {
    await clearCollections();
    leads = await seedProposalOffice(wired);
    await mongoose.connection.db!.collection('companies').insertOne({
      _id: new mongoose.Types.ObjectId(COMPANY), name: 'Prudential', slug: 'prudential', deletedAt: null,
    });
    await mongoose.model('ProductModel').updateOne({ _id: PRODUCT_IDS.CI }, { $set: { upStep: rp(JT), upMin: rp(100 * JT) } });
    tableId = await activate(rows(), '2026-04-01');
  });

  async function activate(table: EngineRow[], from: string): Promise<string> {
    const { rateTableId } = await pd.rateTables.createDraft(SUPER_ADMIN, {
      companyId: COMPANY, productId: PRODUCT_IDS.CI, rows: table, effectiveFrom: from, effectiveTo: null,
      rules: { upStep: rp(JT), upMin: rp(100 * JT) }, frequencies: { monthly: 0.09, annual: 1 },
      source: { fileName: 'tarif.xlsx', type: 'intake', assetKey: null, intakeItemId: null },
    });
    await pd.rateTables.activate(SUPER_ADMIN, COMPANY, rateTableId, 'Contoh untuk uji');
    return rateTableId;
  }

  async function draftWithCi() {
    const proposal = await pd.proposals.create(agent(), leads.budi, CLIENT);
    return pd.proposals.addItem(agent(), proposal.id, proposal.version, PRODUCT_IDS.CI);
  }

  it('P19.15-T1 AC-5 a product with a table says so from the start; the card waits for an amount', async () => {
    const proposal = await draftWithCi();
    expect(proposal.items[0]).toMatchObject({
      payTerm: 'y10', payFrequency: 'monthly', fixedField: 'none', premium: null, rateTableVersionId: null,
      calc: { mode: 'table', state: 'needs_amount', tableId, effectiveFrom: '2026-04-01', frequencies: ['monthly', 'annual'] },
    });
  });

  it('P19.15-T1 AC-5 typing the UP gives the premium; typing the premium gives the UP rounded down and the note', async () => {
    let proposal = await draftWithCi();
    const id = proposal.items[0].itemId;
    proposal = await pd.proposals.updateItem(agent(), proposal.id, id, proposal.version, { up: { amountMinor: rp(500 * JT) } });
    // A man of 36, 10 years, non-smoker: 12,60 ‰ → Rp6.300.000 a year, × 0,09 = Rp567.000 a month.
    expect(proposal.items[0]).toMatchObject({
      fixedField: 'up', up: { amountMinor: rp(500 * JT) }, premium: { amountMinor: rp(567_000) },
      rateTableVersionId: tableId, rateTableEffectiveFrom: '2026-04-01', calcNote: null,
      totalPaid: { amountMinor: rp(567_000) * 12 * 10, years: 10 }, calc: { state: 'ok' },
    });
    proposal = await pd.proposals.updateItem(agent(), proposal.id, id, proposal.version, { premium: { amountMinor: rp(600_000) } });
    // Rp600.000 ÷ (12,60 ‰ × 0,09) = Rp529.100.529 → Rp529 jt; × 12,60 ‰ × 0,09 = Rp599.886.
    expect(proposal.items[0]).toMatchObject({
      fixedField: 'premium', up: { amountMinor: rp(529 * JT) }, premium: { amountMinor: rp(599_886) }, calcNote: 'up_rounded',
      calc: { stepMinor: rp(JT) },
    });
    // A chip keeps the fixed premium and works out the UP again: a smoker pays more for the same premium's UP.
    proposal = await pd.proposals.updateItem(agent(), proposal.id, id, proposal.version, { smoker: true });
    expect(proposal.items[0]).toMatchObject({ fixedField: 'premium', up: { amountMinor: rp(423 * JT) } });
    // Cara bayar: the UP is kept and the premium worked out for it.
    proposal = await pd.proposals.updateItem(agent(), proposal.id, id, proposal.version, { payFrequency: 'annual' });
    expect(proposal.items[0]).toMatchObject({ fixedField: 'up', up: { amountMinor: rp(423 * JT) }, premium: { amountMinor: rp(6_662_250) } });
  });

  it('P19.15-T1 AC-5 a limit is a message and a chip; a combination missing empties the premium and blocks Simpan PDF', async () => {
    let proposal = await draftWithCi();
    const id = proposal.items[0].itemId;
    proposal = await pd.proposals.updateItem(agent(), proposal.id, id, proposal.version, { up: { amountMinor: rp(50 * JT) } });
    expect(proposal.items[0].calc?.limit).toEqual({ kind: 'up_min', limitMinor: rp(100 * JT), chip: { field: 'up', amountMinor: rp(100 * JT) } });
    proposal = await pd.proposals.updateItem(agent(), proposal.id, id, proposal.version, { payTerm: 'y15', up: { amountMinor: rp(500 * JT) } });
    expect(proposal.items[0]).toMatchObject({ premium: null, calc: { state: 'missing_combination' } });
    await expect(pd.proposals.done(agent(), proposal.id, proposal.version)).rejects.toMatchObject({
      code: 'PROPOSAL_INCOMPLETE', details: { items: [{ itemId: id, missing: ['premium'] }] },
    });
  });

  it('P19.15-T1 AC-5 a client’s age or gender changed prices a Klien item again', async () => {
    let proposal = await draftWithCi();
    proposal = await pd.proposals.updateItem(agent(), proposal.id, proposal.items[0].itemId, proposal.version, { up: { amountMinor: rp(500 * JT) } });
    const updated = await pd.proposals.update(agent(), proposal.id, { expectedVersion: proposal.version, client: { gender: 'female' } });
    // A woman of 36: 12,60 ‰ × 0,85 = 10,71 ‰ → Rp481.950 a month.
    expect(updated.items[0].premium?.amountMinor).toBe(rp(481_950));
  });

  it('P19.15-T1 AC-6 a saved proposal keeps its version; a re-opened draft is calculated again with the note', async () => {
    let saved = await draftWithCi();
    saved = await pd.proposals.updateItem(agent(), saved.id, saved.items[0].itemId, saved.version, { up: { amountMinor: rp(500 * JT) } });
    saved = await pd.proposals.done(agent(), saved.id, saved.version);
    let draft = await draftWithCi();
    draft = await pd.proposals.updateItem(agent(), draft.id, draft.items[0].itemId, draft.version, { up: { amountMinor: rp(500 * JT) } });

    const december = await activate(rows(0.5), '2026-12-01');
    // Before 1 December nothing moves.
    expect((await pd.proposals.read(agent(), draft.id)).version).toBe(draft.version);
    // From 00:00 Asia/Jakarta on 1 December — 17:00 UTC the day before — the new version is in force.
    const later = productDataFor(wired, new Date('2026-11-30T17:00:00Z'));
    const reopened = await later.proposals.read(agent(), draft.id);
    expect(reopened.version).toBe(draft.version + 1);
    // 13,10 ‰ × Rp500 jt × 0,09 = Rp589.500.
    expect(reopened.items[0]).toMatchObject({
      calcNote: 'rates_updated', rateTableVersionId: december, rateTableEffectiveFrom: '2026-12-01', premium: { amountMinor: rp(589_500) },
    });
    const kept = await later.proposals.read(agent(), saved.id);
    expect(kept.items[0]).toMatchObject({ rateTableVersionId: tableId, rateTableEffectiveFrom: '2026-04-01', premium: { amountMinor: rp(567_000) } });
    expect(kept.version).toBe(saved.version);
    // A view-only session reads, and writes nothing.
    const another = await draftWithCi();
    const priced = await pd.proposals.updateItem(agent(), another.id, another.items[0].itemId, another.version, { up: { amountMinor: rp(500 * JT) } });
    expect((await later.proposals.read(viewAsAgent(), priced.id)).version).toBe(priced.version);
    // Simpan PDF on a draft read before the switch: calculated again and refused, 409, for the screen to show it.
    await expect(later.proposals.done(agent(), priced.id, priced.version)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const audit = await mongoose.model('AuditLogModel').findOne({ action: 'proposal.updated', 'after.reason': 'rate_table' }).lean();
    expect(audit).toMatchObject({ after: { fields: ['items.premium'], recalculated: 1 } });
  });

  it('P19.15-T1 AC-3 a table turned off: a draft’s calculated premium goes; a saved proposal keeps its numbers', async () => {
    let saved = await draftWithCi();
    saved = await pd.proposals.updateItem(agent(), saved.id, saved.items[0].itemId, saved.version, { up: { amountMinor: rp(500 * JT) } });
    saved = await pd.proposals.done(agent(), saved.id, saved.version);
    let draft = await draftWithCi();
    draft = await pd.proposals.updateItem(agent(), draft.id, draft.items[0].itemId, draft.version, { up: { amountMinor: rp(500 * JT) } });
    await pd.rateTables.turnOff(SUPER_ADMIN, COMPANY, tableId);
    const reopened = await pd.proposals.read(agent(), draft.id);
    expect(reopened.items[0]).toMatchObject({
      up: { amountMinor: rp(500 * JT) }, premium: null, calcNote: 'table_off', rateTableVersionId: null, calc: { mode: 'manual', state: 'table_off' },
    });
    expect((await pd.proposals.read(agent(), saved.id)).items[0]).toMatchObject({ premium: { amountMinor: rp(567_000) }, rateTableVersionId: tableId });
    // Typing again: the agent's figure, as any product without a table.
    const typed = await pd.proposals.updateItem(agent(), reopened.id, reopened.items[0].itemId, reopened.version, { premium: { amountMinor: rp(500_000) } });
    expect(typed.items[0]).toMatchObject({ premium: { amountMinor: rp(500_000) }, calc: null, calcNote: null });
    // The version a proposal used can no longer be deleted.
    await expect(pd.rateTables.remove(SUPER_ADMIN, COMPANY, tableId)).rejects.toMatchObject({ code: 'RATE_TABLE_IN_USE' });
  });

  it('P19.15-T1 AC-7 Uji coba gives exactly the agent’s premium, rounding and messages', async () => {
    let proposal = await draftWithCi();
    const id = proposal.items[0].itemId;
    for (const patch of [
      { up: { amountMinor: rp(500 * JT) } },
      { premium: { amountMinor: rp(600_000) } },
      { up: { amountMinor: rp(50 * JT) } },
      { smoker: true },
      { payFrequency: 'annual' as const },
      { payTerm: 'y15' },
    ]) {
      const before = proposal.items[0];
      proposal = await pd.proposals.updateItem(agent(), proposal.id, id, proposal.version, patch as never);
      const tried = await pd.data.tryIt(COMPANY, PRODUCT_IDS.CI, {
        age: CLIENT.age, gender: CLIENT.gender,
        state: {
          fieldValues: before.fieldValues, smoker: before.smoker, payTerm: before.payTerm, payFrequency: before.payFrequency,
          up: before.up?.amountMinor ?? null, premium: before.premium?.amountMinor ?? null, fixedField: before.fixedField,
        },
        patch: patch as never,
      });
      const card = proposal.items[0];
      expect({ up: tried.item.up, premium: tried.item.premium, fixed: tried.item.fixedField, note: tried.item.calcNote, calc: tried.item.calc })
        .toEqual({ up: card.up, premium: card.premium, fixed: card.fixedField, note: card.calcNote, calc: card.calc });
    }
  });
});
