import { Fields } from '@/common/validation/fields';
import { plainText } from '@/common/validation/plain-text';
import { TRAINING_PUBLISH_STATES, TRAINING_TEXT, type TrainingPublishState } from '@/domain/constants';

/**
 * What a write to an office's training taxonomy may contain (P5-T1, ADR-0030).
 *
 * One checker per write. `TrainingService` runs it before it writes, the staged batch's
 * validate pass runs the same one before it writes anything, and the Company template's
 * publish check runs it over every row of a `training_taxonomy` payload — so a template cannot
 * publish a module an office could not have created.
 */
export const TRAINING_BOUNDS = {
  categoryLabel: { min: 1, max: 80 },
  description: { max: 200 },
  skillLabel: { min: 1, max: 80 },
  moduleTitle: { min: 1, max: 200 },
  /** A skill's and a module's *Deskripsi singkat* (P19.6-T4, ADR-0220 §1). A category's is `description`, above. */
  shortDescription: { max: TRAINING_TEXT.DESCRIPTION_MAX },
} as const;

/**
 * ***Deskripsi singkat***, as a skill and a module take it (P19.6-T4, ADR-0220 §1): absent leaves it alone, `null` or
 * blank clears it, and what is kept is plain text — markup taken out, one line (P19-T6's rule) — of at most 160
 * characters, counted before the markup goes, so a refusal names what was typed.
 */
function shortDescription(f: Fields): string | null | undefined {
  const value = f.note('description', TRAINING_BOUNDS.shortDescription);
  if (value === undefined || value === null) return value;
  return plainText(value) || null;
}

// ------------------------------------------------------------------- categories

export interface TrainingCategoryCreateInput {
  code: string;
  label: string;
  description: string | null;
}

export function checkTrainingCategoryCreate(body: unknown): TrainingCategoryCreateInput {
  const f = new Fields(body, ['code', 'label', 'description']);
  return f.done({
    code: f.code('code', true),
    label: f.text('label', TRAINING_BOUNDS.categoryLabel, true),
    description: f.note('description', TRAINING_BOUNDS.description) ?? null,
  }) as TrainingCategoryCreateInput;
}

/** No `code`: it is the identity. */
export interface TrainingCategoryUpdateInput {
  label?: string;
  description?: string | null;
}

export function checkTrainingCategoryUpdate(body: unknown): TrainingCategoryUpdateInput {
  const f = new Fields(body, ['label', 'description']);
  return f.done({
    label: f.text('label', TRAINING_BOUNDS.categoryLabel, false),
    description: f.note('description', TRAINING_BOUNDS.description),
  });
}

// ----------------------------------------------------------------------- skills

export interface TrainingSkillCreateInput {
  code: string;
  categoryCode: string;
  label: string;
  /** *Deskripsi singkat* (P19.6-T4). */
  description: string | null;
}

export function checkTrainingSkillCreate(body: unknown): TrainingSkillCreateInput {
  const f = new Fields(body, ['code', 'categoryCode', 'label', 'description']);
  return f.done({
    code: f.code('code', true),
    categoryCode: f.code('categoryCode', true),
    label: f.text('label', TRAINING_BOUNDS.skillLabel, true),
    description: shortDescription(f) ?? null,
  }) as TrainingSkillCreateInput;
}

export interface TrainingSkillUpdateInput {
  label?: string;
  description?: string | null;
  categoryCode?: string;
}

export function checkTrainingSkillUpdate(body: unknown): TrainingSkillUpdateInput {
  const f = new Fields(body, ['label', 'description', 'categoryCode']);
  return f.done({
    label: f.text('label', TRAINING_BOUNDS.skillLabel, false),
    description: shortDescription(f),
    categoryCode: f.code('categoryCode', false),
  });
}

// ---------------------------------------------------------------------- modules

export interface TrainingModuleCreateInput {
  code: string;
  skillCode: string;
  title: string;
  /** *Deskripsi singkat* (P19.6-T4). */
  description: string | null;
  publishState: TrainingPublishState;
}

export function checkTrainingModuleCreate(body: unknown): TrainingModuleCreateInput {
  const f = new Fields(body, ['code', 'skillCode', 'title', 'description', 'publishState']);
  return f.done({
    code: f.code('code', true),
    skillCode: f.code('skillCode', true),
    title: f.text('title', TRAINING_BOUNDS.moduleTitle, true),
    description: shortDescription(f) ?? null,
    // A draft until somebody says otherwise: nothing in P5-T1 gives a module content, and a
    // module offered on creation would be an empty page on an agent's screen.
    publishState: f.oneOf('publishState', TRAINING_PUBLISH_STATES, false) ?? 'draft',
  }) as TrainingModuleCreateInput;
}

export interface TrainingModuleUpdateInput {
  title?: string;
  description?: string | null;
  skillCode?: string;
  publishState?: TrainingPublishState;
}

export function checkTrainingModuleUpdate(body: unknown): TrainingModuleUpdateInput {
  const f = new Fields(body, ['title', 'description', 'skillCode', 'publishState']);
  return f.done({
    title: f.text('title', TRAINING_BOUNDS.moduleTitle, false),
    description: shortDescription(f),
    skillCode: f.code('skillCode', false),
    publishState: f.oneOf('publishState', TRAINING_PUBLISH_STATES, false),
  });
}
