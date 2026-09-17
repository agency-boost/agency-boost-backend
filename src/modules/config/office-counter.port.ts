import type { TemplateKind } from './company-template.schema';

/**
 * Where a company's offices stand against the published version of one template kind.
 *
 * Two numbers, not one (P5-T12). `behind` is known: an office built from an older version of
 * this kind, or from the platform defaults when nothing was published. `unrecorded` is not: an
 * office created before provisioning recorded this kind, which may be perfectly current. A
 * single count would have told a Super Admin that every existing office was "running something
 * older" on the Lead statuses and Ratio benchmarks tabs, when most of them are not.
 */
export interface OfficeStanding {
  behind: number;
  unrecorded: number;
}

/**
 * How a company's offices stand against a template.
 *
 * A port rather than a direct `kpms` read, because `TemplateService` lives in the config
 * module and `kpms` belongs to tenants — and the dependency the other way already exists
 * (`TenantService` calls `ProvisioningService`). One direction only.
 */
export abstract class OfficeCounter {
  abstract standing(companyId: string, kind: TemplateKind, version: number): Promise<OfficeStanding>;
}
