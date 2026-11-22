import type {
  CalcNote, CalcState, LeadGender, ProposalPayFrequency,
} from '@/domain/constants';
import {
  currencyOf, insuredAgeOf, payTermOf, planOf, type ItemSnapshot, type StoredItem,
} from '@/modules/proposals/proposal-items';
import { calculate, type EngineLimit, type EngineTable, type FixedAmount } from './premium-engine';

/**
 * **A proposal item, calculated** (P19.15-T1 AC-5, AC-6; ADR-0258 §5): the bridge between an item as the proposal
 * stores it and the engine. Pure — the service loads the version in force and its rows — so the item's rules are unit
 * tests (`item-calculation.spec.ts`), and *Uji coba* runs the very same function on an item it never stores (AC-7).
 */

/** **What a card shows of its calculation**, stored on the item with its amounts and answered with it. */
export interface ItemCalc {
  /** `table`: a version is in force and the card calculates. `manual`: the version it calculated with went (`table_off`). */
  mode: 'table' | 'manual';
  state: CalcState;
  /** The version in force when it was calculated, and its *Berlaku mulai* — *"Tabel tarif berlaku {tanggal}"*. */
  tableId: string | null;
  effectiveFrom: string | null;
  /** The *Cara bayar* the table prices for this item; the card offers no other. */
  frequencies: ProposalPayFrequency[];
  limit: EngineLimit | null;
  /** The UP step behind *"Premi disesuaikan karena UP dibulatkan ke {step}"*. */
  stepMinor: number | null;
  missing: 'age' | 'gender' | null;
  ageBounds: { min: number | null; max: number | null } | null;
}

/** A version in force, as an item is calculated with it. */
export interface TableForItem extends EngineTable {
  id: string;
  effectiveFrom: string;
}

/** Who the item is for: the proposal's client, whose age and gender a *Klien* item is priced by. */
export interface ItemPerson {
  clientAge: number | null;
  clientGender: LeadGender | null;
}

export interface CalcOptions {
  /** The amount a write typed — it becomes the fixed one. */
  typed?: FixedAmount;
  /** *Cara bayar* just changed (the premium was emptied by it). */
  frequencyChanged?: boolean;
  /** A draft re-opened after another version took effect: *"Premi diperbarui ke tarif {date}"*. */
  refreshed?: boolean;
  /** A write touched the item: a leftover *table_off* note goes. */
  touched?: boolean;
}

/** **The goal amount's field** (`goal`): the product's first `money` field, whose value the premium is worked out from. */
export function goalKeyOf(snapshot: Pick<ItemSnapshot, 'fields'>): string | null {
  return snapshot.fields.find((f) => f.type === 'money')?.key ?? null;
}

/** **The amount kept**: what was typed now, else what was fixed before, else what an item made before 19.15 holds. */
function fixedOf(item: StoredItem, typed: FixedAmount | undefined): FixedAmount {
  if (typed) return typed;
  if (item.fixedField !== 'none') return item.fixedField;
  switch (item.snapshot.calcType) {
    case 'up_premium': return item.up !== null ? 'up' : item.premium !== null ? 'premium' : 'none';
    case 'goal': return 'goal';
    case 'premium_benefit': return 'premium';
    default: return 'none';
  }
}

/**
 * **The item calculated with `table`, or as typed without one** (ADR-0258 §5):
 *
 * - **A `manual` product, or no version in force**, is the agent's to type. An item whose amounts came from a version
 *   that is no longer in force — turned off, nothing before it — has its calculated amount emptied, *"table_off"*: a
 *   number from a table found wrong never prints. Its typed one stays.
 * - **Otherwise the engine** with the item's insured (the client's age and gender for *Klien*), smoker, plan, pay term,
 *   *Cara bayar*, currency and amounts. The fixed amount is kept; the calculated one written, or emptied with its reason.
 *   `rateTableVersionId` names the version only where it produced the amounts, so the PDF prints *"Tabel tarif
 *   berlaku"* for exactly those, and *"dari ilustrasi resmi"* for the rest.
 */
export function calculateItem(item: StoredItem, who: ItemPerson, table: TableForItem | null, opts: CalcOptions = {}): StoredItem {
  const { calcType } = item.snapshot;
  if (calcType === 'manual' || table === null) {
    if (item.rateTableVersionId !== null) {
      // The calculated amount goes; the typed one stays (`fixedField`).
      const keepUp = item.fixedField === 'up';
      const keepPremium = item.fixedField === 'premium';
      return {
        ...item,
        up: keepUp ? item.up : calcType === 'up_premium' || calcType === 'premium_benefit' ? null : item.up,
        premium: keepPremium ? item.premium : null,
        fixedField: 'none',
        rateTableVersionId: null,
        rateTableEffectiveFrom: null,
        calcNote: 'table_off',
        calc: {
          mode: 'manual', state: 'table_off', tableId: null, effectiveFrom: null, frequencies: [], limit: null,
          stepMinor: null, missing: null, ageBounds: null,
        },
      };
    }
    if (item.calc && (opts.touched || item.calc.mode === 'table')) return { ...item, calc: null, calcNote: null, fixedField: 'none' };
    return item;
  }

  const currency = currencyOf(item.snapshot, item.fieldValues);
  const goalKey = goalKeyOf(item.snapshot);
  const goalValue = goalKey !== null ? item.fieldValues[goalKey] : undefined;
  const term = payTermOf(item);
  const gender = item.insured.relation === 'client' ? who.clientGender : item.insured.gender;
  const result = calculate(table, {
    calcType,
    profile: {
      age: insuredAgeOf(item, who.clientAge),
      gender,
      smoker: item.smoker,
      plan: planOf(item),
      payTerm: item.payTerm,
      currency,
    },
    payFrequency: item.payFrequency,
    singlePayTerm: term?.single ?? false,
    fixed: fixedOf(item, opts.typed),
    up: item.up?.amountMinor ?? null,
    premium: item.premium?.amountMinor ?? null,
    goal: typeof goalValue === 'number' ? goalValue : null,
    frequencyChanged: opts.frequencyChanged,
  });
  const money = (amount: number | null) => (amount === null ? null : { amountMinor: amount, currency });
  const calculated = result.state === 'ok';
  const note: CalcNote | null = calculated && opts.refreshed ? 'rates_updated' : result.note;
  return {
    ...item,
    up: calcType === 'up_premium' || calcType === 'premium_benefit' ? money(result.up) : item.up,
    premium: calcType === 'premium_benefit' ? item.premium : money(result.premium),
    fixedField: result.fixed,
    rateTableVersionId: calculated ? table.id : null,
    rateTableEffectiveFrom: calculated ? table.effectiveFrom : null,
    calcNote: note,
    calc: {
      mode: 'table',
      state: result.state,
      tableId: table.id,
      effectiveFrom: table.effectiveFrom,
      frequencies: result.frequencies,
      limit: result.limit,
      stepMinor: result.stepMinor,
      missing: result.missing,
      ageBounds: result.ageBounds,
    },
  };
}

/** **A calculation that failed** — the card shows why, and *Simpan PDF* asks for the premium (P1 spec: *stale numbers never print*). */
export function calcFailed(item: Pick<StoredItem, 'calc'>): boolean {
  return item.calc?.mode === 'table' && item.calc.state !== 'ok';
}
