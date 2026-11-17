import { DateTime } from 'luxon';
import { PRODUCT_DATA, type RateTableStatus } from '@/domain/constants';

/**
 * **A premium table version's state, and which version is in force on a day** (P19.15-T1 AC-3; ADR-0258 §2). Pure:
 * every caller passes *today* as the KPM's calendar day in Asia/Jakarta (the Clock port's `localDateFor`), so a version
 * whose *Berlaku mulai* is tomorrow is in force from 00:00 tomorrow with no job switching it on — the state is worked out
 * on every read. `YYYY-MM-DD` strings compare as days.
 */

/** What the rules read of a version. */
export interface VersionFacts {
  id: string;
  version: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  activatedAt: Date | null;
  turnedOffAt: Date | null;
  deletedAt?: Date | null;
}

/** **May this version be in force on `day`?** Activated, not turned off or deleted, and `day` inside its dates. */
export function coversDay(table: VersionFacts, day: string): boolean {
  return table.activatedAt !== null && table.turnedOffAt === null && !table.deletedAt
    && table.effectiveFrom <= day && (table.effectiveTo === null || day <= table.effectiveTo);
}

/**
 * **The version in force on `day`** among one product's: of those that may be, the latest *Berlaku mulai*, and of two on
 * the same day the higher version. `null` — no table — is *Ketik manual*. Turning the newest off brings back the one
 * before it, where its own dates still cover the day (P1b *Undo*).
 */
export function inForceOn<T extends VersionFacts>(tables: readonly T[], day: string): T | null {
  let best: T | null = null;
  for (const table of tables) {
    if (!coversDay(table, day)) continue;
    if (best === null || table.effectiveFrom > best.effectiveFrom
      || (table.effectiveFrom === best.effectiveFrom && table.version > best.version)) best = table;
  }
  return best;
}

/**
 * **A version's state on `day`** (`RATE_TABLE_STATUSES`): *off* once turned off; *draft* until activated; *scheduled*
 * before its *Berlaku mulai*; *active* when it is the one in force; else *old* — superseded, or past its *Berlaku sampai*.
 * `siblings` are the product's versions, itself among them.
 */
export function statusOf(table: VersionFacts, day: string, siblings: readonly VersionFacts[]): RateTableStatus {
  if (table.turnedOffAt !== null) return 'off';
  if (table.activatedAt === null) return 'draft';
  if (table.effectiveFrom > day) return 'scheduled';
  return inForceOn(siblings, day)?.id === table.id ? 'active' : 'old';
}

/** The first activated version, not off, that starts after `day` — *"Tarif baru mulai {date}"*. */
export function nextScheduled<T extends VersionFacts>(tables: readonly T[], day: string): T | null {
  return tables
    .filter((t) => t.activatedAt !== null && t.turnedOffAt === null && !t.deletedAt && t.effectiveFrom > day)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : a.version - b.version))[0] ?? null;
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD` (calendar days, no clock involved). */
export function daysBetween(from: string, to: string): number {
  return Math.round(DateTime.fromISO(to, { zone: 'utc' }).diff(DateTime.fromISO(from, { zone: 'utc' }), 'days').days);
}

/**
 * **Ending soon** (*Perlu dicek*'s first reason, P1b §1): the version in force ends within `PRODUCT_DATA.CHECK_WINDOW_DAYS`
 * of `day` and no version is scheduled to start after it — once one is, nothing needs attention.
 */
export function endingSoon(inForce: VersionFacts | null, scheduled: VersionFacts | null, day: string): boolean {
  if (!inForce || inForce.effectiveTo === null || scheduled !== null) return false;
  return daysBetween(day, inForce.effectiveTo) <= PRODUCT_DATA.CHECK_WINDOW_DAYS;
}
