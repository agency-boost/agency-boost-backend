import { DEMOGRAPHIC_DATA, type DemographicField } from '@/domain/constants/advanced-analytics';
import { wholePercent } from './rate';

/**
 * ***Demografi*'s data completeness** (P19.22-T2; ADR-0275 §2; `metrics-and-definitions.md` §A.15). Pure. Pinned by
 * `demographic-completeness.spec.ts`.
 *
 * - **`DEMOGRAPHIC_DATA_COMPLETE(m)` — *Data lengkap***: the member has every field of `DEMOGRAPHIC_DATA.REQUIRED_FIELDS`
 *   on file — *Status kerja*, *Tanggal lahir*, *Tanggal bergabung*. *Perlu melengkapi* is everybody else.
 * - **`DEMOGRAPHIC_FIELD_FILLED_PCT` — *Kelengkapan data*** per field: of the members counted, those with it on file,
 *   whole %; and the same over the leaders (AB, AAB) and over the agents, *Leader x% · Agent y%*.
 */

export interface DemographicFacts {
  role: string;
  workStatus: string | null;
  dateOfBirth: string | null;
  joinDate: string | null;
}

const filled = (m: DemographicFacts, field: DemographicField) => m[field] !== null && m[field] !== '';
const isLeaderRole = (role: string) => role === 'ab' || role === 'aab';

/** The required fields a member is missing, in the fields' order. */
export function missingFields(m: DemographicFacts): DemographicField[] {
  return DEMOGRAPHIC_DATA.REQUIRED_FIELDS.filter((f) => !filled(m, f));
}

/** `DEMOGRAPHIC_DATA_COMPLETE`. */
export function isDataComplete(m: DemographicFacts): boolean {
  return missingFields(m).length === 0;
}

export interface FieldCompleteness {
  field: DemographicField;
  filled: number;
  of: number;
  /** `null` over nobody. */
  pct: number | null;
  leaderPct: number | null;
  agentPct: number | null;
}

/** `DEMOGRAPHIC_FIELD_FILLED_PCT` for each required field. */
export function fieldCompleteness(members: readonly DemographicFacts[]): FieldCompleteness[] {
  const pctOf = (set: readonly DemographicFacts[], field: DemographicField) =>
    (set.length === 0 ? null : wholePercent(set.filter((m) => filled(m, field)).length, set.length));
  const leaders = members.filter((m) => isLeaderRole(m.role));
  const agents = members.filter((m) => !isLeaderRole(m.role));
  return DEMOGRAPHIC_DATA.REQUIRED_FIELDS.map((field) => ({
    field,
    filled: members.filter((m) => filled(m, field)).length,
    of: members.length,
    pct: pctOf(members, field),
    leaderPct: pctOf(leaders, field),
    agentPct: pctOf(agents, field),
  }));
}

/** *Ringkasan*: *Data lengkap* and *Perlu melengkapi*, with their shares of manpower. */
export function completenessSummary(members: readonly DemographicFacts[]): {
  complete: number; incomplete: number; completePct: number | null; incompletePct: number | null;
} {
  const complete = members.filter(isDataComplete).length;
  const incomplete = members.length - complete;
  return {
    complete,
    incomplete,
    completePct: members.length === 0 ? null : wholePercent(complete, members.length),
    incompletePct: members.length === 0 ? null : wholePercent(incomplete, members.length),
  };
}
