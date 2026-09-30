import type { LeadType } from './lead.schema';

/**
 * **The keys `GET /leads` sorts on** (P10.1-T4 AC-3).
 *
 * `/leads` offers the prototype's four header sorts — *Lead name*, *Type*, *Status*, *Registered*
 * (`Overall.html:2805-2813`). `nextActionDate` is not one of them and stays anyway: coaching's
 * *Leads* card and the Summary may order by it, and a key a screen stops offering is not a key the
 * API has to stop answering.
 */
export const LEAD_SORT_KEYS = ['dateRegistered', 'name', 'nextActionDate', 'type', 'status'] as const;
export type LeadSortKey = (typeof LEAD_SORT_KEYS)[number];

/**
 * **The three keys the service orders, not the database.** *Type* and *Status* need the office's
 * ladders beside the row. *Lead name* needs a collation, and a collated query cannot use the
 * tenant's indexes, which compare `kpmId` byte for byte: it scans the whole collection, every
 * office's leads included. The service reads the whole filtered set for every sort anyway.
 */
export const IN_MEMORY_SORT_KEYS = ['type', 'status', 'name'] as const;
export type InMemorySortKey = (typeof IN_MEMORY_SORT_KEYS)[number];

export const isInMemorySort = (sort: LeadSortKey | undefined): sort is InMemorySortKey =>
  (IN_MEMORY_SORT_KEYS as readonly string[]).includes(sort ?? '');

/** A stage's place in its own pipeline, keyed by pipeline and code. */
export type LadderRanks = ReadonlyMap<string, number>;

/** What the comparison reads off a lead. */
export interface Orderable {
  _id: unknown;
  name: string | null;
  type: LeadType | null;
  statusCode: string | null;
  dateRegistered: Date | null;
}

const stageKey = (pipeline: string | null, code: string | null) => `${pipeline}:${code}`;

/**
 * **Each stage's place in its ladder, as the ladders are given.** The service passes the ladders
 * agents were last published, in the order their *Status* dropdown lists them, so the sort and the
 * dropdown cannot disagree. A stage retired and published since is not there, and a lead still on
 * it sorts as blank. That is how its row shows it too: the code, marked *(retired)*, untinted.
 *
 * Keyed by pipeline **and** code, because a place means nothing outside its own ladder.
 */
export function ladderRanks(
  ladders: readonly { pipeline: string; statuses: readonly { code: string }[] }[],
): LadderRanks {
  return new Map(ladders.flatMap((ladder) => ladder.statuses.map(
    (stage, place) => [stageKey(ladder.pipeline, stage.code), place] as [string, number],
  )));
}

/**
 * **Blank first, then Sales, then Recruitment** — the prototype's `typeValue`
 * (`Overall.html:5434-5436`). A lead with no ladder is usually the one just added.
 */
export function typeOrder(type: LeadType | null): number {
  return type === 'sales' ? 1 : type === 'recruitment' ? 2 : 0;
}

/**
 * **Case and accents do not count.** The prototype lowercases both names and compares them with
 * `localeCompare` (`Overall.html:5443-5445`, `:5488`), so *budi* sits between *Adi* and *Zed*.
 * A byte order puts every lowercase name after every capital, and a name here is stored as it was
 * typed, not capitalised as the prototype does (D-12).
 */
const NAMES = new Intl.Collator('id', { sensitivity: 'base' });

/**
 * The order of the prototype's *Lead name*, *Type* and *Status* columns (P10.1-T4 AC-3).
 *
 * **Status is the stage's place in its own ladder, blank first** (`Overall.html:5437-5439`). This is
 * the prototype's `statusRank`, read from the office's configuration instead of from two hardcoded
 * arrays. A stage the ladder does not hold counts as blank, which is what `indexOf` returning -1
 * does there.
 *
 * **D-06's objection gets a stated rule, not an unsortable column.** A sales rank 2 is not a
 * recruitment rank 2, so a tie on rank is broken by type, in the order above, and then by
 * registration, oldest first. The prototype leaves equal ranks in whatever order the browser's sort
 * keeps them.
 *
 * **Type ties on registration as well. Name ties go straight to the id.** The id breaks the last
 * tie of all three, so two equal leads cannot swap places between page 1 and page 2.
 *
 * **`desc` reverses the whole comparison**, tie-breaks included, as the prototype's `-cmp` does. No
 * `dir` means `desc`, the same default the database sorts use.
 */
export function leadOrder(
  sort: InMemorySortKey, dir: 'asc' | 'desc' | undefined, ranks: LadderRanks,
): (a: Orderable, b: Orderable) => number {
  const sign = dir === 'asc' ? 1 : -1;
  const rank = (lead: Orderable) => ranks.get(stageKey(lead.type, lead.statusCode)) ?? -1;
  const registered = (lead: Orderable) => lead.dateRegistered?.getTime() ?? 0;
  const id = (a: Orderable, b: Orderable) => {
    // Hex of one length compares in byte order; a collator would bring a locale into it.
    const [x, y] = [String(a._id), String(b._id)];
    return Number(x > y) - Number(x < y);
  };

  if (sort === 'name') {
    return (a, b) => sign * (NAMES.compare(a.name ?? '', b.name ?? '') || id(a, b));
  }
  return (a, b) => sign * (
    (sort === 'status' ? rank(a) - rank(b) : 0)
    || typeOrder(a.type) - typeOrder(b.type)
    || registered(a) - registered(b)
    || id(a, b)
  );
}
