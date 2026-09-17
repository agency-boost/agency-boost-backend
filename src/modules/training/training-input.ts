import { Fields } from '@/common/validation/fields';
import { TRAINING_PUBLISH_STATES, type TrainingPublishState } from '@/domain/constants';

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
} as const;

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
}

export function checkTrainingSkillCreate(body: unknown): TrainingSkillCreateInput {
  const f = new Fields(body, ['code', 'categoryCode', 'label']);
  return f.done({
    code: f.code('code', true),
    categoryCode: f.code('categoryCode', true),
    label: f.text('label', TRAINING_BOUNDS.skillLabel, true),
  }) as TrainingSkillCreateInput;
}

export interface TrainingSkillUpdateInput {
  label?: string;
  categoryCode?: string;
}

export function checkTrainingSkillUpdate(body: unknown): TrainingSkillUpdateInput {
  const f = new Fields(body, ['label', 'categoryCode']);
  return f.done({
    label: f.text('label', TRAINING_BOUNDS.skillLabel, false),
    categoryCode: f.code('categoryCode', false),
  });
}

// ---------------------------------------------------------------------- modules

export interface TrainingModuleCreateInput {
  code: string;
  skillCode: string;
  title: string;
  publishState: TrainingPublishState;
}

export function checkTrainingModuleCreate(body: unknown): TrainingModuleCreateInput {
  const f = new Fields(body, ['code', 'skillCode', 'title', 'publishState']);
  return f.done({
    code: f.code('code', true),
    skillCode: f.code('skillCode', true),
    title: f.text('title', TRAINING_BOUNDS.moduleTitle, true),
    // A draft until somebody says otherwise: nothing in P5-T1 gives a module content, and a
    // module offered on creation would be an empty page on an agent's screen.
    publishState: f.oneOf('publishState', TRAINING_PUBLISH_STATES, false) ?? 'draft',
  }) as TrainingModuleCreateInput;
}

export interface TrainingModuleUpdateInput {
  title?: string;
  skillCode?: string;
  publishState?: TrainingPublishState;
}

export function checkTrainingModuleUpdate(body: unknown): TrainingModuleUpdateInput {
  const f = new Fields(body, ['title', 'skillCode', 'publishState']);
  return f.done({
    title: f.text('title', TRAINING_BOUNDS.moduleTitle, false),
    skillCode: f.code('skillCode', false),
    publishState: f.oneOf('publishState', TRAINING_PUBLISH_STATES, false),
  });
}
