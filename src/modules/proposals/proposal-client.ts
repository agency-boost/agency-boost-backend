import { InvalidRequestException } from '@/common/errors/domain.exception';
import { plainText } from '@/common/validation/plain-text';
import {
  LEAD_AGE, LEAD_GENDERS, PROPOSAL_CLIENT_NEEDS, PROPOSAL_CLIENT_STATUSES, PROPOSAL_CLIENT_TEXT_MAX,
  type LeadGender, type ProposalClientNeed, type ProposalClientStatus,
} from '@/domain/constants';
import { ageToday } from '@/modules/leads/lead-age';
import { checkedAge } from './proposal-items';
import { PROPOSAL_REFUSALS } from './proposals.messages';

/**
 * **The client, on the proposal and nowhere else** (P19.14-T1; ADR-0254 §1–§4; the 11 Nov spec's *Step 1b* and
 * *Data*): the name copied from the lead, and the age at the next birthday, the gender and the optional details the agent
 * enters at step 1 — **never written back to the lead**, which stays general (decision 10). Pure, so each rule is a unit
 * test (`proposal-client.spec.ts`), and the service, the seed and the migration read one definition.
 */

/** *Detail klien (opsional)*: each prints on the PDF only when filled (ADR-0254 §3). */
export interface ProposalClientDetails {
  status: ProposalClientStatus | null;
  /** *Tanggungan*, free text (*"Istri, 2 anak"*). */
  dependants: string | null;
  occupation: string | null;
  city: string | null;
  /** *Yang dibahas*, in `PROPOSAL_CLIENT_NEEDS`' order, each once. */
  needs: ProposalClientNeed[];
  /** *Lainnya*'s own words, kept only while `OTHER` is among the needs. */
  needsOther: string | null;
}

/** The client as a proposal stores it. */
export interface ProposalClient {
  /** The lead's name, copied when the lead was chosen. */
  name: string;
  /** The age at the next birthday on `ageSetOn` — what the premium was quoted for. */
  age: number | null;
  /** The KPM's day (`YYYY-MM-DD`, Asia/Jakarta) the age was entered; the prefill moves it up from here. */
  ageSetOn: string | null;
  gender: LeadGender | null;
  details: ProposalClientDetails;
}

/** What a write may send of the client: the name is the lead's, never sent. */
export interface ClientInput {
  age?: unknown;
  gender?: unknown;
  details?: unknown;
}

export const EMPTY_CLIENT_DETAILS: ProposalClientDetails = {
  status: null, dependants: null, occupation: null, city: null, needs: [], needsOther: null,
};

const SAY = PROPOSAL_REFUSALS.VALIDATION_FAILED;

function refuse(field: string): never {
  throw new InvalidRequestException(SAY.clientShape({ field }), { field });
}

function optionalLine(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') refuse(field);
  const clean = plainText(value);
  if (clean.length > max) throw new InvalidRequestException(SAY.clientText({ field, max }), { field });
  return clean === '' ? null : clean;
}

/**
 * ***Detail klien*, checked whole** (ADR-0254 §3): every key optional, an unknown one refused; the texts one line,
 * markup out, blank as `null`; the needs each one of `PROPOSAL_CLIENT_NEEDS`, stored once each in its order; *Lainnya*'s
 * words dropped when `OTHER` is not chosen.
 */
