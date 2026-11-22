import mongoose from 'mongoose';
import { Workbook } from 'exceljs';
import { FixedClock, type Clock } from '@/common/clock/clock.port';
import { LeadRepository } from '@/modules/leads/lead.repository';
import { Lead, LeadSchema } from '@/modules/leads/lead.schema';
import { NoIllustrations } from '@/modules/product-data/illustration-summaries.port';
import { PremiumCalculator } from '@/modules/product-data/premium-calculator.service';
import { ProductDataAccess } from '@/modules/product-data/product-data-access.service';
import { ProductDataService } from '@/modules/product-data/product-data.service';
import { ProductRulesService } from '@/modules/product-data/product-rules.service';
import { RateRow, RateRowSchema, RateTable, RateTableSchema } from '@/modules/product-data/rate-table.schema';
import { RateTableService } from '@/modules/product-data/rate-table.service';
import { ProductService } from '@/modules/products/product.service';
import { ProposalService } from '@/modules/proposals/proposal.service';
import { TenantDay } from '@/modules/tenants/tenant-day.service';
import { KpmProductConfigRepository } from '@/modules/products/kpm-product.repository';
import { KpmProductConfigSchema } from '@/modules/products/kpm-product-config.schema';
import type { configModule } from './config-module';

/**
 * **The Proposal tab's services over the specs' database** (P19.15-T1; ADR-0258): the premium tables, the engine's
 * loader, *Isian*, the tab, the access check — and a proposal service that calculates, the way the app wires it. `now`
 * gives a clock of its own, so a spec can open the same database on another day (a scheduled version's).
 */
export function productDataFor(wired: ReturnType<typeof configModule>, now?: Date) {
  const model = (name: string, schema: mongoose.Schema) => mongoose.models[name] ?? mongoose.model(name, schema);
  const clock: Clock = now ? new FixedClock(now) : wired.clock;
  const tables = model(RateTable.name, RateTableSchema);
  const rows = model(RateRow.name, RateRowSchema);
  const products = mongoose.model('ProductModel');
  const productService = now
    ? new ProductService(products as never, wired.companies as never, wired.audit, clock,
      new KpmProductConfigRepository(model('KpmProductConfigModel', KpmProductConfigSchema) as never))
    : wired.products;
  const rateTables = new RateTableService(tables as never, rows as never, products as never, wired.users as never, wired.audit, clock);
  const calculator = new PremiumCalculator(tables as never, rows as never, clock);
  const access = new ProductDataAccess(wired.companies as never, wired.kpms as never);
  const rules = new ProductRulesService(productService, rateTables, clock);
  const data = new ProductDataService(
    products as never, wired.companies as never, wired.users as never, rateTables, calculator, access, new NoIllustrations(),
  );
  const proposals = new ProposalService(
    wired.proposalRows, new LeadRepository(model(Lead.name, LeadSchema) as never), wired.kpmProducts,
    new TenantDay(wired.kpms as never, clock), wired.audit, clock, products as never, calculator,
  );
  return { rateTables, calculator, access, rules, data, proposals, clock, tables, rows };
}

/** A workbook as an insurer might send it: *Data*, and *Ketentuan* when given. */
export async function workbookOf(data: string[][], ketentuan?: string[][]): Promise<Buffer> {
  const book = new Workbook();
  const sheet = book.addWorksheet('Data');
  for (const row of data) sheet.addRow(row);
  if (ketentuan) {
    const rules = book.addWorksheet('Ketentuan');
    for (const row of ketentuan) rules.addRow(row);
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

/**
 * **A small, made-up PCB88-like table** — sample numbers, never an insurer's rates: ages 30 to 40, both genders, the
 * smoker rate, 10 years. The rate rises 0,25 ‰ a year of age from 11,10 ‰ for a man of 30; a woman's is 85% of it; a
 * smoker's 125%.
 */
export function sampleCsv(): string {
  const lines = ['Usia;Jenis kelamin;Merokok;Masa bayar;Tarif per 1.000 UP'];
  for (let age = 30; age <= 40; age += 1) {
    const base = 11.1 + (age - 30) * 0.25;
    for (const [gender, factor] of [['L', 1], ['P', 0.85]] as const) {
      for (const [smoker, extra] of [['Tidak', 1], ['Ya', 1.25]] as const) {
        lines.push(`${age};${gender};${smoker};10 tahun;${(base * factor * extra).toFixed(4).replace('.', ',')}`);
      }
    }
  }
  return lines.join('\r\n');
}
