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
 * How a company's offices stand against a template.
 *
 * A port rather than a direct `kpms` read, because `TemplateService` lives in the config
 * module and `kpms` belongs to tenants — and the dependency the other way already exists
 * (`TenantService` calls `ProvisioningService`). One direction only.
 */
export abstract class OfficeCounter {
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
