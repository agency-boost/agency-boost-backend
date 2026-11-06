import type { FieldSentence } from '@/common/validation/fields';
import {
  SEED_CAPABILITY_GRIDS, SEED_CAPABILITY_MILESTONES, SEED_CAPABILITY_STAGES,
} from '@/domain/constants';
import { CAPABILITY_REFUSALS, type CapabilityPlace } from './capability.messages';

const SAY = CAPABILITY_REFUSALS.VALIDATION_FAILED;

/** A `capability_ladder` payload: the three lists, without status or ids of the document itself. */
export interface CapabilityLadderPayload {
  stages: {
    code: string; label: string; requiredMilestoneCodes: string[]; stageOrder: number;
  }[];
  milestones: { code: string; label: string }[];
  grids: {
    code: string; label: string; requiresDownline?: boolean;
    items: { code: string; label: string }[];
  }[];
}

/** The domain defaults as a payload — a template's starting point, and a company's seed. */
export function defaultCapabilityLadder(): CapabilityLadderPayload {
  return {
    stages: SEED_CAPABILITY_STAGES.map((s) => ({
      code: s.code,
      label: s.label,
      requiredMilestoneCodes: [...s.requiredMilestoneCodes],
      stageOrder: s.stageOrder,
    })),
    milestones: SEED_CAPABILITY_MILESTONES.map((m) => ({ code: m.code, label: m.label })),
    grids: SEED_CAPABILITY_GRIDS.map((g) => ({
      code: g.code,
      label: g.label,
      requiresDownline: g.requiresDownline,
      items: g.items.map((i) => ({ code: i.code, label: i.label })),
    })),
  };
}

/**
 * What would make a `capability_ladder` payload produce a broken office — one sentence each, in both languages
 * (P18.10-T5 AC-3), empty when there is nothing (P5-T8 AC-5).
 *
 * **Today a payload of any shape publishes.** A catalog with no stages, or two items sharing a
 * code, or a stage requiring a milestone nobody defined, reaches every office created afterwards
 * and nothing says so until a leader opens an assessment and finds it cannot be scored.
 */
export function capabilityLadderProblems(payload: unknown): FieldSentence[] {
  const problems: FieldSentence[] = [];
  const source = (payload ?? {}) as Record<string, unknown>;

  const list = (key: 'stages' | 'milestones' | 'grids'): Record<string, unknown>[] => {
    if (Array.isArray(source[key])) return source[key] as Record<string, unknown>[];
    problems.push(SAY.notAList({ key }));
    return [];
  };

  const stages = list('stages');
  const milestones = list('milestones');
  const grids = list('grids');

  if (stages.length === 0) {
    problems.push(SAY.noStages);
  }
  if (milestones.length === 0) {
    problems.push(SAY.noMilestones);
  }

  const seen = new Set<string>();
  const readCode = (row: Record<string, unknown>, place: CapabilityPlace): string | null => {
    const code = String(row.code ?? '').trim().toUpperCase();
    if (!code) {
      problems.push(SAY.noCode({ place }));
      return null;
    }
    if (seen.has(code)) {
      // Across the whole catalog: a tick names a code, not a code within a list.
      problems.push(SAY.codeTwice({ code }));
    }
    seen.add(code);
    if (!String(row.label ?? '').trim()) problems.push(SAY.noLabel({ place }));
    return code;
  };

  const milestoneCodes = new Set<string>();
  milestones.forEach((m, i) => {
    const code = readCode(m, { part: 'milestone', n: i + 1 });
    if (code) milestoneCodes.add(code);
  });

  const stageOrders = new Set<number>();
  stages.forEach((s, i) => {
    readCode(s, { part: 'stage', n: i + 1 });
    const order = Number(s.stageOrder);
    if (!Number.isInteger(order) || order < 1) {
      problems.push(SAY.stageOrderMin({ stage: i + 1 }));
    } else if (stageOrders.has(order)) {
      // Two stages at one rank make "the highest reached" ambiguous.
      problems.push(SAY.stageOrderShared({ order }));
    } else {
      stageOrders.add(order);
    }

    const required = Array.isArray(s.requiredMilestoneCodes) ? s.requiredMilestoneCodes : [];
    if (required.length === 0) {
      problems.push(SAY.stageNoMilestone({ stage: i + 1 }));
    }
    for (const raw of required) {
      const code = String(raw).trim().toUpperCase();
      if (!milestoneCodes.has(code)) {
        problems.push(SAY.stageUnknownMilestone({ stage: i + 1, code }));
      }
    }
  });

  grids.forEach((g, i) => {
    readCode(g, { part: 'grid', n: i + 1 });
    const items = Array.isArray(g.items) ? (g.items as Record<string, unknown>[]) : [];
    if (items.length === 0) {
      problems.push(SAY.gridNoItems({ grid: i + 1 }));
    }
    items.forEach((item, j) => readCode(item, { part: 'item', grid: i + 1, n: j + 1 }));
  });

  return problems;
}

/** The rows an office's copy starts as, from a payload `capabilityLadderProblems` passed. */
export function capabilitySeedDocument(kpmId: string, payload: CapabilityLadderPayload) {
  const code = (value: string) => value.trim().toUpperCase();
  return {
    kpmId,
    stages: payload.stages.map((s, index) => ({
      code: code(s.code),
      label: s.label.trim(),
      requiredMilestoneCodes: s.requiredMilestoneCodes.map(code),
      stageOrder: s.stageOrder,
      displayOrder: index + 1,
      status: 'active' as const,
    })),
    milestones: payload.milestones.map((m, index) => ({
      code: code(m.code), label: m.label.trim(), displayOrder: index + 1, status: 'active' as const,
    })),
    grids: payload.grids.map((g, index) => ({
      code: code(g.code),
      label: g.label.trim(),
      requiresDownline: g.requiresDownline ?? false,
      displayOrder: index + 1,
      status: 'active' as const,
      items: g.items.map((item, j) => ({
        code: code(item.code), label: item.label.trim(), displayOrder: j + 1,
        status: 'active' as const,
      })),
    })),
    version: 1,
    deletedAt: null,
    createdBy: null,
    updatedBy: null,
  };
}
