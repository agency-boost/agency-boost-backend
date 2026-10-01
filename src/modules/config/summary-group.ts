import { HttpStatus } from '@nestjs/common';
import { DomainException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { refuseWith } from '@/common/validation/fields';
import {
  CODE_MESSAGE, CODE_PATTERN, CONFIG_BOUNDS, SUMMARY_GROUP_PAIR_MESSAGE,
} from './config-input';

/**
 * One summary tile, one label (ADR-0064) — the rule across rows, where `config-input.ts` holds
 * the rule within one. And one code: a shared tile's is no section's outside it (P10.1-T6).
 *
 * `summaryGroupLabel` is held on every section in a group rather than on a group record, so that
 * the tile is configuration the office already edits and no new collection exists to drift from
 * it. The price is that two sections can disagree, and this is what stops them: every write that
 * can set the field — a category route, the staged batch, a Company template save or publish,
 * provisioning — runs the same check over the **whole** set it leaves behind.
 *
 * **Archived sections count.** An archived section still renders the days logged against it, and
 * it renders them under its group's tile; a label it disagreed on would come back the day it was
 * restored, with nothing on screen to say which of the two was meant.
 */

/** What the rule needs of a section, however it arrived — a row, a view or a template entry. */
export interface SummaryGrouped {
  /** The section's own code. Absent, the row takes no part in the code rule. */
  code?: string | null;
  summaryGroupCode?: string | null;
  summaryGroupLabel?: string | null;
}

export interface SummaryGroupConflict {
  summaryGroupCode: string;
  /** Every label the group's sections carry, in the order first met — display order, from a caller. */
  labels: string[];
}

/** The first group whose sections disagree on its label, or `null` when every group agrees. */
export function summaryGroupConflict(rows: readonly SummaryGrouped[]): SummaryGroupConflict | null {
  const labels = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.summaryGroupCode) continue;
    const seen = labels.get(row.summaryGroupCode) ?? [];
    const label = row.summaryGroupLabel ?? '';
    if (!seen.includes(label)) seen.push(label);
    labels.set(row.summaryGroupCode, seen);
  }
  for (const [summaryGroupCode, found] of labels) {
    if (found.length > 1) return { summaryGroupCode, labels: found };
  }
  return null;
}

export interface SummaryGroupCodeTaken {
  summaryGroupCode: string;
  /** The shared tile's label, as its first section carries it. */
  label: string;
}

/**
 * The first shared tile whose code is also the code of a section **outside** it, or `null`.
 *
 * A section with a tile of its own is a tile under its own code, so the two would be two tiles with
 * one code (P10.1-T6). A section in another shared tile collides with nothing today, and is refused
 * all the same: the day it leaves that tile, it would, and the refusal would land on an edit that
 * never touched the code. A section whose code is its own tile's code is inside it — no collision.
 */
export function summaryGroupCodeTaken(rows: readonly SummaryGrouped[]): SummaryGroupCodeTaken | null {
  const groups = new Map<string, string>();
  for (const row of rows) {
    const group = row.summaryGroupCode?.trim();
    if (group && !groups.has(group)) groups.set(group, row.summaryGroupLabel?.trim() ?? '');
  }
  for (const row of rows) {
    const code = row.code?.trim();
    if (!code || !groups.has(code) || row.summaryGroupCode?.trim() === code) continue;
    return { summaryGroupCode: code, label: groups.get(code)! };
  }
  return null;
}

/**
 * Refuse a set of sections that cannot stand as tiles — `422`, because every field is well-formed
 * and it is the combination that cannot: a shared tile under two labels, or a shared tile under
 * the code of a section outside it.
 */
export function refuseSummaryGroupConflict(rows: readonly SummaryGrouped[]): void {
  const conflict = summaryGroupConflict(rows);
  if (conflict) {
    throw new DomainException(
      ErrorCode.CONFIG_SUMMARY_GROUP_LABEL_MISMATCH,
      `The sections in the summary tile ${conflict.summaryGroupCode} would be labelled `
        + `${conflict.labels.map((l) => `“${l}”`).join(' and ')}. One tile has one label: give `
        + 'every section in it the same one.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      { summaryGroupCode: conflict.summaryGroupCode, labels: conflict.labels },
    );
  }
  const taken = summaryGroupCodeTaken(rows);
  if (taken) {
    throw new DomainException(
      ErrorCode.CONFIG_SUMMARY_GROUP_CODE_TAKEN,
      `${taken.summaryGroupCode} is the code of the summary tile “${taken.label}”, so a section `
        + 'outside that tile cannot carry it as well. Give the section another code.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      { summaryGroupCode: taken.summaryGroupCode, label: taken.label },
    );
  }
}

/**
 * A Company template's `activity_taxonomy` categories, read the way an office's own write is
 * (ADR-0030): both fields or neither, a code in a code's shape, a label a section could hold.
 *
 * Hands back the categories with the two fields normalised — the code upper-cased, the label
 * trimmed, absent read as `null` — so the office provisioning copies them into receives what its
 * own settings screen would have written. Refuses with `VALIDATION_FAILED` and every violation at
 * once; the one-label and code rules are `refuseSummaryGroupConflict`, run by the caller over the result.
 */
export function checkTemplateSummaryGroups(categories: unknown): Record<string, unknown>[] {
  if (!Array.isArray(categories)) return [];
  const violations: string[] = [];
  const checked = categories.map((entry: unknown, index) => {
    // Not a section this rule can read, and not this rule's to refuse: saved exactly as sent.
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry as Record<string, unknown>;
    const row = entry as Record<string, unknown>;
    const at = `categories[${index}]${typeof row.code === 'string' ? ` (${row.code})` : ''}`;
    const rawCode = row.summaryGroupCode ?? null;
    const rawLabel = row.summaryGroupLabel ?? null;
    if ((rawCode === null) !== (rawLabel === null)) {
      violations.push(`${at}: ${SUMMARY_GROUP_PAIR_MESSAGE}`);
      return row;
    }
    if (rawCode === null) return { ...row, summaryGroupCode: null, summaryGroupLabel: null };

    const code = typeof rawCode === 'string' ? rawCode.trim() : '';
    const label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
    const { min, max } = CONFIG_BOUNDS.summaryGroupLabel;
    if (!CODE_PATTERN.test(code)) {
      violations.push(`${at}: summaryGroupCode: ${CODE_MESSAGE}`);
    }
    if (typeof rawLabel !== 'string' || label.length < min || label.length > max) {
      violations.push(`${at}: summaryGroupLabel must be ${min}–${max} characters.`);
    }
    return { ...row, summaryGroupCode: code.toUpperCase(), summaryGroupLabel: label };
  });
  if (violations.length) refuseWith(violations);
  return checked;
}
