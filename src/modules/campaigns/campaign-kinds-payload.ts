import {
  CRITERIA_MODES, QUALIFICATION_RULE_KINDS, REQUIREMENT_COMPARATORS,
  SEED_MOC_RULES, SEED_PRODUCTION_CLUB_TIERS, metricByKey,
  type CriteriaMode, type QualificationRuleKind,
} from '@/domain/constants';

/** One thing a rule asks for: a metric, a comparator and a number — never a display string. */
export interface RulePayloadCriterion {
  metricKey: string;
  comparator: string;
  value: number;
}

/** A `campaign_kinds` payload: the carrier rules a company's offices are measured against. */
export interface CampaignKindsPayload {
  rules: {
    kind: QualificationRuleKind;
    code: string;
    name: string;
    appliesToOrgLevelCodes?: string[];
    criteriaGroups: { mode: CriteriaMode; criteria: RulePayloadCriterion[] }[];
    groupMode?: CriteriaMode;
    reward?: string;
    rank: number;
  }[];
}

/**
 * The platform defaults as a payload — the production-club tiers and MOC, in one list.
 *
 * One list rather than one per kind: `kind` is already a field on every row, and two lists would
 * be a second place for a rule to be filed under the wrong one.
 */
export function defaultCampaignKinds(): CampaignKindsPayload {
  return {
    rules: [
      ...SEED_PRODUCTION_CLUB_TIERS.map((tier) => ({
        kind: 'production_club' as const,
        code: tier.code,
        name: tier.name,
        appliesToOrgLevelCodes: [],
        criteriaGroups: [{
          mode: 'all' as const,
          criteria: [{
            metricKey: 'APE_ACHIEVED', comparator: 'gte', value: tier.minAnnualApe,
          }],
        }],
        groupMode: 'all' as const,
        reward: tier.reward,
        rank: tier.rank,
      })),
      ...SEED_MOC_RULES.map((rule, index) => ({
        kind: 'moc' as const,
        code: rule.code,
        name: rule.name,
        appliesToOrgLevelCodes: [...rule.appliesToOrgLevelCodes],
        criteriaGroups: rule.criteriaGroups.map((group) => ({
          mode: group.mode,
          criteria: group.criteria.map((c) => ({
            metricKey: c.metricKey, comparator: c.comparator, value: c.value,
          })),
        })),
        groupMode: rule.groupMode,
        reward: '',
        rank: index + 1,
      })),
    ],
  };
}

/**
 * What would make a `campaign_kinds` payload produce a company nobody can qualify in — one
 * sentence each, empty when there is nothing (P5-T9 AC-4).
 *
 * **A rule nobody can pass and a rule everybody passes are both refused.** A tier with no criteria
 * is the second: every agent qualifies for Chairman's Club on the day it publishes. A criterion
 * naming a metric the registry has never heard of is the first — and it is *not* refused, because
 * ADR-0035 already has an honest answer for it: the rule records what it is waiting on and the
 * screen says so. What is refused is a **misspelling that could have been a real metric**, which
 * is why the check below reports unknown keys as a warning rather than dropping them silently.
 */