export function checkClientDetails(value: unknown): ProposalClientDetails {
  if (value === undefined || value === null) return { ...EMPTY_CLIENT_DETAILS, needs: [] };
  if (typeof value !== 'object' || Array.isArray(value)) refuse('client.details');
  const o = value as Record<string, unknown>;
  const known = ['status', 'dependants', 'occupation', 'city', 'needs', 'needsOther'];
  const unknown = Object.keys(o).find((key) => !known.includes(key) && o[key] !== undefined);
  if (unknown) refuse(`client.details.${unknown}`);
  if (o.status !== undefined && o.status !== null && !(PROPOSAL_CLIENT_STATUSES as readonly unknown[]).includes(o.status)) {
    refuse('client.details.status');
  }
  const needs = o.needs === undefined || o.needs === null ? [] : o.needs;
  if (!Array.isArray(needs) || needs.some((need) => !(PROPOSAL_CLIENT_NEEDS as readonly unknown[]).includes(need))) {
    refuse('client.details.needs');
  }
  const chosen = PROPOSAL_CLIENT_NEEDS.filter((need) => (needs as unknown[]).includes(need));
  const other = optionalLine(o.needsOther, 'client.details.needsOther', PROPOSAL_CLIENT_TEXT_MAX.NEEDS_OTHER);
  return {
    status: (o.status ?? null) as ProposalClientStatus | null,
    dependants: optionalLine(o.dependants, 'client.details.dependants', PROPOSAL_CLIENT_TEXT_MAX.DEPENDANTS),
    occupation: optionalLine(o.occupation, 'client.details.occupation', PROPOSAL_CLIENT_TEXT_MAX.OCCUPATION),
    city: optionalLine(o.city, 'client.details.city', PROPOSAL_CLIENT_TEXT_MAX.CITY),
    needs: chosen,
    needsOther: chosen.includes('OTHER') ? other : null,
  };
}

/**
 * **The client a write leaves** (ADR-0254 §2): the stored one with what was sent laid over it. The age and the gender
 * are **required** — *Lanjut* needs both (P19.14-T1 AC-3) — so a proposal never holds a client without them; an age that
 * changes is dated today (`ageSetOn`), one sent unchanged keeps its day. `details`, when sent, replaces the whole.
 * The age outside 1–100 is `422 LEAD_AGE_OUT_OF_RANGE`; anything else malformed `400 VALIDATION_FAILED`.
 */
export function clientAfter(
  stored: Pick<ProposalClient, 'age' | 'ageSetOn' | 'gender' | 'details'> | null,
  input: ClientInput,
  name: string,
  today: string,
): ProposalClient {
  const age = input.age === undefined ? stored?.age ?? null : checkedAge(input.age, 'client.age');
  const gender = input.gender === undefined ? stored?.gender ?? null : input.gender;
  if (gender !== null && !(LEAD_GENDERS as readonly unknown[]).includes(gender)) refuse('client.gender');
  if (age === null || gender === null) {
    throw new InvalidRequestException(SAY.clientNeedsAgeAndGender, { field: age === null ? 'client.age' : 'client.gender' });
  }
  const ageSetOn = stored && stored.age === age && stored.ageSetOn ? stored.ageSetOn : today;
  return {
    name,
    age,
    ageSetOn,
    gender: gender as LeadGender,
    details: input.details === undefined
      ? detailsOf(stored?.details)
      : checkClientDetails(input.details),
  };
}

/** **The details as stored, each absent key its empty value** — a proposal made before P19.14 has none. */
export function detailsOf(details: Partial<ProposalClientDetails> | null | undefined): ProposalClientDetails {
  return { ...EMPTY_CLIENT_DETAILS, ...(details ?? {}), needs: [...(details?.needs ?? [])] };
}

/**
 * **A client as a later proposal starts from it** (P19.14-T1 AC-5; ADR-0254 §4): the age moved up by the whole years
 * since `ageSetOn`, on the KPM's calendar — *"the age moves up 1 if a birthday year has passed"* — and the rest as it
 * was. The name is the lead's, read by the caller.
 */
export function clientPrefillOf(
  client: Pick<ProposalClient, 'age' | 'ageSetOn' | 'gender' | 'details'>, today: string,
): { age: number | null; gender: LeadGender | null; details: ProposalClientDetails } {
  const moved = ageToday(client.age, client.ageSetOn, today);
  return {
    age: moved === null ? null : Math.min(moved, LEAD_AGE.MAX),
    gender: client.gender ?? null,
    details: detailsOf(client.details),
  };
}
