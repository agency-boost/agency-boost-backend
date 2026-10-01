import { Fields, refuseWith } from '@/common/validation/fields';
import {
  CAMPAIGN_EVALUATION_PHASE, METRIC_REGISTRY, REQUIREMENT_COMPARATORS, metricByKey,
  type RequirementComparator,
} from '@/domain/constants';

export interface CheckedRequirement {
  metricKey: string;
  comparator: RequirementComparator;
  value: number;
  unit: string;
}

export interface CheckedCampaign {
  code?: string;
  title?: string;
  description?: string;
  startsAt?: Date;
  endsAt?: Date;
  reward?: string;
  requirements?: CheckedRequirement[];
}

/**
 * One campaign, read field by field (P5-T7).
 *
 * The rule that matters is **AC-1**: a requirement names a metric this product can compute, or it
 * is refused **saying which** and, where the metric exists but arrives later, **which phase brings
 * it**. The prototype's requirements are display strings, so a campaign could promise a reward
 * against a figure nothing ever produces and nobody would find out until somebody asked why they
 * had not qualified.
 */
export function checkCampaign(body: unknown, opts: { partial?: boolean } = {}): CheckedCampaign {
  const required = !opts.partial;
  const source = (body ?? {}) as Record<string, unknown>;
  const f = new Fields(source, [
    'code', 'title', 'description', 'startsAt', 'endsAt', 'reward', 'requirements',
  ]);

  const code = f.code('code', required);
  const title = f.text('title', { min: 1, max: 200 }, required);
  const description = f.text('description', { min: 0, max: 2000 }, false);
  const reward = f.text('reward', { min: 0, max: 300 }, false);

  // After every `Fields` read: it pushes as it goes, so a copy taken earlier drops the lot.
  const violations = [...f.violations];

  const startsAt = instant(source.startsAt, 'startsAt', required, violations);
  const endsAt = instant(source.endsAt, 'endsAt', required, violations);
  if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
    violations.push('endsAt must be after startsAt.');
  }

  const requirements = readRequirements(source.requirements, violations);

  if (violations.length > 0) refuseWith(violations);
  return {
    ...(code !== undefined ? { code } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(reward !== undefined ? { reward } : {}),
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
    ...(requirements !== undefined ? { requirements } : {}),
  };
}

function instant(
  raw: unknown, field: string, required: boolean, violations: string[],
): Date | undefined {
  if (raw === undefined) {
    if (required) violations.push(`${field} is required.`);
    return undefined;
  }
  const value = new Date(String(raw));
  if (Number.isNaN(value.getTime())) {
    violations.push(`${field} is not a date and time.`);
    return undefined;
  }
  return value;
}

function readRequirements(
  raw: unknown, violations: string[],
): CheckedRequirement[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    violations.push('requirements must be a list.');
    return undefined;
  }

  const read: CheckedRequirement[] = [];
  raw.forEach((row, index) => {
    const where = `Requirement ${index + 1}`;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      violations.push(`${where} must be an object of fields.`);
      return;
    }
    const r = row as Record<string, unknown>;
    const metricKey = String(r.metricKey ?? '').trim().toUpperCase();
    const comparator = String(r.comparator ?? '');

    const metric = metricByKey(metricKey);
    if (!metric) {
      // Named, and with the alternatives: "that is not a metric" leaves somebody guessing what is.
      violations.push(
        `${where}: "${metricKey}" is not a metric this product measures. One of: `
        + `${METRIC_REGISTRY.map((m) => m.key).join(', ')}.`,
      );
    } else if (metric.phase > CAMPAIGN_EVALUATION_PHASE) {
      // Accepting it would be a campaign nobody can ever qualify for, failing silently. The Owner
      // reads this, so it says what is true now and names no phase: a phase number is our
      // schedule, and an Owner can do nothing with it (P10.1-T2 AC-3, ADR-0062 §3).
      violations.push(
        `${where}: ${metric.name} is not measured yet, so a campaign asking for it could never `
        + 'qualify anybody.',
      );
    }

    if (!(REQUIREMENT_COMPARATORS as readonly string[]).includes(comparator)) {
      violations.push(
        `${where}: comparator is one of ${REQUIREMENT_COMPARATORS.join(', ')}.`,
      );
    }

    const value = Number(r.value);
    if (!Number.isFinite(value)) {
      violations.push(`${where}: value must be a number.`);
    } else if (metric?.unit === 'idr_minor' && !Number.isInteger(value)) {
      // Money is integer minor units, never a float (invariant §9).
      violations.push(
        `${where}: ${metric.name} is money, so it is whole sen — ${value} is not.`,
      );
    }

    if (metric && (REQUIREMENT_COMPARATORS as readonly string[]).includes(comparator)
      && Number.isFinite(value)) {
      read.push({
        metricKey,
        comparator: comparator as RequirementComparator,
        value,
        // Copied from the registry rather than taken from the caller: a client that sent its own
        // could label sen as rupiah and every screen would render the wrong number.
        unit: metric.unit,
      });
    }
  });
  return read;
}
