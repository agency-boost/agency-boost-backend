import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { ProductService, type ProductView } from '@/modules/products/product.service';
import {
  checkProposalSettings, PROPOSAL_CALC_KEYS, type ProposalSettings,
} from '@/modules/products/proposal-fields';
import { RateTableService } from './rate-table.service';

/**
 * **What *Isian* writes** (P19.15-T1 AC-4; ADR-0258 §7; the P1b spec's *Tab "Isian"*): the product's proposal setup as
 * forms — the calculation type, the fields with their options and order, the pay terms with their maximum entry ages,
 * the entry ages, *Cara bayar*, *Merokok berpengaruh?*, the currencies, the UP step and limits, the premium limits, the
 * plan rule and the need. **The catalogue's own values**: they apply while no premium table is in force, and every new
 * version starts from them where the one before it does not (§3). Not the FAQ and not page 2's blocks: those are the
 * catalogue's editor's and *Ilustrasi*'s.
 */
export const RULE_KEYS = [
  'proposalFields', 'planOptions', 'syariahName', 'defaultInsured', 'proposalTypeLabel', 'currencies',
  ...PROPOSAL_CALC_KEYS.filter((key) => key !== 'rateTableId'),
] as const;
export type RuleKey = (typeof RULE_KEYS)[number];

@Injectable()
export class ProductRulesService {
  constructor(
    private readonly products: ProductService,
    private readonly tables: RateTableService,
    private readonly clock: Clock,
  ) {}

  /**
   * **What a change would do, written nowhere** (for *Unggah file*'s *"Yang kami pahami"* cards, D3): the product's
   * rules as they are and as they would be, checked by the catalogue's own rules (`checkProposalSettings`), and the
   * keys that change. A broken value is refused `400` naming its path, as a save would be.
   */
  async proposeChange(companyId: string, productId: string, input: Partial<Record<RuleKey, unknown>>): Promise<{
    before: Partial<ProposalSettings> & { currencies: string[] }; after: Partial<ProposalSettings> & { currencies: string[] }; changed: RuleKey[];
  }> {
    const product = await this.tables.productOf(companyId, productId);
    const stored = product.toObject() as unknown as Partial<ProposalSettings> & { currencies: string[]; channel: string; category: string };
    const currencies = (input.currencies as string[] | undefined) ?? stored.currencies ?? ['IDR'];
    const checked = checkProposalSettings(input as never, stored, {
      channel: stored.channel, category: stored.category, currencies, today: this.clock.localDateFor(DEFAULT_TENANT_TIMEZONE),
    });
    const keys = RULE_KEYS.filter((key) => input[key] !== undefined);
    const pick = (from: Record<string, unknown>) => Object.fromEntries(keys.map((key) => [key, from[key] ?? null]));
    const before = pick(stored as never) as never;
    const after = { ...pick(checked as never), ...(input.currencies !== undefined ? { currencies } : {}) } as never;
    const changed = keys.filter((key) => JSON.stringify((before as Record<string, unknown>)[key]) !== JSON.stringify((after as Record<string, unknown>)[key]));
    return { before, after, changed };
  }

  /**
   * **The change written**, pinned to the version the form read (`expectedVersion`, `409 VERSION_CONFLICT` when the
   * product moved since), through the catalogue's own write and its checks, and audited `product_rules.updated` with
   * every field before and after.
   */
  async apply(
    ctx: RequestContext, companyId: string, productId: string, input: Partial<Record<RuleKey, unknown>> & { expectedVersion?: number },
  ): Promise<ProductView> {
    const body: Record<string, unknown> = {};
    for (const key of RULE_KEYS) if (input[key] !== undefined) body[key] = input[key];
    if (input.expectedVersion !== undefined) body.expectedVersion = input.expectedVersion;
    return this.products.update(ctx, companyId, productId, body, { action: 'product_rules.updated' });
  }
}
