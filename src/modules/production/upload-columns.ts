import type { Sentence } from '@/common/i18n/sentence';
import type { AdvancedAnalyticsConfig, UploadField, UploadUnit } from '@/modules/config/analytics-config';
import { KODE_OF_CELL } from '@/modules/config/analytics-config';
import { minorToRpMillions, rpMillionsToMinor } from './production-units';
import { PRODUCTION_REFUSALS } from './production.messages';

/*
 * **The Data upload's columns, by kode** (P19.5-T2; ADR-0214 §5, §9, §11): what every part of the production module
 * shares about a column of the KPM's template — how a cell is named in the row and in a batch, when a column is in
 * force, which unit it is stored in, what a value of it may be, and how today's legacy cells map to kodes.
 *
 * Pure: a configuration in, answers out. The configuration is `AnalyticsConfigReader.publishedFor`'s, never a copy.
 */

const SAY = PRODUCTION_REFUSALS.UPLOAD_VALUE_OUT_OF_RANGE;

/** A kode's year-to-date cell in a file and in a batch row: `APE_YTD`. A kode never ends `_YTD` (ADR-0214 §2). */
export const YTD_SUFFIX = '_YTD';

/**
 * **One cell's key** — in a batch row's `values` and `previousValues`, in a commit's `replace` and in a preview's notes:
 * the kode for the month's figure, `<KODE>_YTD` for an uploaded year to date.
 */
export const cellKey = (kode: string, ytd: boolean): string => (ytd ? `${kode}${YTD_SUFFIX}` : kode);

/** `APE_YTD` → `{ kode: 'APE', ytd: true }`; `APE` → `{ kode: 'APE', ytd: false }`. */
export function parseCellKey(key: string): { kode: string; ytd: boolean } {
  return key.endsWith(YTD_SUFFIX) ? { kode: key.slice(0, -YTD_SUFFIX.length), ytd: true } : { kode: key, ytd: false };
}

/** **Where a cell lives on a `monthlyAgentData` row**: `values.APE` for the month, `ytdValues.APE` for an uploaded YTD. */
export const cellPath = (kode: string, ytd: boolean): string => `${ytd ? 'ytdValues' : 'values'}.${kode}`;

/** A column is **in force** in a month on or after its `effectiveFrom` (R2): before it, the month shows *—* for it. */
export const inForce = (field: Pick<UploadField, 'effectiveFrom'>, month: string): boolean => field.effectiveFrom <= month;

/** The configuration's current columns in force in `month`, in the file's order. */
export function columnsInForce(config: AdvancedAnalyticsConfig, month: string): UploadField[] {
  return config.uploadFields.filter((field) => inForce(field, month));
}

/**
 * **A kode's column in force in a month**, or `null` — archived, never added, or before its start (ADR-0214 §6): what
 * the three custom kodes' readers ask before they read a figure, so a column the template no longer holds reads
 * nothing, never 0.
 */
export function fieldInForce(config: AdvancedAnalyticsConfig, kode: string, month: string): UploadField | null {
  const field = config.uploadFields.find((f) => f.kode === kode);
  return field && inForce(field, month) ? field : null;
}

/** Money is stored in minor units (invariant §9); the file's *Rp juta* is converted where the two meet. */
export const isMoneyUnit = (unit: UploadUnit) => unit === 'rp_million';

/** A file value, in the column's unit, as stored: *Rp juta* to sen, the rest as written. */
export const toStored = (unit: UploadUnit, value: number): number => (isMoneyUnit(unit) ? rpMillionsToMinor(value) : value);

/** A stored value as the file would write it: sen to *Rp juta*, the rest as stored. */
export const toFile = (unit: UploadUnit, stored: number): number => (isMoneyUnit(unit) ? minorToRpMillions(stored) : stored);

/**
 * **Why a stored value cannot be held in this column** (ADR-0214 §5 step 5, AA UI-025), as the end of a sentence — or
 * `null` when it can. One definition, for the import and a correction alike (P9-T5 AC-5): a number, a whole number of
 * sen or of a count, at most 100 for a percentage, and within the column's own `min` and `max`, which are in the
 * column's unit (*Rp juta* for money).
 */
