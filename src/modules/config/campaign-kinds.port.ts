import type { CampaignKindsPayload } from '@/modules/campaigns/campaign-kinds-payload';

/**
 * How a published `campaign_kinds` template reaches the company's rules (P5-T9 AC-4).
 *
 * A port rather than a direct dependency, for the same reason as {@link OfficeCounter}: the thing
 * that does the writing is `ProvisioningService`, and one narrow method is a smaller surface for
 * `TemplateService` to depend on than a service holding fifteen models.
 *
 * **It is applied at publish rather than at provisioning**, and that is not an inconsistency: every
 * other kind is copied into a new office because the rows live in the office, and carrier rules do
 * not — they are company-partitioned and read live by every office (ADR-0026). There is nothing to
 * copy and nowhere to copy it to, so publishing is the act itself.
 */
export abstract class CampaignKindsApplier {
  abstract applyCampaignKinds(
    companyId: string, payload: CampaignKindsPayload,
  ): Promise<{ written: number; retired: number }>;
}
