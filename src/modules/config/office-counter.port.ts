import type { TemplateKind } from './company-template.schema';

/**
 * Where a company's offices stand against the published version of one template kind.
 *
 * Two numbers, not one (P5-T12). `behind` is known: an office built from an older version of
 * this kind, or whose record of it has no version — since 13.2, because its template held none of the
 * kind when it was made; before 13.2, because it was built from the platform defaults when the company
 * had published nothing of it. `unrecorded` is not: an
 * office created before provisioning recorded this kind, which may be perfectly current. A
 * single count would have told a Super Admin that every existing office was "running something
 * older" on the Lead statuses and Ratio benchmarks tabs, when most of them are not.
 */
export interface OfficeStanding {
  behind: number;
  unrecorded: number;
}

/**
 * **Which offices one named template answers for** (ADR-0115 §3, P13.2-T6 AC-6): those started from
 * it, and — for the template migration `0023` made — the offices created before 13.2, which were
 * built from the rows that template now holds and record no template at all.
 */
export interface TemplateScope {
  templateId: string;
  holdsLegacyOffices: boolean;
}

/**
 * **One office a template answers for, and what it was built from** (ADR-0185 §4): what the checklist's *N KPM memakai
 * versi lama* lists. `seededFrom` is the office's own record, kind by kind, as `kpms.seededFrom` holds it.
 */
export interface OfficeSeeds {
  id: string;
  code: string;
  branchName: string;
  seededFrom: Partial<Record<TemplateKind, { version: number | null }>>;
}

/**
 * **Where one office stands against one published version of one kind** — the rule `KpmOfficeCounter.standing` counts
 * with, written once for a reader that has the office in hand rather than a count to make (ADR-0185 §4).
 *
 * - no record of the kind → `unrecorded`: created before provisioning recorded it, and possibly current (P5-T12);
 * - a record with no version, or an older one → `behind`: built from nothing of the kind, or from an earlier version;
 * - otherwise `current`.
 */
export function standingOf(
  record: { version: number | null } | undefined, publishedVersion: number,
): 'current' | 'behind' | 'unrecorded' {
  if (!record) return 'unrecorded';
  if (record.version === null || record.version === undefined || record.version < publishedVersion) return 'behind';
  return 'current';
}

/**
 * How a company's offices stand against a template.
 *
 * A port rather than a direct `kpms` read, because `TemplateService` lives in the config
 * module and `kpms` belongs to tenants — and the dependency the other way already exists
 * (`TenantService` calls `ProvisioningService`). One direction only.
 */
export abstract class OfficeCounter {
  /**
   * **The live offices one template answers for**, each with its seed record (ADR-0185 §4), by code. The offices
   * {@link standing} counts, named — for the dialog behind the checklist's count.
   */
  abstract officesOf(companyId: string, scope: TemplateScope): Promise<OfficeSeeds[]>;

  /** Counted per template since 13.2: an office started from another template is not this one's. */
  abstract standing(
    companyId: string, kind: TemplateKind, version: number, scope: TemplateScope,
  ): Promise<OfficeStanding>;

  /**
   * How many live offices each template of a company answers for, keyed by template id. Offices
   * started from the AgencyBoost defaults or *Empty* are nobody's; offices created before 13.2 are
   * `legacyTemplateId`'s when there is one.
   */
  abstract countsByTemplate(
    companyId: string, legacyTemplateId: string | null,
  ): Promise<Map<string, number>>;
}
