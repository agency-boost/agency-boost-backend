import type { TrainingStatus } from '@/domain/constants';
import type { TrainingCompletion } from '@/domain/metrics/training-completion';

/** The kinds a module's content holds, in the order its items and its *Format* chips come in. */
export const TRAINING_ITEM_KINDS = ['file', 'video', 'link'] as const;
export type TrainingItemKind = (typeof TRAINING_ITEM_KINDS)[number];

/** `TRAINING_COMPLETION_PCT` over one scope, as served: offered modules only, `pct` null when none. */
export type TrainingCountsView = TrainingCompletion;

/** One offered module on a list row (`/training/[categoryCode]`, the person tab). */
export interface TrainingModuleRowView {
  code: string;
  title: string;
  /** The kinds its live content holds, File · Video · Link order; empty when it holds nothing. */
  formats: TrainingItemKind[];
  status: TrainingStatus;
  /** The last move to `done`, while it is done. */
  completedAt: string | null;
}

/** D-history: a module the member marked done that is no longer offered. Outside every count. */
export interface TrainingArchivedModuleView {
  code: string;
  title: string;
  /** The kinds its content holds, as an offered row's `formats`. */
  formats: TrainingItemKind[];
  status: 'done';
  completedAt: string | null;
}

export interface TrainingSkillProgressView extends TrainingCountsView {
  code: string;
  label: string;
  /** `false` only for a skill no longer offered that still holds the member's history. */
  offered: boolean;
  modules: TrainingModuleRowView[];
  archived: TrainingArchivedModuleView[];
}

export interface TrainingCategoryProgressView extends TrainingCountsView {
  code: string;
  label: string;
  description: string | null;
  /** `false` only for a category no longer offered that still holds the member's history. */
  offered: boolean;
  skills: TrainingSkillProgressView[];
}

/** **One member's training**: the offered catalog with their statuses, its counts at every scope, and their history. */
export interface TrainingProgressView extends TrainingCountsView {
  membershipId: string;
  categories: TrainingCategoryProgressView[];
  /** Every offered module done; `false` when nothing is offered. */
  allOfferedDone: boolean;
}

/** One item of a module's content, as the learner's page lists it. */
export interface TrainingItemView {
  id: string;
  kind: TrainingItemKind;
  label: string;
  mimeType: string | null;
  bytes: number | null;
  /** A link's own `https` address; `null` for a file or a video, whose address is signed on open. */
  url: string | null;
}

/** **A module as offered**, with the reader's status and the items they have opened (`/training/[c]/[m]`). */
export interface TrainingModulePageView {
  code: string;
  title: string;
  category: { code: string; label: string };
  skill: { code: string; label: string };
  items: TrainingItemView[];
  status: TrainingStatus;
  startedAt: string | null;
  completedAt: string | null;
  openedItemIds: string[];
  /** Whether the reader may set the status — never in a support session, never without a rung. */
  can: { update: boolean };
}

/** What opening one item answers. */
export interface TrainingOpenView {
  /** Signed for 300 seconds for a file or a video; a link's own address for a link. */
  url: string;
  openedItemIds: string[];
  /** This call wrote the item's first open. */
  recorded: boolean;
}