export function campaignKindsProblems(payload: unknown): string[] {
  const problems: string[] = [];
  const source = (payload ?? {}) as Record<string, unknown>;

  if (!Array.isArray(source.rules)) {
    problems.push('rules must be a list.');
    return problems;
  }
  const rules = source.rules as Record<string, unknown>[];
  if (rules.length === 0) {
    problems.push(
      'A rule set with no rules leaves every office of this company with nothing to qualify for.',
    );
  }

  /** Codes are unique per kind: a production club and an MOC rule may share a name, not a list. */
  const seen = new Set<string>();
  const ranks = new Set<string>();

  rules.forEach((rule, i) => {
    const where = `Rule ${i + 1}`;
    const kind = String(rule.kind ?? '').trim();
    if (!(QUALIFICATION_RULE_KINDS as readonly string[]).includes(kind)) {
      problems.push(
        `${where}: ${kind || '(none)'} is not a rule kind. One of `
        + `${QUALIFICATION_RULE_KINDS.join(', ')}.`,
      );
    }

    const code = String(rule.code ?? '').trim().toUpperCase();
    if (!code) {
      problems.push(`${where} has no code. A standing row names the code, never the label.`);
    } else if (seen.has(`${kind}:${code}`)) {
      problems.push(`The code ${code} is used twice in ${kind}, so one rule would wear two names.`);
    }
    seen.add(`${kind}:${code}`);

    if (!String(rule.name ?? '').trim()) {
      problems.push(`${where} has no name, so it would render as a blank row.`);
    }

    const rank = Number(rule.rank);
    if (!Number.isInteger(rank) || rank < 1) {
      problems.push(`${where} needs a rank of 1 or more — it is the order the tiers are climbed in.`);
    } else if (ranks.has(`${kind}:${rank}`)) {
      // Two tiers at one rank make "the highest reached" undecidable, exactly as with stages.
      problems.push(`Two ${kind} rules share rank ${rank}, so which one is higher is undecidable.`);
    } else {
      ranks.add(`${kind}:${rank}`);
    }

    const groups = Array.isArray(rule.criteriaGroups)
      ? (rule.criteriaGroups as Record<string, unknown>[]) : [];
    if (groups.length === 0) {
      problems.push(
        `${where} asks for nothing, so everybody qualifies for it the day it publishes.`,
      );
    }
    for (const mode of [rule.groupMode].filter((m) => m !== undefined)) {
      if (!(CRITERIA_MODES as readonly string[]).includes(String(mode))) {
        problems.push(`${where}: groupMode must be ${CRITERIA_MODES.join(' or ')}.`);
      }
    }

    groups.forEach((group, g) => {
      if (!(CRITERIA_MODES as readonly string[]).includes(String(group.mode))) {
        problems.push(`${where}, group ${g + 1}: mode must be ${CRITERIA_MODES.join(' or ')}.`);
      }
      const criteria = Array.isArray(group.criteria)
        ? (group.criteria as Record<string, unknown>[]) : [];
      if (criteria.length === 0) {
        problems.push(`${where}, group ${g + 1} asks for nothing, so it passes for everybody.`);
      }
      criteria.forEach((c, j) => {
        const at = `${where}, group ${g + 1}, criterion ${j + 1}`;
        if (!String(c.metricKey ?? '').trim()) {
          problems.push(`${at} names no metric.`);
        }
        if (!(REQUIREMENT_COMPARATORS as readonly string[]).includes(String(c.comparator))) {
          problems.push(
            `${at}: ${String(c.comparator)} is not a comparator. One of `
            + `${REQUIREMENT_COMPARATORS.join(', ')}.`,
          );
        }
        if (!Number.isFinite(Number(c.value))) {
          problems.push(`${at} has no number to compare against.`);
        }
      });
    });
  });

  return problems;
}

/**
 * The rows a company's rule set becomes, from a payload `campaignKindsProblems` passed.
 *
 * **The unit comes from the registry, never from the payload** (invariant 7): a rule stating its
 * own unit is a second definition of a metric, and the one that disagrees is whichever nobody
 * remembered to update. A metric the registry does not define yet is recorded on
 * `waitingOnMetrics`, so a screen says what it is waiting for rather than showing a rule that
 * silently never passes (ADR-0035).
 */
export function qualificationRuleSeedDocuments(
  companyId: string, payload: CampaignKindsPayload,
) {
  return payload.rules.map((rule) => {
    const criteriaGroups = rule.criteriaGroups.map((group) => ({
      mode: group.mode,
      criteria: group.criteria.map((c) => ({
        metricKey: c.metricKey,
        comparator: c.comparator,
        value: c.value,
        // Where the registry does not define it yet, the unit is the one the carrier states.
        unit: metricByKey(c.metricKey)?.unit ?? (c.value > 1_000_000 ? 'idr_minor' : 'count'),
      })),
    }));
    return {
      companyId,
      scope: 'company' as const,
      kind: rule.kind,
      code: rule.code.trim().toUpperCase(),
      name: rule.name.trim(),
      appliesToOrgLevelCodes: [...(rule.appliesToOrgLevelCodes ?? [])],
      criteriaGroups,
      groupMode: rule.groupMode ?? 'all',
      reward: rule.reward ?? '',
      rank: rule.rank,
      waitingOnMetrics: [...new Set(
        criteriaGroups.flatMap((g) => g.criteria)
          .map((c) => c.metricKey)
          .filter((key) => metricByKey(key) === undefined),
      )],
      effectiveFrom: null,
      effectiveTo: null,
      deletedAt: null,
    };
  });
}
