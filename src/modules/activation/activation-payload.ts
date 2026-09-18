import { SEED_ACTIVATION_ASPECTS, SEED_ACTIVATION_ITEMS } from '@/domain/constants';
import {
  checkActivationChecklist, trainingLinkModuleCode,
  type CheckedActivationAspect,
} from './activation-input';

/** An `activation_checklist` payload: the document without ids, versions or status. */
export interface ActivationChecklistPayload {
  aspects: {
    code: string;
    label: string;
    items: { code: string; label: string; autoLink?: string | null }[];
  }[];
}

/** The seed as a payload: a template's starting point, and an office's until a company publishes one. */
export function defaultActivationChecklist(): ActivationChecklistPayload {
  return {
    aspects: SEED_ACTIVATION_ASPECTS.map((aspect) => ({
      code: aspect.code,
      label: aspect.label,
      items: SEED_ACTIVATION_ITEMS
        .filter((item) => item.aspectCode === aspect.code)
        .map((item) => ({ code: item.code, label: item.label, autoLink: item.autoLink })),
    })),
  };
}

/**
 * What would make an `activation_checklist` payload produce a broken office — one sentence each,
 * empty when there is nothing.
 *
 * **The same checker an office's own save meets** (ADR-0030), so a template cannot publish a
 * checklist an office could not have written. What it cannot check is whether a training link names
 * a module that exists: a template has no office to ask, and provisioning checks it against the
 * modules it has just copied (P5-T3 AC-5).
 */
export function activationChecklistProblems(payload: unknown): string[] {
  try {
    checkActivationChecklist(payload);
    return [];
  } catch (err) {
    const details = (err as { details?: { violations?: string[] } }).details;
    return details?.violations ?? [(err as Error).message];
  }
}

/** Every training module code a checklist names, once each, for the caller that resolves them. */
export function activationTrainingLinks(aspects: readonly CheckedActivationAspect[]): string[] {
  const codes = new Set<string>();
  for (const aspect of aspects) {
    for (const item of aspect.items) {
      const code = trainingLinkModuleCode(item.autoLink);
      if (code !== null) codes.add(code);
    }
  }
  return [...codes];
}

/** The checked aspects of a payload, ready to be written as an office's version 1. */
export function activationSeedAspects(payload: unknown): CheckedActivationAspect[] {
  return checkActivationChecklist(payload).aspects;
}
