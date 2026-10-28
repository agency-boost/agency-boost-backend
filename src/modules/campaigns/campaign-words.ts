import { formatNumber, formatPercent, formatRupiahCompact } from '@/common/format/format';
import { MDRT_TOOLTIP, metricByKey } from '@/domain/constants';

/**
 * What the campaigns screens print that the server composes — pure, so each rule is a unit test
 * (P18.5-T7; D-lists, OD-152).
 */

/** The fields the order reads. */
export interface Orderable {
  code: string;
  title: string;
  kind: 'seasonal' | 'structural';
  phase: 'upcoming' | 'running' | 'ended';
  startsAt: Date;
  endsAt: Date | null;
}

const PHASE_RANK = { running: 0, upcoming: 1, ended: 2 } as const;

/**
 * **D-lists' order**: seasonal campaigns running then upcoming, soonest first — the one ending first, the one
 * starting first — then ended, the latest first; structural ones by title, A to Z. The screen groups by section and
 * keeps this order within each.
 */
export function campaignOrder(a: Orderable, b: Orderable): number {
  if (a.kind !== b.kind) return a.kind === 'seasonal' ? -1 : 1;
  if (a.kind === 'structural') return a.title.localeCompare(b.title) || a.code.localeCompare(b.code);
  if (a.phase !== b.phase) return PHASE_RANK[a.phase] - PHASE_RANK[b.phase];
  const time = (d: Date | null) => (d === null ? Number.MAX_SAFE_INTEGER : d.getTime());
  const by = a.phase === 'running' ? time(a.endsAt) - time(b.endsAt)
    : a.phase === 'upcoming' ? a.startsAt.getTime() - b.startsAt.getTime()
      : time(b.endsAt) - time(a.endsAt);
  return by || a.title.localeCompare(b.title) || a.code.localeCompare(b.code);
}

/**
 * A requirement's target as words, through the shared formatters (ADR-0167 §1, ADR-0174): *Rp 2,4 M* from sen, *90%*,
 * *3*. **Lossless**: a target is a rule, so one the compact form would round — *Rp 1.250.000.000* — is written in full,
 * and a percentage keeps every decimal it was set with and no *,0* (ADR-0174 §3).
 */
export function targetWords(metricKey: string, value: number): string {
  switch (metricByKey(metricKey)?.unit) {
    case 'idr_minor': return formatRupiahCompact(value, { lossless: true });
    case 'percentage': return formatPercent(value, { lossless: true });
    default: return formatNumber(value);
  }
}

/** What a requirement is of, in the tooltip's words: *APE* for the file's APE (ADR-0142 §3), else the registry's name. */
const NOUN: Readonly<Record<string, string>> = { APE_ACHIEVED: 'APE' };

/**
 * A requirement in words, as ADR-0142 §3 writes one: *"APE of Rp 1,2 M or more"* — the target in rupiah from sen,
 * written as ADR-0167 §1 writes a sum, the comparator in words.
 */
export function requirementWords(r: { metricKey: string; comparator: string; value: number }): string {
  const noun = NOUN[r.metricKey] ?? metricByKey(r.metricKey)?.name ?? r.metricKey;
  const target = targetWords(r.metricKey, r.value);
  switch (r.comparator) {
    case 'gte': return `${noun} of ${target} or more`;
    case 'gt': return `${noun} above ${target}`;
    case 'lte': return `${noun} of ${target} or less`;
    case 'lt': return `${noun} below ${target}`;
    default: return `${noun} of exactly ${target}`;
  }
}

/**
 * ***Chasing MDRT*'s header tooltip** (OD-152 → option 3, D-18): the prototype's opening, then the office's MDRT
 * campaign's requirements in words; or, with none running, saying so. Never *"…based on annual FYC pace"*: the ✓ is
 * a chase, and FYC is not in the file.
 */
export function mdrtTooltip(mdrt: { requirements: readonly { metricKey: string; comparator: string; value: number }[] } | null): string {
  if (mdrt === null) return `${MDRT_TOOLTIP.OPENING}. ${MDRT_TOOLTIP.NONE}`;
  if (mdrt.requirements.length === 0) return `${MDRT_TOOLTIP.OPENING}.`;
  return `${MDRT_TOOLTIP.OPENING} — ${mdrt.requirements.map(requirementWords).join(' and ')}.`;
}
