import type { SurveyState } from '@/domain/constants';
import type { LabelPair } from '@/modules/config/analytics-config';
import type { SurveyAnswer } from './survey-response.schema';
import type { SnapshotQualBlock } from './survey-run.schema';
import { filled } from './survey-office';
import { isIssue } from './survey-rules';

/*
 * **One person's qualitative answers, as a card per block** (P19.5-T4 B2; P19.22-T7 AC-3; ADR-0216 §7, ADR-0276 §5):
 * what the coaching *Survei* tab and *Analisa kualitatif › Per orang* both draw, built once here so the two never read
 * the same form two ways. Pure: the names of Q11's downline leaders are read by the caller (`downlineIdsOf`) and handed
 * in.
 */

/** One section card, as the mockups draw it. */
export type PersonSection =
  | { kode: string; kind: 'scale'; title: LabelPair; questionKodes: string[]; items: { kode: string; label: LabelPair; rating: number | null }[] }
  | { kode: string; kind: 'state'; title: LabelPair; questionKodes: string[]; items: { kode: string; label: LabelPair; state: SurveyState | null }[] }
  | {
    kode: string; kind: 'unit'; title: LabelPair; questionKodes: string[];
    items: { kode: string; label: LabelPair; state: SurveyState | null; rating: number | null }[];
  }
  | {
    kode: string; kind: 'downline'; title: LabelPair; questionKodes: string[]; stillCoaching: boolean | null;
    leaders: { membershipId: string | null; name: string; areas: { kode: string; label: LabelPair }[] }[];
  };

/** A sent form as read here: its answers alone. */
export interface PersonForm {
  answers: readonly SurveyAnswer[];
}

type Office = { company: string; kpm: string };

const answerOf = (form: PersonForm, kode: string) =>
  form.answers.find((a) => a.questionKode === kode)?.value as Record<string, unknown> | undefined;

/** Q11's downline leaders named on the form: the ids whose names the caller reads before `personSections`. */
export function downlineIdsOf(blocks: readonly SnapshotQualBlock[], form: PersonForm): string[] {
  const areasQ = blocks.flatMap((b) => b.questions).find((q) => q.type === 'downline_coaching' && q.items.length > 0);
  if (!areasQ) return [];
  const rows = (answerOf(form, areasQ.kode)?.leaders as { membershipId?: string }[] | undefined) ?? [];
  return rows.map((l) => l.membershipId).filter((id): id is string => typeof id === 'string');
}

/** Q4: the options, the chosen ones ticked, and the note. */
export function personAspiration(blocks: readonly SnapshotQualBlock[], form: PersonForm, office: Office) {
  const q = blocks.flatMap((b) => b.questions).find((x) => x.type === 'aspiration');
  if (!q) return null;
  const value = answerOf(form, q.kode);
  const chosen = Array.isArray(value?.chosen) ? (value!.chosen as string[]) : [];
  return {
    kode: q.kode,
    options: q.items.map((it) => ({ kode: it.kode, label: filled(it.label, office), chosen: chosen.includes(it.kode) })),
    note: typeof value?.note === 'string' ? value.note : null,
  };
}

/** Q12's score, 0 to 10, or `null`; never its reason. */
export function personSupport(blocks: readonly SnapshotQualBlock[], form: PersonForm): { kode: string; score: number | null } | null {
  const q = blocks.flatMap((b) => b.questions).find((x) => x.type === 'support');
  if (!q) return null;
  const score = answerOf(form, q.kode)?.score;
  return { kode: q.kode, score: typeof score === 'number' ? score : null };
}

