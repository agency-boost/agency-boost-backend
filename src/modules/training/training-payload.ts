import {
  SEED_TRAINING_CATEGORIES, SEED_TRAINING_MODULES, SEED_TRAINING_SKILLS,
  type TrainingPublishState,
} from '@/domain/constants';
import {
  checkTrainingCategoryCreate, checkTrainingModuleCreate, checkTrainingSkillCreate,
} from './training-input';

/** A `training_taxonomy` payload: the three levels, without ids, versions or status. */
export interface TrainingTaxonomyPayload {
  categories: { code: string; label: string; description?: string | null }[];
  skills: { code: string; categoryCode: string; label: string }[];
  modules: {
    code: string;
    skillCode: string;
    title: string;
    publishState?: TrainingPublishState;
    /**
     * The company's material for this module (P5-T2, ADR-0032).
     *
     * Its files are **company-owned assets** — `companyId`, no `kpmId` — and provisioning copies
     * this document by **reference**: a new office points at the same objects and stores no bytes
     * of its own. A published company asset never changes, so new material is a new template
     * version, which reaches offices created afterwards and never reaches back (ADR-0018).
     */
    content?: TrainingContentPayload;
  }[];
}

/** A module's content in a template. The same three sections a module holds. */
export interface TrainingContentPayload {
  files?: { id: string; label: string; storageKey: string; mimeType: string; bytes: number }[];
  videos?: { id: string; label: string; storageKey: string; mimeType: string; bytes: number }[];
  links?: { id: string; label: string; url: string }[];
}

/** A template's content as a module stores it, with the three sections always present. */
export const contentFromPayload = (raw: TrainingContentPayload | undefined) => ({
  files: (raw?.files ?? []).map((f) => ({ ...f })),
  videos: (raw?.videos ?? []).map((f) => ({ ...f })),
  links: (raw?.links ?? []).map((l) => ({ ...l })),
});

/** The domain defaults as a payload: a template's starting point, and a company's seed until it publishes one. */
export function defaultTrainingTaxonomy(): TrainingTaxonomyPayload {
  return {
    categories: SEED_TRAINING_CATEGORIES.map(({ code, label, description }) => ({ code, label, description })),
    skills: SEED_TRAINING_SKILLS.map(({ code, categoryCode, label }) => ({ code, categoryCode, label })),
    modules: SEED_TRAINING_MODULES.map(({ code, skillCode, title, publishState }) => ({
      code, skillCode, title, publishState,
    })),
  };
}

/**
 * What would make a `training_taxonomy` payload produce a broken office — one sentence each,
 * empty when there is nothing.
 *
 * **Each row meets the checker an office's own write meets** (ADR-0030), so a template cannot
 * publish a module an office could not have created. Then what only a whole payload can get
 * wrong: a code twice in one level, a skill naming a category the payload does not define, a
 * module naming a skill it does not define. **An empty level is fine** — a company may publish
 * categories with nothing in them yet, which is what the prototype draws for five of six.
 */
export function trainingTaxonomyProblems(payload: unknown): string[] {
  const problems: string[] = [];
  const source = (payload ?? {}) as Record<string, unknown>;
  const rows = (key: 'categories' | 'skills' | 'modules'): Record<string, unknown>[] => {
    if (Array.isArray(source[key])) return source[key] as Record<string, unknown>[];
    problems.push(`${key} must be a list.`);
    return [];
  };

  const levels = [
    ['category', rows('categories'), (r: Record<string, unknown>) =>
      checkTrainingCategoryCreate({ code: r.code, label: r.label, description: r.description })],
    ['skill', rows('skills'), (r: Record<string, unknown>) =>
      checkTrainingSkillCreate({ code: r.code, categoryCode: r.categoryCode, label: r.label })],
    ['module', rows('modules'), (r: Record<string, unknown>) =>
      checkTrainingModuleCreate({
        code: r.code, skillCode: r.skillCode, title: r.title, publishState: r.publishState,
      })],
  ] as const;

  const codes: Record<string, Set<string>> = { category: new Set(), skill: new Set(), module: new Set() };
  const checked: Record<string, Record<string, string>[]> = { category: [], skill: [], module: [] };

  for (const [level, list, check] of levels) {
    list.forEach((row, index) => {
      try {
        const input = check(row) as unknown as Record<string, string>;
        if (codes[level].has(input.code)) {
          problems.push(`The ${level} code ${input.code} is used twice.`);
        }
        codes[level].add(input.code);
        checked[level].push(input);
      } catch (err) {
        problems.push(`${level[0].toUpperCase()}${level.slice(1)} ${index + 1}: ${(err as Error).message}`);
      }
    });
  }

  for (const skill of checked.skill) {
    if (!codes.category.has(skill.categoryCode)) {
      problems.push(`The skill ${skill.code} names ${skill.categoryCode}, which no category in this taxonomy is.`);
    }
  }
  for (const module of checked.module) {
    if (!codes.skill.has(module.skillCode)) {
      problems.push(`The module ${module.code} names ${module.skillCode}, which no skill in this taxonomy is.`);
    }
  }
  return problems;
}

/**
 * The rows an office's copy starts as, from a payload `trainingTaxonomyProblems` passed.
 *
 * **Order is the payload's**, counted within each parent, so a skill is numbered inside its
 * category and a module inside its skill. Codes are normalised here as well as by the schema,
 * because a migration inserts these without Mongoose in between.
 */
export function trainingSeedDocuments(kpmId: string, payload: TrainingTaxonomyPayload) {
  const base = {
    kpmId, version: 1, status: 'active' as const, archivedAt: null, deletedAt: null,
    createdBy: null, updatedBy: null,
  };
  const code = (value: string) => value.trim().toUpperCase();
  const counters = new Map<string, number>();
  const nextIn = (parent: string) => {
    const next = (counters.get(parent) ?? 0) + 1;
    counters.set(parent, next);
    return next;
  };

  return {
    categories: payload.categories.map((c, index) => ({
      ...base, code: code(c.code), label: c.label.trim(), description: c.description?.trim() || null,
      displayOrder: index + 1,
    })),
    skills: payload.skills.map((s) => ({
      ...base, code: code(s.code), categoryCode: code(s.categoryCode), label: s.label.trim(),
      displayOrder: nextIn(`category:${code(s.categoryCode)}`),
    })),
    modules: payload.modules.map((m) => ({
      ...base, code: code(m.code), skillCode: code(m.skillCode), title: m.title.trim(),
      publishState: m.publishState ?? 'draft',
      displayOrder: nextIn(`skill:${code(m.skillCode)}`),
      // **By reference.** The office points at the company's objects and stores no bytes of its
      // own, which is what makes a new office cost nothing in storage (ADR-0032).
      companyContent: contentFromPayload(m.content),
      // No replacement until the office makes one; `null` is what the fallback rule reads.
      officeContent: null,
    })),
  };
}
