import type { RequestContext } from '@/common/context/request-context';

/**
 * **What can name a rung** (ADR-0213 §2; P19.4-T5 AC-2; `functional/org-levels.md`, *What "unused" means*): each kind of
 * record, in the order a refusal lists them. A rung any of these names, in its company, is in use and is never deleted.
 */
export const ORG_LEVEL_REFERENCE_KINDS = [
  /** A membership of any of the company's KPMs, of any status: it stands on the rung by id. */
  'memberships',
  /** A membership's role history (`membershipHistory`): it stood there once, by id. Append-only, so never gone. */
  'membershipHistory',
  /** A leader-limit request, by code: the rung its subject stood on, or the one asked for. */
  'leaderLimitRequests',
  /** An office's activity section, live, by code (`appliesToOrgLevelCodes`): its draft and what it publishes next. */
  'activityCategories',
  /** An office's ratio, live, by code. */
  'ratioDefinitions',
  /** An office's published configuration (`configSnapshots`), any version, by code: what its agents read. */
  'configSnapshots',
  /** An office's own campaign, by code. */
  'campaigns',
  /** The company's carrier rules (`qualificationRules`), by code. */
  'qualificationRules',
  /** A version or a draft of any of the company's templates, or its carrier rules' template, by code. */
  'companyTemplates',
] as const;
export type OrgLevelReferenceKind = (typeof ORG_LEVEL_REFERENCE_KINDS)[number];

/** One kind of record that names the rung, and how many of it do. */
export interface OrgLevelReference {
  kind: OrgLevelReferenceKind;
  count: number;
}

/**
 * **The reference search a rung's delete asks** (ADR-0213 §2), as a port: `OrgLevelService` depends on this and nothing
 * more, so the ladder — which the reporting and forum modules read — reaches no campaign, configuration or org
 * repository through it (their import boundaries, `reporting.imports.spec.ts` and `leader-meetings.imports.spec.ts`).
 * `OrgLevelReferences` is the one implementation, provided in its place by the application module.
 */
export abstract class OrgLevelReferenceSearch {
  /** Every kind of record in the rung's company that names it, with its count; empty when nothing does. */
  abstract of(
    ctx: RequestContext, rung: { orgLevelId: string; companyId: string; code: string },
  ): Promise<OrgLevelReference[]>;
}