/** The cards, one per block, by what its questions ask — never `support` (Q12) and never a `choice`. */
export function personSections(
  blocks: readonly SnapshotQualBlock[], form: PersonForm, office: Office, names: ReadonlyMap<string, string>,
): PersonSection[] {
  const out: PersonSection[] = [];
  for (const b of blocks) {
    const qs = b.questions;
    const title = filled(b.title, office);
    const questionKodes = qs.map((q) => q.kode);
    const unit = qs.find((q) => q.type === 'unit_items');
    const scale = qs.find((q) => q.type === 'scale_items');
    const state = qs.find((q) => q.type === 'state_items');
    const downline = qs.filter((q) => q.type === 'downline_coaching');
    const rating = (v: Record<string, unknown>, k: string) => (typeof v[k] === 'number' ? (v[k] as number) : null);
    if (unit) {
      const comfort = answerOf(form, unit.kode) ?? {};
      const states = state ? answerOf(form, state.kode) ?? {} : {};
      out.push({
        kode: b.kode, kind: 'unit', title, questionKodes,
        items: unit.items.map((it) => ({
          kode: it.kode, label: it.label, state: (states[it.kode] as SurveyState | undefined) ?? null, rating: rating(comfort, it.kode),
        })),
      });
    } else if (scale) {
      const v = answerOf(form, scale.kode) ?? {};
      out.push({
        kode: b.kode, kind: 'scale', title, questionKodes,
        items: scale.items.map((it) => ({ kode: it.kode, label: it.label, rating: rating(v, it.kode) })),
      });
    } else if (state) {
      const v = answerOf(form, state.kode) ?? {};
      out.push({
        kode: b.kode, kind: 'state', title, questionKodes,
        items: state.items.map((it) => ({ kode: it.kode, label: it.label, state: (v[it.kode] as SurveyState | undefined) ?? null })),
      });
    } else if (downline.length > 0) {
      const yesNo = downline.find((q) => q.items.length === 0);
      const areasQ = downline.find((q) => q.items.length > 0);
      const answer = yesNo ? answerOf(form, yesNo.kode)?.answer : undefined;
      const rows = areasQ ? ((answerOf(form, areasQ.kode)?.leaders as { membershipId?: string; areas: string[] }[] | undefined) ?? []) : [];
      // Not asked — a leader with no leader below them — so no card.
      if (answer === undefined && rows.length === 0) continue;
      out.push({
        kode: b.kode, kind: 'downline', title, questionKodes,
        stillCoaching: answer === 'yes' ? true : answer === 'no' ? false : null,
        leaders: rows.map((l) => ({
          membershipId: l.membershipId ?? null,
          name: (l.membershipId && names.get(l.membershipId)) || '',
          areas: l.areas.map((kode) => ({ kode, label: areasQ!.items.find((i) => i.kode === kode)?.label ?? { id: kode, en: kode } })),
        })),
      });
    }
  }
  return out;
}

/** `QUAL_PERSON_ISSUE_COUNT`: the section's answers with an issue; a unit item's consistency and comfort each count. */
export function issuesIn(section: PersonSection, max: number): number {
  switch (section.kind) {
    case 'scale':
      return section.items.filter((i) => i.rating !== null && isIssue('rating', i.rating, max)).length;
    case 'state':
      return section.items.filter((i) => i.state !== null && isIssue('state', i.state, max)).length;
    case 'unit':
      return section.items.filter((i) => i.state !== null && isIssue('state', i.state, max)).length
        + section.items.filter((i) => i.rating !== null && isIssue('rating', i.rating, max)).length;
    default:
      return 0;
  }
}

/**
 * *Item bermasalah* per card, with how many it asked: *6/8 Rekrutmen* (P19.22-T7 AC-3). A unit card counts its items
 * once — an item is a problem when its consistency or its comfort is — so its tile reads *x/8*, never *x/16*.
 */
export function issueTilesOf(sections: readonly PersonSection[], max: number): { kode: string; title: LabelPair; count: number; of: number }[] {
  return sections.filter((s) => s.kind !== 'downline').map((s) => {
    if (s.kind === 'unit') {
      const count = s.items.filter((i) => (i.state !== null && isIssue('state', i.state, max)) || (i.rating !== null && isIssue('rating', i.rating, max))).length;
      return { kode: s.kode, title: s.title, count, of: s.items.length };
    }
    return { kode: s.kode, title: s.title, count: issuesIn(s, max), of: s.items.length };
  });
}
