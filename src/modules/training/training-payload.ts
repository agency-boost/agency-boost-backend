import type { DomainException } from '@/common/errors/domain.exception';
import type { FieldSentence } from '@/common/validation/fields';
import { plainText } from '@/common/validation/plain-text';
import {
  SEED_TRAINING_CATEGORIES, SEED_TRAINING_MODULES, SEED_TRAINING_SKILLS, splitTrainingTitle,
  type TrainingPublishState,
} from '@/domain/constants';
import {
  checkTrainingCategoryCreate, checkTrainingModuleCreate, checkTrainingSkillCreate,
} from './training-input';
import { TRAINING_REFUSALS } from './training.messages';

const SAY = TRAINING_REFUSALS.VALIDATION_FAILED;

/** A `training_taxonomy` payload: the three levels, without ids, versions or status. */
export interface TrainingTaxonomyPayload {
  categories: { code: string; label: string; description?: string | null }[];
  /** `description`: the skill's *Deskripsi singkat* (P19.6-T4, ADR-0220 §1); absent reads as `null`. */
  skills: { code: string; categoryCode: string; label: string; description?: string | null }[];
  modules: {
    code: string;
    skillCode: string;
    title: string;
    /** The module's *Deskripsi singkat* (P19.6-T4, ADR-0220 §1); absent reads as `null`. */
    description?: string | null;
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

/**
 * A skill's or a module's *Deskripsi singkat* as an office row stores it (P19.6-T4, ADR-0220 §1): plain text, trimmed,
 * `null` for none — absent, blank or not text alike. The payload's checker has refused anything longer before here.
 */
export const shortText = (value: unknown): string | null =>
  (typeof value === 'string' ? plainText(value) : '') || null;

/**
 * **A skill's or a module's name and description, as read** (P19.6-T4, ADR-0220 §3). A row that carries a `description`
 * — `null` included — is read as it stands. **One with no `description` at all was written before the field existed**,
 * and is read as the split migration reads it: *"Name: description"* split at the first colon followed by a space
 * (`splitTrainingTitle`), or whole. So a template version published before the split, an office row the migration has not
 * reached, and the same words split, all read alike — and *changed by the KPM* (ADR-0208 §4) stays true across the split.
 */
export function namedAs(name: unknown, description: unknown): { name: string; description: string | null } {
  const whole = typeof name === 'string' ? name.trim() : '';
  if (description !== undefined) return { name: whole, description: shortText(description) };
  const split = splitTrainingTitle(whole);
  return split.split ? { name: split.name, description: split.description } : { name: whole, description: null };
}

/** The domain defaults as a payload: a template's starting point, and a company's seed until it publishes one. */
export function defaultTrainingTaxonomy(): TrainingTaxonomyPayload {
  return {
    categories: SEED_TRAINING_CATEGORIES.map(({ code, label, description }) => ({ code, label, description })),
    skills: SEED_TRAINING_SKILLS.map(({ code, categoryCode, label }) => ({ code, categoryCode, label, description: null })),
    modules: SEED_TRAINING_MODULES.map(({ code, skillCode, title, publishState }) => ({
      code, skillCode, title, description: null, publishState,
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
 *
 * **Each problem in both languages** (P18.10-T5 AC-3): a row the office's checker refused keeps that checker's own
 * sentence, after the row's place in its level.
 */
export function trainingTaxonomyProblems(payload: unknown): FieldSentence[] {
  const problems: FieldSentence[] = [];
  const source = (payload ?? {}) as Record<string, unknown>;
  const rows = (key: 'categories' | 'skills' | 'modules'): Record<string, unknown>[] => {
    if (Array.isArray(source[key])) return source[key] as Record<string, unknown>[];
    problems.push(SAY.notAList({ key }));
    return [];
  };

  const levels = [
    ['category', rows('categories'), (r: Record<string, unknown>) =>
      checkTrainingCategoryCreate({ code: r.code, label: r.label, description: r.description })],
    ['skill', rows('skills'), (r: Record<string, unknown>) =>
      checkTrainingSkillCreate({
        code: r.code, categoryCode: r.categoryCode, label: r.label, description: r.description,
      })],
    ['module', rows('modules'), (r: Record<string, unknown>) =>
      checkTrainingModuleCreate({
        code: r.code, skillCode: r.skillCode, title: r.title, description: r.description, publishState: r.publishState,
      })],
  ] as const;

  const codes: Record<string, Set<string>> = { category: new Set(), skill: new Set(), module: new Set() };
  const checked: Record<string, Record<string, string>[]> = { category: [], skill: [], module: [] };

  for (const [level, list, check] of levels) {
    list.forEach((row, index) => {
      try {
        const input = check(row) as unknown as Record<string, string>;
        if (codes[level].has(input.code)) problems.push(SAY.levelCodeTwice({ level, code: input.code }));
        codes[level].add(input.code);
        checked[level].push(input);
      } catch (err) {
        // The checkers refuse through `Fields`, so this is the row's own refusal, in both languages.
        problems.push(SAY.atLevel({ level, n: index + 1, inner: (err as DomainException<'VALIDATION_FAILED'>).sentence }));
      }
    });
  }

  for (const skill of checked.skill) {
    if (!codes.category.has(skill.categoryCode)) {
      problems.push(SAY.skillUnknownCategory({ code: skill.code, categoryCode: skill.categoryCode }));
    }
  }
  for (const module of checked.module) {
    if (!codes.skill.has(module.skillCode)) {
      problems.push(SAY.moduleUnknownSkill({ code: module.code, skillCode: module.skillCode }));
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

  // A row from before P19.6-T4 (no `description`) is read split, as the migration splits it (`namedAs`).
  const skillNames = (s: TrainingTaxonomyPayload['skills'][number]) => namedAs(s.label, s.description);
  const moduleNames = (m: TrainingTaxonomyPayload['modules'][number]) => namedAs(m.title, m.description);

  return {
    categories: payload.categories.map((c, index) => ({
      ...base, code: code(c.code), label: c.label.trim(), description: c.description?.trim() || null,
      displayOrder: index + 1,
    })),
    skills: payload.skills.map((s) => ({
      ...base, code: code(s.code), categoryCode: code(s.categoryCode), label: skillNames(s).name,
      description: skillNames(s).description,
      displayOrder: nextIn(`category:${code(s.categoryCode)}`),
    })),
    modules: payload.modules.map((m) => ({
      ...base, code: code(m.code), skillCode: code(m.skillCode), title: moduleNames(m).name,
      description: moduleNames(m).description,
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
