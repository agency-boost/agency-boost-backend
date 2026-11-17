import mongoose from 'mongoose';
import { localDayOf } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE, PROPOSAL_PERIODIC_FREQUENCIES, needTagFor } from '@/domain/constants';

/**
 * **Every proposal takes the shape of 11 November** (P19.14-T1, T2; ADR-0254 §1, ADR-0255 §1, §2, §6; the spec's
 * *Data*: "the 3 Nov `channel` and `pay_frequency` columns move to the item").
 *
 * - **`channel` and `payFrequency` move onto each item**: the proposal's *Cara bayar* becomes each item's own, and an item
 *   on a *Syariah* proposal reads as a syariah product (`snapshot.isSyariah`) — **under the name it showed**: a
 *   conventional product's `syariahName` becomes the snapshot's `name` where the proposal was *Syariah*, as the screen and
 *   the PDF read it then. Both are removed from the proposal.
 * - **Each item gains what P19.14 stores**: the insured's `gender` (`null`), `smoker` (`null`), `payTerm` (`null` — the
 *   item's own `paymentYears` field still gives *Total dibayar*), `up` (`null`), `fixedField: 'none'`, the three 19.15
 *   fields (`null`), and a snapshot with `needTag` (its category's), `calcType: 'manual'`, no plan rule, no pay terms, the
 *   four periodic *Cara bayar*, no smoker rating, no entry ages and no limits. A premium not typed is `null`.
 * - **The client keeps its name, age and gender** — copied from the lead when it was made (ADR-0224) — and gains
 *   `ageSetOn`, the KPM's day the proposal was made, and empty `details`. **Nothing is written to a lead**, and no lead's
 *   age or gender is touched: they stay where they are, read by nothing (ADR-0254 §5).
 * - **Reversible**: what it removes is kept on the proposal as `migrated0063` (`channel`, `payFrequency`, and each renamed
 *   item's former name), and `down` puts the 3 November shape back.
 *
 * **Idempotent**: only a proposal that still carries `channel` or `payFrequency` is written; a second run writes none.
 * Soft-deleted proposals are written too, so *Riwayat*'s deleted-lead rows and the lead's notes read the same shape.
 */

interface OldItem {
  itemId: string;
  snapshot: Record<string, unknown> & { name: string; syariahName?: string | null; category: string };
  insured: Record<string, unknown>;
  premium?: { amountMinor: number | null; currency: string } | null;
  [key: string]: unknown;
}

const PERIODIC = [...PROPOSAL_PERIODIC_FREQUENCIES];

/** One item of 3 November, in the shape of 11 November. */
export function itemUp(item: OldItem, channel: string, payFrequency: string): { item: Record<string, unknown>; renamedFrom: string | null } {
  const syariah = channel === 'syariah';
  const renamed = syariah && item.snapshot.syariahName ? item.snapshot.syariahName : null;
  const premium = item.premium && typeof item.premium.amountMinor === 'number'
    ? { amountMinor: item.premium.amountMinor, currency: item.premium.currency }
    : null;
  return {
    renamedFrom: renamed ? item.snapshot.name : null,
    item: {
      ...item,
      snapshot: {
        ...item.snapshot,
        name: renamed ?? item.snapshot.name,
        needTag: needTagFor(item.snapshot.category),
        isSyariah: syariah,
        calcType: 'manual',
        planRule: null,
        payTerms: [],
        frequencies: PERIODIC,
        smokerRated: false,
        entryAge: null,
        limits: { upStep: null, upMin: null, upMax: null, premiumMin: null, premiumMax: null },
      },
      insured: { ...item.insured, gender: (item.insured.gender as string | undefined) ?? null },
      smoker: null,
      payTerm: null,
      payFrequency: PERIODIC.includes(payFrequency as never) ? payFrequency : 'monthly',
      up: null,
      premium,
      fixedField: 'none',
      rateTableVersionId: null,
      rateTableEffectiveFrom: null,
      calcNote: null,
    },
  };
}

