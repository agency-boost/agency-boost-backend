import { HttpStatus } from '@nestjs/common';
import { DomainException, InvalidRequestException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { rungCodesOf, type TemplateKinds } from './office-template';
import { TEMPLATE_REFUSALS } from './template.messages';

/**
 * **Every rung the kinds name, on the destination's ladder** (ADR-0115 §6): a ratio's or an activity section's
 * `appliesToOrgLevelCodes`, against the destination company's **active** rung codes. One refusal naming every
 * code missing, `409 TEMPLATE_RUNG_UNKNOWN`, before anything is written or copied.
 *
 * The check every copy across companies makes: *Import from another company* and *Save as template* into
 * another company (`TemplateCopyService`), and an office started from the Template library's template
 * (`ProvisioningService.planFor`, ADR-0164 §5). `ladder` is read only when the kinds name a rung.
 */
export async function refuseUnknownRungs(kinds: TemplateKinds, ladder: () => Promise<readonly string[]>): Promise<void> {
  const named = rungCodesOf(kinds);
  if (named.length === 0) return;
  const active = new Set(await ladder());
  const codes = named.filter((code) => !active.has(code));
  if (codes.length === 0) return;
  throw new DomainException(
    ErrorCode.TEMPLATE_RUNG_UNKNOWN,
    TEMPLATE_REFUSALS.TEMPLATE_RUNG_UNKNOWN.notOnTheLadder({ codes }),
    HttpStatus.CONFLICT,
    { codes },
  );
}

/**
 * **A rung map** (ADR-0213 §4, B1-7): each source rung the destination's ladder lacks, by code, to one of the
 * destination's **active** rungs — `{ SBP: 'BP' }` copies Manulife's template into Allianz, whose ladder is *Agent → BP*.
 */
export type RungMap = Readonly<Record<string, string>>;

const normal = (code: unknown) => String(code ?? '').trim().toUpperCase();

/** A list of rung codes with every one mapped, each once, in the order first met. */
function remapped(list: unknown, map: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const raw of (Array.isArray(list) ? list : []) as unknown[]) {
    const code = normal(raw);
    if (!code) continue;
    const to = map.get(code) ?? code;
    if (!out.includes(to)) out.push(to);
  }
  return out;
}

/**
 * **A copy's kinds with the rungs it names mapped onto the destination's ladder** (ADR-0213 §4; P19.4-T5 AC-4).
 *
 * 1. **The map is checked first**: an entry sending a rung to a code the destination has not got live is `400
 *    VALIDATION_FAILED`, naming each such code — before anything else is asked. An entry for a rung the destination has
 *    is ignored, since the codes already match; so is one for a rung the source never names.
 * 2. **Every configuration that names a rung is rewritten to the mapped code** — a ratio's and an activity section's
 *    `appliesToOrgLevelCodes`, every field the rung check reads (`rungCodesOf`) — and where two codes map to one, the
 *    duplicate is merged.
 * 3. **An unmapped rung is still refused** (`refuseUnmapped`, a copy across companies): `409 TEMPLATE_RUNG_UNKNOWN`,
 *    naming each code, as before the map existed. Within a company the ladder is shared, and nothing is refused.
 *
 * Pure but for `ladder`, read once. Answers the kinds as rewritten — the source's are never touched — and the map as it
 * was applied, for the audit row.
 */
export async function mapRungs(
  kinds: TemplateKinds,
  rungMap: RungMap | undefined,
  ladder: () => Promise<readonly string[]>,
  { refuseUnmapped }: { refuseUnmapped: boolean },
): Promise<{ kinds: TemplateKinds; rungMap: Record<string, string> }> {
  const named = rungCodesOf(kinds);
  const entries = Object.entries(rungMap ?? {}).map(([from, to]) => [normal(from), normal(to)] as const);
  if (named.length === 0 && entries.length === 0) return { kinds, rungMap: {} };

  const active = new Set(await ladder());
  const wrong = [...new Set(entries.filter(([from, to]) => !active.has(from) && !active.has(to)).map(([, to]) => to))];
  if (wrong.length) {
    throw new InvalidRequestException(TEMPLATE_REFUSALS.VALIDATION_FAILED.rungMapTarget({ codes: wrong }), {
      field: 'rungMap', codes: wrong,
    });
  }
  const applied = new Map(entries.filter(([from]) => !active.has(from) && named.includes(from)));

  const mapped: TemplateKinds = { ...kinds };
  if (applied.size) {
    if (kinds.ratio_set) {
      mapped.ratio_set = {
        ...kinds.ratio_set,
        ratios: ((kinds.ratio_set.ratios ?? []) as Record<string, unknown>[]).map((r) => ({
          ...r, appliesToOrgLevelCodes: remapped(r.appliesToOrgLevelCodes, applied),
        })),
      };
    }
    if (kinds.activity_taxonomy) {
      mapped.activity_taxonomy = {
        ...kinds.activity_taxonomy,
        categories: ((kinds.activity_taxonomy.categories ?? []) as Record<string, unknown>[]).map((c) => ({
          ...c, appliesToOrgLevelCodes: remapped(c.appliesToOrgLevelCodes, applied),
        })),
      };
    }
  }
  if (refuseUnmapped) await refuseUnknownRungs(mapped, async () => [...active]);
  return { kinds: mapped, rungMap: Object.fromEntries(applied) };
}

/** Whether a request's `rungMap` is `{ CODE: 'CODE', … }`: an object of strings, nothing else. */
export function isRungMap(value: unknown): value is RungMap {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([from, to]) => from.trim() !== '' && typeof to === 'string' && to.trim() !== '');
}