export function refusalForField(field: Pick<UploadField, 'unit' | 'min' | 'max'>, stored: number): Sentence<'UPLOAD_VALUE_OUT_OF_RANGE'> | null {
  if (!Number.isFinite(stored)) return SAY.notANumber;
  if (field.unit === 'rp_million' && !Number.isSafeInteger(stored)) return Number.isInteger(stored) ? SAY.tooLarge : SAY.fractionOfSen;
  if (field.unit === 'count' && !Number.isInteger(stored)) return SAY.notWholeCount;
  const shown = toFile(field.unit, stored);
  if (field.min !== null && shown < field.min) return field.min === 0 ? SAY.negative : SAY.belowMin({ min: field.min });
  if (field.max !== null && shown > field.max) {
    return field.unit === 'percent' && field.max === 100 ? SAY.persistencyAbove100 : SAY.aboveMax({ max: field.max });
  }
  if (field.unit === 'percent' && shown > 100) return SAY.persistencyAbove100;
  return null;
}

/** Whether a stored value sits outside the column's limits now (AA UI-025): flagged, never changed. */
export const outsideLimits = (field: Pick<UploadField, 'unit' | 'min' | 'max'>, stored: number): boolean => {
  const shown = toFile(field.unit, stored);
  return (field.min !== null && shown < field.min) || (field.max !== null && shown > field.max);
};

// --------------------------------------------------------------------------------------------- the legacy row

/**
 * **Today's month cells, each as the kode and cadence version 1 gives it** (ADR-0214 §9): `apeMonthly` is `APE`'s month,
 * `apeYtd` its year to date, and the leader rows' `unitPersistencyMonthly` is `UNIT_PERSISTENCY`'s month — it never had
 * a year to date. What migration `upload-values-by-kode` moves, and what nothing reads once it has.
 */
export const LEGACY_CELLS: Readonly<Record<string, { kode: string; ytd: boolean }>> = {
  ...Object.fromEntries(Object.entries(KODE_OF_CELL)
    .filter(([cell]) => cell !== 'unitPersistency')
    .flatMap(([cell, kode]) => [
      [`${cell}Monthly`, { kode, ytd: false }],
      [`${cell}Ytd`, { kode, ytd: true }],
    ])),
  unitPersistencyMonthly: { kode: 'UNIT_PERSISTENCY', ytd: false },
};

/** A legacy cell's name as a batch row's key: `apeMonthly` → `APE`, `apeYtd` → `APE_YTD`; a key already by kode as it is. */
export function keyOfLegacy(field: string): string {
  const legacy = LEGACY_CELLS[field];
  return legacy ? cellKey(legacy.kode, legacy.ytd) : field;
}

/**
 * **A row's cells by kode, from the legacy names** (ADR-0214 §9): every legacy cell `cells` holds, moved whole into
 * `values` or `ytdValues`. A cell with neither a value nor a provenance is left out — it is *no figure held*, and an
 * absent kode is that already. What the migration, the seed and the specs write a row with.
 */
export function byKode<T extends { value?: unknown; provenance?: unknown } | null | undefined>(
  cells: Readonly<Record<string, T>>,
): { values: Record<string, NonNullable<T>>; ytdValues: Record<string, NonNullable<T>> } {
  const values: Record<string, NonNullable<T>> = {};
  const ytdValues: Record<string, NonNullable<T>> = {};
  for (const [name, cell] of Object.entries(cells)) {
    const legacy = LEGACY_CELLS[name];
    if (!legacy || cell === null || cell === undefined) continue;
    if ((cell.value ?? null) === null && (cell.provenance ?? null) === null) continue;
    (legacy.ytd ? ytdValues : values)[legacy.kode] = cell as NonNullable<T>;
  }
  return { values, ytdValues };
}

/** A batch row's `values` or `previousValues`, re-keyed by kode: `apeMonthly` → `APE`, `apeYtd` → `APE_YTD`. */
export function rekeyByKode<T>(record: Readonly<Record<string, T>> | null | undefined): Record<string, T> {
  return Object.fromEntries(Object.entries(record ?? {}).map(([k, v]) => [keyOfLegacy(k), v]));
}
