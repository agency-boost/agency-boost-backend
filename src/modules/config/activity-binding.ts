import { BINDING_CODES_MAX, CASCADE_ACTIVITY_CODES } from '@/domain/constants';

/**
 * **The three cascade roles** (ADR-0163 §1), in the prototype's order: *Set appointment*, *Sales meeting*,
 * *Submission polis* — the goal cascade's leads, appointments and closings columns.
 */
export const BINDING_ROLES = ['leads', 'appointments', 'closings'] as const;
export type BindingRole = (typeof BINDING_ROLES)[number];

/** For each role, the activity type codes it counts. A role's count is the sum over its list. */
export interface CascadeBinding {
  leads: string[];
  appointments: string[];
  closings: string[];
}

/** The client's words for each role (ADR-0160), as a refusal names them. */
export const BINDING_ROLE_LABEL: Record<BindingRole, string> = {
  leads: 'Set appointment',
  appointments: 'Sales meeting',
  closings: 'Submission polis',
};

/**
 * **The default binding**: the platform's three codes, one per role (`CASCADE_ACTIVITY_CODES`). What a template
 * without a binding gives its offices, what migration `0034` writes into every office and template, and what an
 * office with no binding row counts — the codes it counted before the binding existed. A fresh copy each call.
 */
export function defaultBinding(): CascadeBinding {
  return {
    leads: [CASCADE_ACTIVITY_CODES.leadsCode],
    appointments: [CASCADE_ACTIVITY_CODES.appointmentsCode],
    closings: [CASCADE_ACTIVITY_CODES.closingsCode],
  };
}

/** Every code the binding names, once each, in role order. */
export function boundCodes(binding: CascadeBinding): string[] {
  return [...new Set(BINDING_ROLES.flatMap((role) => binding[role]))];
}

/** A role's count: the sum of its codes' counts. A code with nothing logged counts 0. */
export function countOf(counts: ReadonlyMap<string, number>, codes: readonly string[]): number {
  return codes.reduce((sum, code) => sum + (counts.get(code) ?? 0), 0);
}

/** The role each bound code is in — one each, by `bindingProblems`; the first wins on a row older than the rule. */
export function roleOfCode(binding: CascadeBinding): Map<string, BindingRole> {
  const out = new Map<string, BindingRole>();
  for (const role of BINDING_ROLES) {
    for (const code of binding[role]) if (!out.has(code)) out.set(code, role);
  }
  return out;
}

/**
 * **What is wrong with a binding, one sentence each** — the one checker the office's write, a template's publish
 * and provisioning share, so the three cannot disagree about what is valid.
 *
 * - each role a list of codes, at least one and at most `BINDING_CODES_MAX`;
 * - a code in one role only — counted twice it would be a lead and a meeting at once;
 * - every code `known`: one of the office's activity types (archived allowed, for its history), or of the
 *   template's taxonomy.
 */
export function bindingProblems(input: unknown, known: ReadonlySet<string>): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return ['The activity binding must name the codes for Set appointment, Sales meeting and Submission polis.'];
  }
  const problems: string[] = [];
  const seen = new Map<string, BindingRole>();
  for (const role of BINDING_ROLES) {
    const codes = (input as Record<string, unknown>)[role];
    const label = BINDING_ROLE_LABEL[role];
    if (!Array.isArray(codes) || codes.some((code) => typeof code !== 'string' || code.trim() === '')) {
      problems.push(`${label} must be a list of activity type codes.`);
      continue;
    }
    if (codes.length === 0) {
      problems.push(`${label} counts no activity type. Bind at least one, or the summary counts nothing for it.`);
      continue;
    }
    if (codes.length > BINDING_CODES_MAX) {
      problems.push(`${label} names ${codes.length} activity types; at most ${BINDING_CODES_MAX}.`);
    }
    for (const code of codes as string[]) {
      const other = seen.get(code);
      if (other) {
        problems.push(other === role
          ? `${label} names ${code} twice.`
          : `${code} is bound to both ${BINDING_ROLE_LABEL[other]} and ${label}. One activity counts in one place.`);
        continue;
      }
      seen.set(code, role);
    }
    const unknown = [...new Set((codes as string[]).filter((code) => !known.has(code)))];
    if (unknown.length) {
      problems.push(`${label} names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not `
        + `${unknown.length === 1 ? 'an activity type' : 'activity types'} here.`);
    }
  }
  return problems;
}

/** The binding a checked input holds, its codes trimmed and upper-cased as every activity code is stored. */
export function normalisedBinding(input: Record<string, unknown>): CascadeBinding {
  const of = (role: BindingRole) => ((input[role] as string[] | undefined) ?? []).map((code) => code.trim().toUpperCase());
  return { leads: of('leads'), appointments: of('appointments'), closings: of('closings') };
}

/**
 * **The binding an `activity_taxonomy` payload carries** (`payload.bindings`), or `null` when it carries none —
 * a template authored before ADR-0163, or *Empty*. Its offices are then given `defaultBinding()`.
 */
export function bindingOfPayload(payload: Record<string, unknown> | null | undefined): CascadeBinding | null {
  const held = payload?.bindings;
  if (!held || typeof held !== 'object' || Array.isArray(held)) return null;
  const roles = held as Record<string, unknown>;
  if (!BINDING_ROLES.every((role) => Array.isArray(roles[role]))) return null;
  return {
    leads: [...(roles.leads as string[])],
    appointments: [...(roles.appointments as string[])],
    closings: [...(roles.closings as string[])],
  };
}
