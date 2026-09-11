/**
 * How many offices of a company are on something older than the current template.
 *
 * A port rather than a direct `kpms` read, because `TemplateService` lives in the config
 * module and `kpms` belongs to tenants — and the dependency the other way already exists
 * (`TenantService` calls `ProvisioningService`). One direction only.
 */
export abstract class OfficeCounter {
  abstract countBehind(companyId: string, version: number): Promise<number>;
}
