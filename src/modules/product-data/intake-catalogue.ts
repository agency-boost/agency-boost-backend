import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model } from 'mongoose';
import { calcSettingsOf, formulaNamesOf, type ProposalField } from '@/modules/products/proposal-fields';
import { Product, type ProductDocument } from '@/modules/products/product.schema';
import { Company, type CompanyDocument } from '@/modules/tenants/company.schema';
import type { CatalogueEntry, CompanyEntry } from './ai/reader.port';

/**
 * **The catalogue a reading is told, and the products a card is checked against** (P19.15-T2, T3). Company data, read
 * by company like `ProductService` reads it (ADR-0033) — `products` and `companies` carry no `kpmId`, so there is no
 * tenant repository to go through; every read names its company.
 */
@Injectable()
export class IntakeCatalogue {
  constructor(
    @InjectModel(Product.name) private readonly products: Model<ProductDocument>,
    @InjectModel(Company.name) private readonly companiesModel: Model<CompanyDocument>,
  ) {}

  async companies(): Promise<CompanyEntry[]> {
    const rows = await this.companiesModel.find({ deletedAt: null }).select('name').sort({ name: 1 }).lean().exec();
    return rows.map((c) => ({ id: String(c._id), name: String((c as { name?: string }).name ?? '') }));
  }

  /** A company's catalogue, or every company's when `companyId` is `null` (*Perusahaan*'s upload). */
  async catalogue(companyId: string | null): Promise<CatalogueEntry[]> {
    if (companyId !== null && !isValidObjectId(companyId)) return [];
    const rows = await this.products.find({ ...(companyId ? { companyId } : {}), deletedAt: null }).sort({ companyId: 1, sortOrder: 1 }).exec();
    return rows.map((p) => entryOf(p));
  }

  async product(companyId: string, productId: string): Promise<ProductDocument | null> {
    if (!isValidObjectId(productId)) return null;
    return this.products.findOne({ _id: productId, companyId, deletedAt: null }).exec();
  }
}

/** One product as a reading is told it. */
export function entryOf(p: ProductDocument): CatalogueEntry {
  const calc = calcSettingsOf(p as unknown as Record<string, unknown>);
  const fields = ((p as unknown as { proposalFields?: ProposalField[] }).proposalFields ?? []);
  return {
    id: String(p._id),
    companyId: p.companyId,
    code: p.code,
    name: p.name,
    syariahName: (p as unknown as { syariahName?: string | null }).syariahName ?? null,
    category: p.category,
    calcType: calc.calcType,
    payTerms: calc.payTerms.map((t) => ({ key: t.key, label: t.label })),
    formulaNames: formulaNamesOf(fields, calc.calcType),
    lifecycle: String((p as unknown as { lifecycle?: string }).lifecycle ?? 'active'),
  };
}
