import { INTAKE, type IntakeItemStatus, type IntakeStatus } from '@/domain/constants';
import { openQuestions } from './intake-understanding';
import type { IntakeQuestion } from './upload-intake.schema';

/**
 * **An upload's state, from its items** (P19.15-T3; ADR-0259 §5). Pure, so the rule is pinned without a database.
 *
 * - `reading` until each file is read; `failed` when every file failed and nothing was found.
 * - then `needs_answers` while any card has an open question, `ready` while any answered card waits for a confirm,
 *   `applied` once every card is decided with at least one applied, `rejected` when every card was rejected — or when
 *   the files held nothing to apply.
 */
export function intakeStatusOf(
  reading: boolean,
  files: readonly { status: 'reading' | 'read' | 'failed' }[],
  items: readonly { status: IntakeItemStatus }[],
): IntakeStatus {
  if (reading) return 'reading';
  if (items.length === 0) return files.length > 0 && files.every((f) => f.status === 'failed') ? 'failed' : 'rejected';
  if (items.some((i) => i.status === 'needs_answers')) return 'needs_answers';
  if (items.some((i) => i.status === 'ready')) return 'ready';
  return items.some((i) => i.status === 'applied') ? 'applied' : 'rejected';
}

/** A card's state from its questions, while it is undecided. */
export function itemStatusOf(questions: readonly IntakeQuestion[], decided: IntakeItemStatus | null): IntakeItemStatus {
  if (decided === 'applied' || decided === 'rejected') return decided;
  return openQuestions(questions).length > 0 ? 'needs_answers' : 'ready';
}

/** **A reading left unfinished** — the process restarted under it — is failed once it is older than the bound. */
export function isStale(startedAt: Date, now: Date): boolean {
  return now.getTime() - startedAt.getTime() > INTAKE.STALE_READING_MINUTES * 60_000;
}