export async function up(db: mongoose.mongo.Db): Promise<{ proposals: number; items: number; renamed: number }> {
  const proposals = db.collection('proposals');
  const zones = new Map<string, string>();
  const zoneOf = async (kpmId: string) => {
    if (!zones.has(kpmId)) {
      const kpm = mongoose.isValidObjectId(kpmId)
        ? await db.collection('kpms').findOne({ _id: new mongoose.Types.ObjectId(kpmId) }, { projection: { timezone: 1 } })
        : null;
      zones.set(kpmId, (kpm?.timezone as string | undefined) ?? DEFAULT_TENANT_TIMEZONE);
    }
    return zones.get(kpmId)!;
  };

  let written = 0;
  let items = 0;
  let renamed = 0;
  const cursor = proposals.find({ $or: [{ channel: { $exists: true } }, { payFrequency: { $exists: true } }] });
  for await (const doc of cursor) {
    const channel = (doc.channel as string | undefined) ?? 'conventional';
    const payFrequency = (doc.payFrequency as string | undefined) ?? 'monthly';
    const names: Record<string, string> = {};
    const next = ((doc.items ?? []) as OldItem[]).map((item) => {
      const moved = itemUp(item, channel, payFrequency);
      if (moved.renamedFrom !== null) names[item.itemId] = moved.renamedFrom;
      return moved.item;
    });
    const client = (doc.client ?? {}) as Record<string, unknown>;
    const made = (doc.createdAt as Date | undefined) ?? new Date(0);
    const result = await proposals.updateOne(
      { _id: doc._id, $or: [{ channel: { $exists: true } }, { payFrequency: { $exists: true } }] },
      {
        $set: {
          items: next,
          client: {
            name: client.name,
            age: client.age ?? null,
            ageSetOn: (client.ageSetOn as string | undefined) ?? (client.age == null ? null : localDayOf(made, await zoneOf(String(doc.kpmId)))),
            gender: client.gender ?? null,
            details: client.details ?? { status: null, dependants: null, occupation: null, city: null, needs: [], needsOther: null },
          },
          migrated0063: { channel, payFrequency, names },
        },
        $unset: { channel: '', payFrequency: '' },
      },
    );
    if (result.modifiedCount > 0) {
      written += 1;
      items += next.length;
      renamed += Object.keys(names).length;
    }
  }
  return { proposals: written, items, renamed };
}

/** The keys P19.14 added to an item, which `down` takes away again. */
const ITEM_KEYS = ['smoker', 'payTerm', 'payFrequency', 'up', 'fixedField', 'rateTableVersionId', 'rateTableEffectiveFrom', 'calcNote'];
const SNAPSHOT_KEYS = ['needTag', 'isSyariah', 'calcType', 'planRule', 'payTerms', 'frequencies', 'smokerRated', 'entryAge', 'limits'];

/** The item's currency where it has no premium: the 3 November rule (ADR-0225 §8), for `down`. */
function currencyOf(snapshot: Record<string, unknown>, fieldValues: Record<string, unknown>): string {
  const currencies = (snapshot.currencies as string[] | undefined) ?? ['IDR'];
  if (currencies.length === 1 && currencies[0] === 'USD') return 'USD';
  const field = ((snapshot.fields as Record<string, unknown>[] | undefined) ?? []).find((f) => f.currency);
  if (!field || currencies.length < 2) return 'IDR';
  const chosen = ((field.options as { label: string; currency?: string }[]) ?? []).find((o) => o.label === fieldValues[field.key as string]);
  return chosen?.currency ?? 'IDR';
}

/**
 * **The 3 November shape again**: each proposal's `channel` and `payFrequency` from what `up` kept (a proposal made since
 * reads *Syariah* when an item is a syariah product, and its first item's *Cara bayar*), each item's former name, a
 * premium not typed as `{ amountMinor: null }`, and the client's `{ name, age, gender }`. The keys P19.14 added go.
 */
export async function down(db: mongoose.mongo.Db): Promise<{ proposals: number }> {
  const proposals = db.collection('proposals');
  let written = 0;
  for await (const doc of proposals.find({ channel: { $exists: false } })) {
    const kept = (doc.migrated0063 ?? null) as { channel: string; payFrequency: string; names: Record<string, string> } | null;
    const items = (doc.items ?? []) as Record<string, unknown>[];
    const first = items[0] as { payFrequency?: string } | undefined;
    const channel = kept?.channel ?? (items.some((i) => (i.snapshot as { isSyariah?: boolean }).isSyariah) ? 'syariah' : 'conventional');
    const payFrequency = kept?.payFrequency
      ?? (first?.payFrequency && PERIODIC.includes(first.payFrequency as never) ? first.payFrequency : 'monthly');
    const back = items.map((item) => {
      const snapshot = { ...(item.snapshot as Record<string, unknown>) };
      for (const key of SNAPSHOT_KEYS) delete snapshot[key];
      const former = kept?.names?.[item.itemId as string];
      if (former) snapshot.name = former;
      const premium = item.premium as { amountMinor: number; currency: string } | null;
      const out: Record<string, unknown> = {
        ...item,
        snapshot,
        insured: { relation: (item.insured as Record<string, unknown>).relation, name: (item.insured as Record<string, unknown>).name ?? null, age: (item.insured as Record<string, unknown>).age ?? null },
        premium: premium ?? { amountMinor: null, currency: currencyOf(item.snapshot as Record<string, unknown>, (item.fieldValues ?? {}) as Record<string, unknown>) },
      };
      for (const key of ITEM_KEYS) delete out[key];
      return out;
    });
    const client = (doc.client ?? {}) as Record<string, unknown>;
    await proposals.updateOne(
      { _id: doc._id },
      {
        $set: { channel, payFrequency, items: back, client: { name: client.name, age: client.age, gender: client.gender } },
        $unset: { migrated0063: '' },
      },
    );
    written += 1;
  }
  return { proposals: written };
}
