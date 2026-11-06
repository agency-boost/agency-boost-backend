import { createHash } from 'node:crypto';
import type { Model } from 'mongoose';
import { DEFAULT_TENANT_TIMEZONE, type ProductCurrency } from '@/domain/constants';
import type { Clock } from '@/common/clock/clock.port';
import type { ProductDocument } from './product.schema';
import { checkProposalSettings, type ProposalSettings } from './proposal-fields';
import type { ProposalImportRow } from './proposal-fields-prudential';

/**
 * **The proposal fields import** (P19.7-T1 AC-4; ADR-0225 §10): a draft's rows written onto one company's products,
 * matched by code — run by the operator for production (`cli/import-proposal-fields.ts`) and by the demo seed on its
 * Prudential company. **Re-runnable**, and running it twice changes nothing:
 *
 * - a product whose proposal fields are **empty** is written;
 * - a product whose fields are **still exactly the import's own** — they hash to `proposalFieldsSource.hash` — is
 *   written again only if the draft changed, and is otherwise `unchanged`;
 * - a product whose fields **anybody else wrote** — the Super Admin's edit, or another import's — is `skipped`, never
 *   overwritten;
 * - a code with **no product** is `missing`, and nothing is created.
 *
 * Each write is the product's next version, pinned to the one read, and audited `product.updated` with `reason:
 * 'proposal_fields_import'` and the fields written — never a value. What it writes is checked by the same rules a
 * Super Admin's save is (`checkProposalSettings`), against the product's own channel and currencies.
 */

/** What the import writes, and the only part of a product it compares. */
type Imported = Pick<ProposalSettings, 'proposalFields' | 'proposalTypeLabel' | 'defaultInsured'>;

/** The audit row the import leaves for each product it writes. */
export interface ImportAuditEntry {
  action: 'product.updated';
  targetCollection: 'products';
  targetId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface ProposalFieldsImportReport {
  written: string[];
  unchanged: string[];
  /** Codes whose fields somebody else wrote: left as they are. */
  skipped: string[];
  /** Codes the draft names that this company has no product for. */
  missing: string[];
}

/** JSON with its keys in order, so two equal settings hash alike however they were stored. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The hash `proposalFieldsSource` records: what the import wrote, and nothing else of the product. */
export function proposalFieldsHash(settings: Imported): string {
  return createHash('sha256').update(canonical({
    proposalFields: settings.proposalFields ?? [],
    proposalTypeLabel: settings.proposalTypeLabel ?? null,
    defaultInsured: settings.defaultInsured ?? null,
  })).digest('hex');
}

export async function importProposalFields(
  deps: {
    products: Model<ProductDocument>;
    clock: Clock;
    /** Writes one audit row; the caller names the actor. */
    audit: (entry: ImportAuditEntry) => Promise<void>;
  },
  companyId: string,
  source: { name: string; rows: readonly ProposalImportRow[] },
): Promise<ProposalFieldsImportReport> {
  const report: ProposalFieldsImportReport = { written: [], unchanged: [], skipped: [], missing: [] };
  const today = deps.clock.localDateFor(DEFAULT_TENANT_TIMEZONE, deps.clock.now());

  for (const row of source.rows) {
    for (const code of row.codes) {
      const product = await deps.products.findOne({ companyId, code, deletedAt: null }).exec();
      if (!product) { report.missing.push(code); continue; }

      const currencies = (product.currencies ?? ['IDR']) as ProductCurrency[];
      const checked = checkProposalSettings(
        { proposalFields: row.fields(currencies), proposalTypeLabel: row.typeLabel, defaultInsured: row.defaultInsured ?? null },
        { proposalFields: [] },
        { channel: product.channel, category: product.category, currencies, today },
      );
      const next: Imported = {
        proposalFields: checked.proposalFields,
        proposalTypeLabel: checked.proposalTypeLabel,
        defaultInsured: checked.defaultInsured,
      };
      const nextHash = proposalFieldsHash(next);
      const now: Imported = {
        proposalFields: product.proposalFields ?? [],
        proposalTypeLabel: product.proposalTypeLabel ?? null,
        defaultInsured: product.defaultInsured ?? null,
      };
      const nowHash = proposalFieldsHash(now);
      const empty = now.proposalFields.length === 0 && now.proposalTypeLabel === null && now.defaultInsured === null;
      const ours = product.proposalFieldsSource?.import === source.name && product.proposalFieldsSource.hash === nowHash;

      if (!empty && !ours) { report.skipped.push(code); continue; }
      if (ours && nowHash === nextHash) { report.unchanged.push(code); continue; }

      const written = await deps.products.findOneAndUpdate(
        { _id: product._id, companyId, deletedAt: null, version: product.version },
        {
          $set: {
            ...next,
            proposalFieldsSource: { import: source.name, hash: nextHash },
            updatedBy: null,
          },
          $inc: { version: 1 },
        },
        { new: true },
      ).exec();
      // Somebody saved it between the read and the write: theirs stands, and the next run looks again.
      if (!written) { report.skipped.push(code); continue; }
      await deps.audit({
        action: 'product.updated',
        targetCollection: 'products',
        targetId: String(product._id),
        before: { proposalFields: now.proposalFields.length, version: product.version },
        after: {
          fields: ['proposalFields', 'proposalTypeLabel', 'defaultInsured'],
          reason: 'proposal_fields_import',
          import: source.name,
          code,
        },
      });
      report.written.push(code);
    }
  }
  return report;
}
