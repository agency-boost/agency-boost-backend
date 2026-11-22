import type { RequestContext } from '@/common/context/request-context';
import type { ProductCurrency, RateBasis } from '@/domain/constants';
import type { RateRowInput, SettledRules } from './intake-apply-plan';
import type { ProductNow } from './intake-understanding';

/**
 * **Where a confirmed card goes** (P19.15-T3 AC-4; ADR-0259 §4): T1's premium tables and rules (ADR-0258), read and
 * written through this one seam, so *Unggah file* never writes a rate table or a rule its own way. A premium table is
 * made a **draft** — it then meets T1's gap check, its three test profiles and its activation, as an Excel upload does;
 * rules go through T1's change of rules. The implementation is `intake-targets.service.ts`; a test hands a fake.
 */
export abstract class IntakeTargets {
  /** The product as a card compares with it: its catalogue values and the rules of the version in force today. */
  abstract productNow(companyId: string, productId: string, today: string): Promise<ProductNow | null>;

  /** **A new premium table version, a draft**, from rows read exactly; its id. */
  abstract createRateTableDraft(ctx: RequestContext, input: {
    companyId: string;
    productId: string;
    rows: RateRowInput[];
    rules: SettledRules;
    effectiveFrom: string;
    effectiveTo: string | null;
    source: { fileName: string; assetKey: string | null; intakeItemId: string };
  }): Promise<{ rateTableId: string }>;

  /** **The rows of the version in force today**, for a percentage a person approved; `null` when none is. */
  abstract inForceRows(companyId: string, productId: string, today: string): Promise<{
    rateTableId: string; rows: RateRowInput[]; basis: RateBasis | null; currency: ProductCurrency | null;
  } | null>;

  /**
   * **Rules read from a file, applied through T1's change of rules** (ADR-0258 §3): old → new was shown on the card and
   * confirmed there. Answers what it changed: the draft version they went to, or the product.
   */
  abstract applyRules(ctx: RequestContext, input: {
    companyId: string; productId: string; rules: SettledRules; effectiveFrom: string | null; intakeItemId: string;
  }): Promise<{ kind: 'rate_table' | 'product'; id: string }>;
}
