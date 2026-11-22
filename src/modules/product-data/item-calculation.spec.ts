import { applyItemPatch, missingOf, newItem, type ProductForItem, type StoredItem } from '@/modules/proposals/proposal-items';
import { calcFailed, calculateItem, goalKeyOf, type TableForItem } from './item-calculation';
import type { EngineRow } from './premium-engine';

const rp = (rupiah: number) => rupiah * 100;
const JT = 1_000_000;

const PCB: ProductForItem = {
  _id: 'p1', code: 'PCB88', version: 1, channel: 'conventional', category: 'ci', calcType: 'up_premium', smokerRated: true,
  payTerms: [{ key: 'y10', label: '10 tahun', years: 10, toAge: null, single: false, maxEntryAge: 60, default: true }],
};
const row = (over: Partial<EngineRow> = {}): EngineRow => ({
  age: 35, gender: 'male', smoker: false, plan: null, payTerm: 'y10', currency: 'IDR', frequency: null, basis: 'per_mille',
  rate: 12.35, bandMin: null, bandMax: null, ...over,
});
const TABLE: TableForItem = {
  id: 't2', effectiveFrom: '2026-04-01', ageRated: true,
  rows: [row(), row({ gender: 'female', rate: 10.5 })],
  rules: { upStep: rp(JT), upMin: rp(100 * JT), upMax: null, premiumMin: null, premiumMax: null, entryAgeMin: null, entryAgeMax: null, payTermMaxAge: {} },
  frequencies: { monthly: 0.09, quarterly: null, semiannual: null, annual: null },
};
const WHO = { clientAge: 35, clientGender: 'male' as const };
const item = (product: ProductForItem = PCB): StoredItem => newItem('i1', product, 'PCB88', 35);
const typedUp = (amount: number) => applyItemPatch(item(), { up: { amountMinor: amount } }, 35);

