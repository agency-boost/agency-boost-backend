import {
  SEED_CAPABILITY_GRIDS, SEED_CAPABILITY_MILESTONES, SEED_CAPABILITY_STAGES,
} from '@/domain/constants';

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
 * What would make a `capability_ladder` payload produce a broken office — one sentence each,
 * empty when there is nothing (P5-T8 AC-5).
 *
 * **Today a payload of any shape publishes.** A catalog with no stages, or two items sharing a
 * code, or a stage requiring a milestone nobody defined, reaches every office created afterwards
 * and nothing says so until a leader opens an assessment and finds it cannot be scored.
 */
export function capabilityLadderProblems(payload: unknown): string[] {
  const problems: string[] = [];
  const source = (payload ?? {}) as Record<string, unknown>;

  const list = (key: 'stages' | 'milestones' | 'grids'): Record<string, unknown>[] => {
    if (Array.isArray(source[key])) return source[key] as Record<string, unknown>[];
    problems.push(`${key} must be a list.`);
    return [];
  };

  const stages = list('stages');
  const milestones = list('milestones');
  const grids = list('grids');

  if (stages.length === 0) {
    problems.push('A capability catalog with no stages is a ladder nobody can be on.');
  }
  if (milestones.length === 0) {
    problems.push('A capability catalog with no milestones can never place anybody on a stage.');
  }

  const seen = new Set<string>();
  const readCode = (row: Record<string, unknown>, where: string): string | null => {
    const code = String(row.code ?? '').trim().toUpperCase();
    if (!code) {
      problems.push(`${where} has no code. Every item carries one, so a rename never moves a tick.`);
      return null;
    }
    if (seen.has(code)) {
      // Across the whole catalog: a tick names a code, not a code within a list.
      problems.push(`The code ${code} is used twice. A tick names a code, so two would be one tick.`);
    }
    seen.add(code);
    if (!String(row.label ?? '').trim()) problems.push(`${where} has no label.`);
    return code;
  };

  const milestoneCodes = new Set<string>();
  milestones.forEach((m, i) => {
    const code = readCode(m, `Milestone ${i + 1}`);
    if (code) milestoneCodes.add(code);
  });

  const stageOrders = new Set<number>();
  stages.forEach((s, i) => {
    readCode(s, `Stage ${i + 1}`);
    const order = Number(s.stageOrder);
    if (!Number.isInteger(order) || order < 1) {
      problems.push(`Stage ${i + 1} needs a stageOrder of 1 or more — it is how senior the stage is.`);
    } else if (stageOrders.has(order)) {
      // Two stages at one rank make "the highest reached" ambiguous.
      problems.push(`Two stages share stageOrder ${order}, so which one somebody reached is undecidable.`);
    } else {
      stageOrders.add(order);
    }

    const required = Array.isArray(s.requiredMilestoneCodes) ? s.requiredMilestoneCodes : [];
    if (required.length === 0) {
      problems.push(`Stage ${i + 1} requires no milestone, so everybody is already on it.`);
    }
    for (const raw of required) {
      const code = String(raw).trim().toUpperCase();
      if (!milestoneCodes.has(code)) {
        problems.push(
          `Stage ${i + 1} requires ${code}, which no milestone in this catalog is — nobody could `
          + 'ever reach it.',
        );
      }
    }
  });

  grids.forEach((g, i) => {
    readCode(g, `Grid ${i + 1}`);
    const items = Array.isArray(g.items) ? (g.items as Record<string, unknown>[]) : [];
    if (items.length === 0) {
      problems.push(`Grid ${i + 1} has no items, so there is nothing to assess in it.`);
    }
    items.forEach((item, j) => readCode(item, `Grid ${i + 1}, item ${j + 1}`));
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