describe('P19.15-T1 an item, calculated (ADR-0258 §5)', () => {
  it('P19.15-T1 AC-5 typing the UP gives the premium; the version and its date are kept with it', () => {
    const out = calculateItem(typedUp(rp(500 * JT)), WHO, TABLE, { typed: 'up' });
    expect(out).toMatchObject({
      up: { amountMinor: rp(500 * JT), currency: 'IDR' }, premium: { amountMinor: rp(555_750), currency: 'IDR' },
      fixedField: 'up', rateTableVersionId: 't2', rateTableEffectiveFrom: '2026-04-01', calcNote: null,
      calc: { mode: 'table', state: 'ok', tableId: 't2', effectiveFrom: '2026-04-01', frequencies: ['monthly', 'annual'], limit: null },
    });
  });

  it('P19.15-T1 AC-5 typing the premium gives the rounded UP, with the disesuaikan note', () => {
    const typed = applyItemPatch(item(), { premium: { amountMinor: rp(600_000) } }, 35);
    const out = calculateItem(typed, WHO, TABLE, { typed: 'premium' });
    expect(out).toMatchObject({ fixedField: 'premium', up: { amountMinor: rp(539 * JT) }, premium: { amountMinor: rp(599_099) }, calcNote: 'up_rounded' });
    expect(out.calc?.stepMinor).toBe(rp(JT));
  });

  it('P19.15-T1 AC-5 a chip changed keeps the fixed field: the insured’s gender is the client’s for Klien', () => {
    const first = calculateItem(typedUp(rp(500 * JT)), WHO, TABLE, { typed: 'up' });
    const female = calculateItem(first, { ...WHO, clientGender: 'female' }, TABLE);
    expect(female).toMatchObject({ fixedField: 'up', up: { amountMinor: rp(500 * JT) }, premium: { amountMinor: rp(472_500) } });
  });

  it('P19.15-T1 AC-5 a limit: the message and the chip, the amounts as typed', () => {
    const out = calculateItem(typedUp(rp(50 * JT)), WHO, TABLE, { typed: 'up' });
    expect(out.calc?.limit).toEqual({ kind: 'up_min', limitMinor: rp(100 * JT), chip: { field: 'up', amountMinor: rp(100 * JT) } });
    expect(out.up?.amountMinor).toBe(rp(50 * JT));
  });

  it('P19.15-T1 AC-5 a combination missing empties the premium, and Simpan PDF asks for it', () => {
    const other = { ...WHO, clientAge: 40 };
    const out = calculateItem(typedUp(rp(500 * JT)), other, TABLE, { typed: 'up' });
    expect(out).toMatchObject({ premium: null, rateTableVersionId: null, calc: { state: 'missing_combination' } });
    expect(calcFailed(out)).toBe(true);
    expect(missingOf(out)).toContain('premium');
    // A premium typed beside a failed calculation is not the table's.
    expect(missingOf({ ...out, premium: { amountMinor: rp(1), currency: 'IDR' } })).toContain('premium');
  });

  it('P19.15-T1 AC-6 a draft re-opened after a new version: the note names the update', () => {
    const before = calculateItem(typedUp(rp(500 * JT)), WHO, TABLE, { typed: 'up' });
    const next = calculateItem(before, WHO, { ...TABLE, id: 't3', effectiveFrom: '2026-12-01', rows: [row({ rate: 13 })] }, { refreshed: true });
    expect(next).toMatchObject({
      calcNote: 'rates_updated', rateTableVersionId: 't3', rateTableEffectiveFrom: '2026-12-01', premium: { amountMinor: rp(585_000) },
    });
  });

  it('P19.15-T1 AC-3 a version turned off with nothing before it: the calculated amount goes, the typed one stays', () => {
    const before = calculateItem(typedUp(rp(500 * JT)), WHO, TABLE, { typed: 'up' });
    const off = calculateItem(before, WHO, null);
    expect(off).toMatchObject({
      up: { amountMinor: rp(500 * JT) }, premium: null, fixedField: 'none', rateTableVersionId: null, calcNote: 'table_off',
      calc: { mode: 'manual', state: 'table_off' },
    });
    // The agent then types: the note goes, and the item is typed like any other.
    const typed = calculateItem({ ...off, premium: { amountMinor: rp(9), currency: 'IDR' } }, WHO, null, { touched: true });
    expect(typed).toMatchObject({ calc: null, calcNote: null, premium: { amountMinor: rp(9) } });
    // Read again without a write, it stays as it was.
    expect(calculateItem(off, WHO, null)).toBe(off);
  });

  it('a premium fixed, the version gone: the premium stays', () => {
    const typed = applyItemPatch(item(), { premium: { amountMinor: rp(600_000) } }, 35);
    const before = calculateItem(typed, WHO, TABLE, { typed: 'premium' });
    expect(calculateItem(before, WHO, null)).toMatchObject({ premium: { amountMinor: rp(599_099) }, up: null });
  });

  it('a manual product, or one never calculated: as typed', () => {
    const manual = item({ ...PCB, calcType: 'manual' });
    expect(calculateItem(manual, WHO, TABLE)).toBe(manual);
    const noTable = item();
    expect(calculateItem(noTable, WHO, null)).toBe(noTable);
    // A card that calculated nothing yet, its table gone: back to typing.
    const waiting = calculateItem(item(), WHO, TABLE);
    expect(waiting.calc?.state).toBe('needs_amount');
    expect(calculateItem(waiting, WHO, null)).toMatchObject({ calc: null, calcNote: null });
  });

  it('the insured’s own age and gender for anyone but Klien', () => {
    const spouse = applyItemPatch(typedUp(rp(500 * JT)), { insured: { relation: 'spouse', name: 'Rina', age: 35, gender: 'female' } }, 35);
    expect(calculateItem(spouse, WHO, TABLE).premium?.amountMinor).toBe(rp(472_500));
    const noGender = applyItemPatch(spouse, { insured: { relation: 'spouse', gender: null } }, 35);
    expect(calculateItem(noGender, WHO, TABLE).calc).toMatchObject({ state: 'needs_input', missing: 'gender' });
  });

  it('the fixed amount of an item made before 19.15, inferred', () => {
    const premiumOnly = { ...applyItemPatch(item(), { premium: { amountMinor: rp(555_750) } }, 35), fixedField: 'none' as const };
    expect(calculateItem(premiumOnly, WHO, TABLE).fixedField).toBe('premium');
    const nothing = calculateItem({ ...item(), fixedField: 'none' }, WHO, TABLE);
    expect(nothing.calc?.state).toBe('needs_amount');
  });

  it('goal: the first money field is the goal; premium_benefit answers the benefit as up; plan_priced needs nothing', () => {
    const goalProduct: ProductForItem = {
      ...PCB, calcType: 'goal', smokerRated: false,
      proposalFields: [{
        key: 'target', label: 'Target dana', labelSyariah: null, type: 'money', options: [], default: null, quickAmounts: [],
        minMinor: null, showOnPdf: true, showOnSummary: false, paymentYears: false, plan: false, currency: false, draft: false,
      }],
    };
    expect(goalKeyOf(item(goalProduct).snapshot)).toBe('target');
    expect(goalKeyOf(item().snapshot)).toBeNull();
    const goal = applyItemPatch(item(goalProduct), { fieldValues: { target: rp(200 * JT) } }, 35);
    expect(calculateItem(goal, WHO, TABLE, { typed: 'goal' })).toMatchObject({ fixedField: 'goal', premium: { amountMinor: rp(222_300) } });
    expect(calculateItem(item(goalProduct), WHO, TABLE).calc?.state).toBe('needs_amount');

    const benefit = applyItemPatch(item({ ...PCB, calcType: 'premium_benefit' }), { premium: { amountMinor: rp(500_000) } }, 35);
    expect(calculateItem(benefit, WHO, { ...TABLE, rows: [row({ rate: 20_000 })] })).toMatchObject({
      fixedField: 'premium', premium: { amountMinor: rp(500_000) }, up: { amountMinor: rp(111_111_111) },
    });

    const plan = item({ ...PCB, calcType: 'plan_priced' });
    const priced = calculateItem(plan, WHO, { ...TABLE, rows: [row({ basis: 'per_plan', rate: rp(4_800_000) })] });
    expect(priced).toMatchObject({ fixedField: 'none', premium: { amountMinor: rp(432_000) } });
    // Its table gone: the premium goes, nothing else was typed.
    expect(calculateItem(priced, WHO, null)).toMatchObject({ premium: null, up: null, calcNote: 'table_off' });
    // A product with no pay term: priced by its rows for any term.
    const noTerms = item({ ...PCB, calcType: 'plan_priced', payTerms: [] });
    expect(calculateItem(noTerms, WHO, { ...TABLE, rows: [row({ basis: 'per_plan', payTerm: null, rate: rp(1_200_000) })] }).premium?.amountMinor)
      .toBe(rp(108_000));
  });
});
