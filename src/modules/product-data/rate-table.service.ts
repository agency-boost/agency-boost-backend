import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Workbook } from 'exceljs';
import { isValidObjectId, Model, Types } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, InvalidRequestException, NotFoundException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import type { Sentence } from '@/common/i18n/sentence';
import type { FileUpload } from '@/common/spreadsheet/file-upload.interceptor';
import { readWorkbookSheets } from '@/common/spreadsheet/read-xlsx';
import { decodeText } from '@/common/spreadsheet/text';
import { isLocalDate } from '@/common/time/local-day';
import {
  DEFAULT_TENANT_TIMEZONE, PRODUCT_DATA, PROPOSAL_PAY_FREQUENCIES, XLSX_MIME_TYPE,
  type ProductCurrency, type ProposalPayFrequency, type RateColumnRole, type RateTableSource, type RateTableStatus,
} from '@/domain/constants';
import { AuditService } from '@/modules/audit/audit.service';
import { delimiterOf, parseCsv } from '@/modules/production/production-csv';
import { Product, type ProductDocument } from '@/modules/products/product.schema';
import { calcSettingsOf, type ProposalField } from '@/modules/products/proposal-fields';
import { User, type UserDocument } from '@/modules/users/user.schema';
import { engineRowOf } from './premium-calculator.service';
import { calculate, withinTolerance, type EngineRow } from './premium-engine';
import {
  basisOf, fingerprintOf, gapsOf, ketentuanRows, mappingFault, rawFromRows, rawFromSheets, rowsFromRaw,
  rulesFromKetentuan, suggestMapping, templateHeader, type RawTable, type TableFacts,
} from './rate-file';
import { inForceOn, statusOf, type VersionFacts } from './rate-table-status';
import {
  RateRow, RateTable, type FrequencyFactors, type RateRowDocument, type RateRules, type RateTableDocument,
  type RateTestCase,
} from './rate-table.schema';
import { PRODUCT_DATA_REFUSALS } from './product-data.messages';

const SAY = PRODUCT_DATA_REFUSALS;

/** No factor given: only the frequencies the table itself prices are offered (P1b *Isian*). */
export const NO_FACTORS: FrequencyFactors = { monthly: null, quarterly: null, semiannual: null, annual: null };

/** **The product, as its table is read against it** (`rate-file.ts`). */
export function tableFactsOf(product: { proposalFields?: readonly ProposalField[] | null; currencies?: readonly string[] | null }): TableFacts {
  const calc = calcSettingsOf(product as Record<string, unknown>);
  const planField = (product.proposalFields ?? []).find((f) => f.plan && f.type !== 'money');
  return {
    calcType: calc.calcType,
    currencies: (product.currencies?.length ? [...product.currencies] : ['IDR']) as ProductCurrency[],
    smokerRated: calc.smokerRated,
    plans: planField ? planField.options.map((o) => o.label) : [],
    payTerms: calc.payTerms.map(({ key, label, years, toAge, single, maxEntryAge }) => ({ key, label, years, toAge, single, maxEntryAge })),
    entryAge: calc.entryAge,
  };
}

/** **The catalogue's own rules** (P1b: *"with no table, the product's own catalogue values apply"*) as a version's. */
export function catalogueRulesOf(product: Record<string, unknown>): RateRules {
  const calc = calcSettingsOf(product);
  const payTermMaxAge: Record<string, number> = {};
  for (const term of calc.payTerms) if (term.maxEntryAge !== null) payTermMaxAge[term.key] = term.maxEntryAge;
  return {
    upStep: calc.upStep, upMin: calc.upMin, upMax: calc.upMax, premiumMin: calc.premiumMin, premiumMax: calc.premiumMax,
    entryAgeMin: calc.entryAge?.min ?? null, entryAgeMax: calc.entryAge?.max ?? null, payTermMaxAge,
  };
}

/** One person who did something, by name. */
export interface Actor { id: string; name: string | null }

/** **A version, as the Proposal tab reads it** (`functional/proposal.md`, *Proposal data per insurer*). */
export interface RateTableView {
  id: string;
  productId: string;
  version: number;
  status: RateTableStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  source: { fileName: string; type: RateTableSource };
  uploadedAt: string;
  uploadedBy: Actor;
  activatedAt: string | null;
  activatedBy: Actor | null;
  turnedOffAt: string | null;
  turnedOffBy: Actor | null;
  basis: string | null;
  mapped: boolean;
  rowCount: number;
  gaps: RateTableDocument['gaps'];
  gapCount: number;
  testCases: RateTestCase[];
  overrideReason: string | null;
  rules: RateRules;
  frequencies: FrequencyFactors;
  rulesSource: string;
  rulesConfirmed: boolean;
  used: boolean;
  /** A draft's file: the columns and how they were matched, the first rows, *Ketentuan*'s unreadable rows. */
  file: {
    header: string[];
    columnMap: Record<string, RateColumnRole>;
    preview: string[][];
    rows: number;
    ketentuan: boolean;
    ketentuanProblems: { row: number; label: string; value: string }[];
  } | null;
  /** What the rules and factors replace — old → new: the version in force, else the catalogue's. */
  previous: { rules: RateRules; frequencies: FrequencyFactors; from: 'version' | 'catalogue'; version: number | null };
}

/** What a draft's write may change, each checked. */
export interface DraftPatch {
  columnMap?: Record<string, string>;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  rules?: Record<string, unknown>;
  frequencies?: Record<string, unknown>;
}

/** One of *Uji 3 contoh*'s profiles as typed. */
export interface TestInput {
  age: number;
  gender: 'male' | 'female';
  smoker?: boolean | null;
  plan?: string | null;
  payTerm?: string | null;
  payFrequency: ProposalPayFrequency;
  amountMinor: number;
  expectedMinor: number;
}

/**
 * **Premium tables, by version** (P19.15-T1 AC-1 to AC-4; ADR-0258; the P1b spec's *Tabel premi*). Company data: every
 * read and write names the company, and finds the product and the version **within it** — another company's is `404`.
 * The access check (`ProductDataAccess`) is the controller's, before any of this.
 *
 * 1. **Upload** (Excel or CSV) with *Berlaku mulai* and an optional *Berlaku sampai*: a draft, the columns suggested.
 * 2. **Cocokkan kolom**: the columns confirmed, the rows read under them — or every unreadable cell answered — and the
 *    gaps worked out.
 * 3. **Ketentuan**: the rules read from the file's sheet, shown old → new, saved by a person.
 * 4. **Uji 3 contoh**, then **activation**: all three within Rp1, or a written reason.
 *
 * An activated version is never edited; turning one off returns the product to the one before it, or to typing; one no
 * proposal used may be deleted. Every write is audited, `rate_table.*`, with what changed.
 */
@Injectable()
export class RateTableService {
  constructor(
    @InjectModel(RateTable.name) private readonly tables: Model<RateTableDocument>,
    @InjectModel(RateRow.name) private readonly rows: Model<RateRowDocument>,
    @InjectModel(Product.name) private readonly products: Model<ProductDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** **Today in Asia/Jakarta** — the one calendar v1 has (ADR-0016) — from the Clock port. */
  today(): string {
    return this.clock.localDateFor(DEFAULT_TENANT_TIMEZONE);
  }

  // ------------------------------------------------------------------------------------------------ reads

  /** **A product's live versions**, newest first, without their files. */
  async versionsOf(companyId: string, productId: string): Promise<RateTableDocument[]> {
    return this.tables.find({ companyId, productId, deletedAt: null }).select('-raw').sort({ version: -1 }).exec();
  }

  /** **Every live version of a company's products**, without files — the Proposal tab's one read. */
  async versionsOfCompany(companyId: string): Promise<RateTableDocument[]> {
    return this.tables.find({ companyId, deletedAt: null }).select('-raw').sort({ version: -1 }).exec();
  }

  /** **The version in force for a product on `onDate`** (`YYYY-MM-DD`, Asia/Jakarta), or `null`. */
  async inForce(productId: string, onDate: string): Promise<RateTableDocument | null> {
    if (!isValidObjectId(productId)) return null;
    const versions = await this.tables.find({ productId, deletedAt: null }).select('-raw').exec();
    return inForceOn(versions.map(factsOf), onDate)?.doc ?? null;
  }

  /** **A version's state on `today`**, among its product's versions. */
  statusOf(table: RateTableDocument, today: string, siblings: readonly RateTableDocument[] = [table]): RateTableStatus {
    return statusOf(factsOf(table), today, siblings.map(factsOf));
  }

  /** **One version, as the tab reads it**, with its draft's file. */
  async read(companyId: string, tableId: string): Promise<RateTableView> {
    const table = await this.tableOf(companyId, tableId, true);
    return this.view(table);
  }

  /** **The views of versions**, each person named, each state worked out against its product's versions. */
  async views(tables: readonly RateTableDocument[], siblings: readonly RateTableDocument[]): Promise<RateTableView[]> {
    const names = await this.namesOf(tables.flatMap((t) => [t.uploadedBy, t.activatedBy, t.turnedOffBy]));
    const product = tables[0] ? await this.products.findOne({ _id: tables[0].productId }).lean().exec() : null;
    const today = this.today();
    return tables.map((t) => this.viewOf(t, today, siblings.filter((s) => s.productId === t.productId), names, product));
  }

  // ------------------------------------------------------------------------------------------------ writes

  /**
   * **An Excel or CSV premium table, uploaded as a draft** (step 1; AC-1). The file is read — a workbook's *Data* sheet
   * (or its first that is not *Ketentuan*) and its *Ketentuan* sheet; a CSV as UTF-8 or Windows-1252, its delimiter from
   * the header — and kept with the draft, the columns suggested. A PDF is not read here: it goes through *Unggah file*
   * (D3, ADR-0259), which turns it into a grid first.
   */
  async upload(
    ctx: RequestContext, companyId: string, productId: string, file: FileUpload | undefined,
    dates: { effectiveFrom?: string; effectiveTo?: string | null },
  ): Promise<RateTableView> {
    const product = await this.productOf(companyId, productId);
    if (!file || file.size === 0) throw new InvalidRequestException(SAY.VALIDATION_FAILED.noFile, { field: 'file' });
    const { effectiveFrom, effectiveTo } = checkedDates(dates.effectiveFrom, dates.effectiveTo ?? null);
    const { raw, type } = await readTable(file);
    const facts = tableFactsOf(product.toObject());
    const base = await this.baseRules(companyId, productId, product);
    const read = raw.ketentuan ? rulesFromKetentuan(raw.ketentuan, facts) : null;
    const rules: RateRules = read ? { ...base.rules, ...read.rules } : base.rules;
    const frequencies: FrequencyFactors = read ? { ...base.frequencies, ...read.frequencies } : base.frequencies;
    const fromFile = read !== null && (Object.keys(read.rules).length > 0 || Object.keys(read.frequencies).length > 0);

    const created = await this.tables.create({
      companyId,
      productId,
      version: await this.nextVersion(productId),
      effectiveFrom,
      effectiveTo,
      source: { fileName: file.originalname.slice(0, PRODUCT_DATA.FILE_NAME_MAX), type, assetKey: null, intakeItemId: null },
      uploadedBy: ctx.auditActors.actorUserId,
      uploadedAt: this.clock.now(),
      columnMap: suggestMapping(raw.header),
      raw,
      rules,
      frequencies,
      rulesSource: fromFile ? 'ketentuan' : base.from === 'version' ? 'previous' : 'catalogue',
      rulesConfirmed: !fromFile,
      productFingerprint: fingerprintOf(facts),
      updatedBy: ctx.auditActors.actorUserId,
    });
    await this.record(ctx, 'rate_table.uploaded', created, null, {
      productId, version: created.version, fileName: created.source.fileName, rows: raw.rows.length, effectiveFrom,
      effectiveTo, ketentuan: raw.ketentuan !== null,
    });
    return this.view(created);
  }

  /**
   * **A draft made from rows already read** (D3's *Unggah file*, ADR-0259): the rows exactly as the confirmed intake card
   * holds them, its rules and factors, its dates and its source. The draft then meets the same gap check, three test
   * profiles and activation as an upload. Its columns are confirmed by the intake's own questions, so it is `mapped`.
   */
  async createDraft(ctx: RequestContext, input: {
    companyId: string; productId: string; rows: readonly EngineRow[]; frequencies: Partial<FrequencyFactors> | null;
    rules: Partial<RateRules> | null; effectiveFrom: string; effectiveTo: string | null;
    source: { fileName: string; type: RateTableSource; assetKey: string | null; intakeItemId: string | null };
  }): Promise<{ rateTableId: string }> {
    const product = await this.productOf(input.companyId, input.productId);
    const { effectiveFrom, effectiveTo } = checkedDates(input.effectiveFrom, input.effectiveTo);
    const facts = tableFactsOf(product.toObject());
    const base = await this.baseRules(input.companyId, input.productId, product);
    const rules = checkedRules({ ...base.rules, ...(input.rules ?? {}) });
    const frequencies = checkedFactors({ ...base.frequencies, ...(input.frequencies ?? {}) });
    const { gaps, count } = gapsOf(input.rows, facts, rules);
    const created = await this.tables.create({
      companyId: input.companyId,
      productId: input.productId,
      version: await this.nextVersion(input.productId),
      effectiveFrom,
      effectiveTo,
      source: { ...input.source, fileName: input.source.fileName.slice(0, PRODUCT_DATA.FILE_NAME_MAX) },
      uploadedBy: ctx.auditActors.actorUserId,
      uploadedAt: this.clock.now(),
      columnMap: {},
      mappedAt: this.clock.now(),
      basis: input.rows[0]?.basis ?? null,
      rowCount: input.rows.length,
      gaps,
      gapCount: count,
      rules,
      frequencies,
      rulesSource: input.rules ? 'intake' : base.from === 'version' ? 'previous' : 'catalogue',
      rulesConfirmed: true,
      productFingerprint: fingerprintOf(facts),
      updatedBy: ctx.auditActors.actorUserId,
    });
    await this.writeRows(String(created._id), input.rows);
    await this.record(ctx, 'rate_table.uploaded', created, null, {
      productId: input.productId, version: created.version, fileName: created.source.fileName, rows: input.rows.length,
      effectiveFrom, effectiveTo, intakeItemId: input.source.intakeItemId,
    });
    return { rateTableId: String(created._id) };
  }

  /**
   * **A draft's columns, dates, rules or factors** (steps 2 and 3; AC-1, AC-4). New columns read the rows again from
   * the file kept with the draft — every unreadable cell refused at once, `422 RATE_TABLE_ROWS_INVALID`, nothing written
   * — then the gaps. Rules and factors saved are confirmed. Any change runs the test profiles again.
   */
  async update(ctx: RequestContext, companyId: string, tableId: string, patch: DraftPatch): Promise<RateTableView> {
    const table = await this.draftOf(companyId, tableId);
    const product = await this.productOf(companyId, table.productId);
    const facts = tableFactsOf(product.toObject());
    const set: Record<string, unknown> = {};
    const before: Record<string, unknown> = {};

    if (patch.effectiveFrom !== undefined || patch.effectiveTo !== undefined) {
      const dates = checkedDates(patch.effectiveFrom ?? table.effectiveFrom, patch.effectiveTo === undefined ? table.effectiveTo : patch.effectiveTo);
      Object.assign(set, dates);
      Object.assign(before, { effectiveFrom: table.effectiveFrom, effectiveTo: table.effectiveTo });
    }
    let rules = table.rules;
    if (patch.rules !== undefined) {
      rules = checkedRules(patch.rules);
      set.rules = rules;
      set.rulesConfirmed = true;
      if (table.rulesSource !== 'ketentuan') set.rulesSource = 'typed';
      before.rules = table.rules;
    }
    if (patch.frequencies !== undefined) {
      set.frequencies = checkedFactors(patch.frequencies);
      set.rulesConfirmed = true;
      before.frequencies = table.frequencies;
    }
    let rows: EngineRow[] | null = null;
    if (patch.columnMap !== undefined) {
      if (!table.raw) throw new InvalidRequestException(SAY.VALIDATION_FAILED.rateColumn, { field: 'columnMap' });
      const map = checkedMap(table.raw.header, patch.columnMap);
      const read = rowsFromRaw(table.raw, map, facts);
      if (read.problemCount > 0) {
        throw new DomainException(
          ErrorCode.RATE_TABLE_ROWS_INVALID, SAY.RATE_TABLE_ROWS_INVALID.problems({ count: read.problemCount }),
          HttpStatus.UNPROCESSABLE_ENTITY, { problems: read.problems, count: read.problemCount },
        );
      }
      rows = read.rows;
      Object.assign(set, { columnMap: map, mappedAt: this.clock.now(), basis: basisOf(map), rowCount: rows.length });
      before.columnMap = table.columnMap;
    }
    if (Object.keys(set).length === 0) throw new InvalidRequestException(SAY.VALIDATION_FAILED.rule({ field: 'body' }));

    if (rows !== null) await this.writeRows(tableId, rows);
    if (rows !== null || patch.rules !== undefined) {
      const all = rows ?? (await this.rows.find({ rateTableId: tableId, deletedAt: null }).lean().exec()).map(engineRowOf);
      const { gaps, count } = gapsOf(all, facts, rules);
      Object.assign(set, { gaps, gapCount: count });
    }
    set.productFingerprint = fingerprintOf(facts);
    set.updatedBy = ctx.auditActors.actorUserId;
    const updated = await this.tables.findOneAndUpdate(
      { _id: tableId, companyId, activatedAt: null, deletedAt: null }, { $set: set }, { new: true },
    ).exec();
    if (!updated) throw new NotFoundException('Premium table');
    const tested = updated.testCases.length > 0 ? await this.retest(updated, updated.testCases.map(inputOf)) : updated;
    const after = Object.fromEntries(Object.keys(before).map((key) => [key, set[key]]));
    await this.record(ctx, 'rate_table.updated', tested, before, { ...after, ...(rows ? { rows: rows.length } : {}) });
    return this.view(tested);
  }

  /** **Uji 3 contoh** (step 4; AC-2): exactly three profiles typed from the illustration, each calculated beside it. */
  async setTests(ctx: RequestContext, companyId: string, tableId: string, cases: readonly TestInput[]): Promise<RateTableView> {
    const table = await this.draftOf(companyId, tableId);
    if (cases.length !== PRODUCT_DATA.TEST_PROFILES) {
      throw new InvalidRequestException(SAY.VALIDATION_FAILED.tests({ max: PRODUCT_DATA.TEST_PROFILES }), { field: 'cases' });
    }
    const tested = await this.retest(table, cases.map((c, i) => checkedTest(c, i)));
    await this.record(ctx, 'rate_table.tested', tested, null, {
      matches: tested.testCases.filter((c) => c.match).length, of: tested.testCases.length,
    });
    return this.view(tested);
  }

  /**
   * **Activation** (AC-2, AC-3): a draft whose columns are confirmed, with rows, its rules seen, and the three profiles
   * matching within Rp1 — or a written reason. From then on it is never edited; it is in force from its *Berlaku mulai*.
   */
  async activate(ctx: RequestContext, companyId: string, tableId: string, reason: string | null): Promise<RateTableView> {
    const table = await this.draftOf(companyId, tableId);
    const notReady = refuse;
    if (!table.mappedAt) notReady(SAY.RATE_TABLE_NOT_READY.unmapped, { reason: 'unmapped' });
    if (table.rowCount === 0) notReady(SAY.RATE_TABLE_NOT_READY.noRows, { reason: 'no_rows' });
    if (!table.rulesConfirmed) notReady(SAY.RATE_TABLE_NOT_READY.rules, { reason: 'rules' });
    const written = reason?.trim() ?? '';
    if (written.length > PRODUCT_DATA.OVERRIDE_REASON_MAX) {
      throw new InvalidRequestException(SAY.VALIDATION_FAILED.reason({ max: PRODUCT_DATA.OVERRIDE_REASON_MAX }), { field: 'overrideReason' });
    }
    const allMatch = table.testCases.length === PRODUCT_DATA.TEST_PROFILES && table.testCases.every((c) => c.match);
    if (!allMatch && written === '') {
      notReady(SAY.RATE_TABLE_NOT_READY.tests({ max: PRODUCT_DATA.TEST_PROFILES }), { reason: 'tests', tests: table.testCases });
    }
    const product = await this.productOf(companyId, table.productId);
    const activated = await this.tables.findOneAndUpdate(
      { _id: tableId, companyId, activatedAt: null, deletedAt: null },
      {
        $set: {
          activatedAt: this.clock.now(), activatedBy: ctx.auditActors.actorUserId, overrideReason: allMatch ? null : written,
          raw: null, productFingerprint: fingerprintOf(tableFactsOf(product.toObject())), updatedBy: ctx.auditActors.actorUserId,
        },
      },
      { new: true },
    ).exec();
    if (!activated) throw new NotFoundException('Premium table');
    await this.point(companyId, table.productId);
    await this.record(ctx, 'rate_table.activated', activated, null, {
      productId: table.productId, version: activated.version, effectiveFrom: activated.effectiveFrom,
      effectiveTo: activated.effectiveTo, testsMatched: allMatch, overrideReason: activated.overrideReason,
    });
    return this.view(activated);
  }

  /**
   * **Turning a version off** (AC-3; P1b *Undo*): the product goes back to the version before it where that one's dates
   * still cover today, else to *Ketik manual*. Saved proposals keep their numbers; a draft re-opened is recalculated.
   */
  async turnOff(ctx: RequestContext, companyId: string, tableId: string): Promise<RateTableView> {
    const table = await this.tableOf(companyId, tableId);
    if (table.activatedAt === null) {
      throw new DomainException(ErrorCode.RATE_TABLE_NOT_EDITABLE, SAY.RATE_TABLE_NOT_EDITABLE.notActivated, HttpStatus.CONFLICT, { status: 'draft' });
    }
    if (table.turnedOffAt !== null) {
      throw new DomainException(ErrorCode.RATE_TABLE_NOT_EDITABLE, SAY.RATE_TABLE_NOT_EDITABLE.alreadyOff, HttpStatus.CONFLICT, { status: 'off' });
    }
    const before = this.statusOf(table, this.today(), await this.versionsOf(companyId, table.productId));
    const off = await this.tables.findOneAndUpdate(
      { _id: tableId, companyId, turnedOffAt: null, deletedAt: null },
      { $set: { turnedOffAt: this.clock.now(), turnedOffBy: ctx.auditActors.actorUserId, updatedBy: ctx.auditActors.actorUserId } },
      { new: true },
    ).exec();
    if (!off) throw new NotFoundException('Premium table');
    await this.point(companyId, table.productId);
    await this.record(ctx, 'rate_table.turned_off', off, { status: before }, { status: 'off', productId: table.productId, version: off.version });
    return this.view(off);
  }

  /** **Deleting a version no proposal used** (AC-3): a draft, or one activated and never calculated with. Soft. */
  async remove(ctx: RequestContext, companyId: string, tableId: string): Promise<void> {
    const table = await this.tableOf(companyId, tableId);
    if (table.firstUsedAt !== null) {
      throw new DomainException(ErrorCode.RATE_TABLE_IN_USE, SAY.RATE_TABLE_IN_USE.used, HttpStatus.CONFLICT);
    }
    const now = this.clock.now();
    const by = ctx.auditActors.actorUserId;
    const gone = await this.tables.findOneAndUpdate(
      { _id: tableId, companyId, firstUsedAt: null, deletedAt: null }, { $set: { deletedAt: now, deletedBy: by, raw: null } }, { new: true },
    ).exec();
    if (!gone) throw new DomainException(ErrorCode.RATE_TABLE_IN_USE, SAY.RATE_TABLE_IN_USE.used, HttpStatus.CONFLICT);
    await this.rows.updateMany({ rateTableId: tableId, deletedAt: null }, { $set: { deletedAt: now } }).exec();
    await this.point(companyId, table.productId);
    await this.record(ctx, 'rate_table.deleted', gone, null, { productId: table.productId, version: gone.version });
  }

  /**
   * **The product's template** (P1b: *"a downloadable CSV template per product (columns already named)"*): as Excel, a
   * *Data* sheet with the product's own columns — each header's note naming what it takes — and a *Ketentuan* sheet
   * filled with the rules in force (else the catalogue's), to change where the insurer did; as CSV, the *Data* header.
   */
  async template(companyId: string, productId: string, format: 'xlsx' | 'csv'): Promise<{ fileName: string; contentType: string; bytes: Buffer }> {
    const product = await this.productOf(companyId, productId);
    const facts = tableFactsOf(product.toObject());
    const header = templateHeader(facts);
    const base = `Tabel-premi-${product.code}`;
    if (format === 'csv') {
      return { fileName: `${base}.csv`, contentType: 'text/csv; charset=utf-8', bytes: Buffer.from(`﻿${header.join(',')}\r\n`, 'utf8') };
    }
    const { rules, frequencies } = await this.baseRules(companyId, productId, product);
    const workbook = new Workbook();
    workbook.creator = 'AgencyBoost';
    const data = workbook.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1 }] });
    data.columns = header.map((name) => ({ header: name, width: Math.max(14, name.length + 4), style: { numFmt: '@' } }));
    const notes: Record<string, string> = {
      Usia: 'Usia ulang tahun berikutnya: satu angka (45) atau rentang (61-65).',
      'Jenis kelamin': 'L atau P. Kosong: untuk keduanya.',
      Merokok: 'Ya atau Tidak.',
      Plan: `Salah satu: ${facts.plans.join(', ')}.`,
      'Masa bayar': `Salah satu: ${facts.payTerms.map((t) => t.label).join(', ')}.`,
      'Mata uang': `Salah satu: ${facts.currencies.join(', ')}.`,
      'Tarif per 1.000 UP': 'Tarif tahunan per Rp1.000 uang pertanggungan, persis seperti di tabel resmi (misal 12,35).',
      'Premi tahunan': 'Premi tahunan dalam rupiah, persis seperti di tabel resmi.',
    };
    data.getRow(1).font = { bold: true };
    data.getRow(1).eachCell((cell) => { const note = notes[String(cell.value)]; if (note) cell.note = note; });
    const sheet = workbook.addWorksheet(PRODUCT_DATA.KETENTUAN_SHEET);
    sheet.columns = [{ width: 36 }, { width: 22, style: { numFmt: '@' } }];
    for (const row of ketentuanRows(facts, rules, frequencies)) sheet.addRow(row);
    sheet.getRow(1).font = { bold: true };
    return { fileName: `${base}.xlsx`, contentType: XLSX_MIME_TYPE, bytes: Buffer.from(await workbook.xlsx.writeBuffer()) };
  }

  // ------------------------------------------------------------------------------------------------ internals

  /** **What a new version's rules start from, and what they replace**: the version in force, else the catalogue's. */
  async baseRules(companyId: string, productId: string, product: ProductDocument | Record<string, unknown>) {
    const current = await this.inForce(productId, this.today());
    if (current && current.companyId === companyId) {
      return { rules: current.rules, frequencies: current.frequencies, from: 'version' as const, version: current.version };
    }
    const plain = 'toObject' in product && typeof product.toObject === 'function' ? product.toObject() : product;
    return { rules: catalogueRulesOf(plain as Record<string, unknown>), frequencies: NO_FACTORS, from: 'catalogue' as const, version: null };
  }

  /** The three profiles calculated again with the draft as it is now — the same engine as the card (AC-7). */
  private async retest(table: RateTableDocument, inputs: readonly RateTestCase['inputs'][] | readonly (RateTestCase['inputs'] & { expectedMinor: number })[]): Promise<RateTableDocument> {
    const product = await this.products.findOne({ _id: table.productId, companyId: table.companyId }).lean().exec();
    const calcType = product ? calcSettingsOf(product as unknown as Record<string, unknown>).calcType : 'manual';
    const currency = ((product?.currencies?.length ? product.currencies[0] : 'IDR') as ProductCurrency);
    const payTerms = product ? calcSettingsOf(product as unknown as Record<string, unknown>).payTerms : [];
    const expected = table.testCases.map((c) => c.expectedMinor);
    const testCases: RateTestCase[] = [];
    for (const [i, input] of inputs.entries()) {
      const rows = (await this.rows.find({ rateTableId: String(table._id), deletedAt: null, age: { $in: [input.age, null] } }).lean().exec())
        .map(engineRowOf);
      const result = calculate({ rows, rules: table.rules, frequencies: table.frequencies, ageRated: true }, {
        calcType,
        profile: { age: input.age, gender: input.gender, smoker: input.smoker, plan: input.plan, payTerm: input.payTerm, currency },
        payFrequency: input.payFrequency,
        singlePayTerm: payTerms.find((t) => t.key === input.payTerm)?.single ?? false,
        fixed: calcType === 'up_premium' ? 'up' : calcType === 'goal' ? 'goal' : calcType === 'premium_benefit' ? 'premium' : 'none',
        up: calcType === 'up_premium' ? input.amountMinor : null,
        premium: calcType === 'premium_benefit' ? input.amountMinor : null,
        goal: calcType === 'goal' ? input.amountMinor : null,
      });
      const actualMinor = result.state !== 'ok' ? null : calcType === 'premium_benefit' ? result.up : result.premium;
      const expectedMinor = 'expectedMinor' in input ? (input as { expectedMinor: number }).expectedMinor : expected[i];
      testCases.push({
        inputs: {
          age: input.age, gender: input.gender, smoker: input.smoker, plan: input.plan, payTerm: input.payTerm,
          payFrequency: input.payFrequency, amountMinor: input.amountMinor,
        },
        expectedMinor,
        actualMinor,
        match: withinTolerance(actualMinor, expectedMinor, currency),
      });
    }
    const saved = await this.tables.findOneAndUpdate(
      { _id: table._id, activatedAt: null, deletedAt: null }, { $set: { testCases } }, { new: true },
    ).exec();
    if (!saved) throw new NotFoundException('Premium table');
    return saved;
  }

  /** **The product's pointer** (ADR-0258 §2): the latest activated version not off — a record, never what decides. */
  private async point(companyId: string, productId: string): Promise<void> {
    const latest = await this.tables
      .findOne({ companyId, productId, deletedAt: null, activatedAt: { $ne: null }, turnedOffAt: null })
      .sort({ effectiveFrom: -1, version: -1 }).select('_id').lean().exec();
    await this.products.updateOne({ _id: productId, companyId }, { $set: { rateTableId: latest ? String(latest._id) : null } }).exec();
  }

  /** A draft's rows, the earlier ones soft-deleted (invariant §6). */
  private async writeRows(tableId: string, rows: readonly EngineRow[]): Promise<void> {
    await this.rows.updateMany({ rateTableId: tableId, deletedAt: null }, { $set: { deletedAt: this.clock.now() } }).exec();
    for (let i = 0; i < rows.length; i += 1000) {
      await this.rows.insertMany(rows.slice(i, i + 1000).map((row) => ({ ...row, rateTableId: tableId, deletedAt: null })));
    }
  }

  private async nextVersion(productId: string): Promise<number> {
    const last = await this.tables.findOne({ productId }).sort({ version: -1 }).select('version').lean().exec();
    return (last?.version ?? 0) + 1;
  }

  /** A live product of the company, or `404`. */
  async productOf(companyId: string, productId: string): Promise<ProductDocument> {
    if (!isValidObjectId(productId)) throw new NotFoundException('Product');
    const product = await this.products.findOne({ _id: productId, companyId, deletedAt: null }).exec();
    if (!product) throw new NotFoundException('Product');
    return product;
  }

  /** A live version of the company, or `404`. */
  private async tableOf(companyId: string, tableId: string, withFile = false): Promise<RateTableDocument> {
    if (!isValidObjectId(tableId)) throw new NotFoundException('Premium table');
    const query = this.tables.findOne({ _id: tableId, companyId, deletedAt: null });
    const table = await (withFile ? query : query.select('-raw')).exec();
    if (!table) throw new NotFoundException('Premium table');
    return table;
  }

  /** A draft, with its file — or `409 RATE_TABLE_NOT_EDITABLE` for a version already activated. */
  private async draftOf(companyId: string, tableId: string): Promise<RateTableDocument> {
    const table = await this.tableOf(companyId, tableId, true);
    if (table.activatedAt !== null) {
      const status = this.statusOf(table, this.today(), await this.versionsOf(companyId, table.productId));
      throw new DomainException(
        ErrorCode.RATE_TABLE_NOT_EDITABLE, SAY.RATE_TABLE_NOT_EDITABLE.notDraft({ status }), HttpStatus.CONFLICT, { status },
      );
    }
    return table;
  }

  private async view(table: RateTableDocument): Promise<RateTableView> {
    const siblings = await this.versionsOf(table.companyId, table.productId);
    return (await this.views([table], siblings))[0];
  }

  private viewOf(
    t: RateTableDocument, today: string, siblings: readonly RateTableDocument[], names: Map<string, string | null>,
    product: Record<string, unknown> | null,
  ): RateTableView {
    const actor = (id: string | null): Actor | null => (id ? { id, name: names.get(id) ?? null } : null);
    const facts = product ? tableFactsOf(product as never) : null;
    const inForce = inForceOn(siblings.filter((s) => String(s._id) !== String(t._id)).map(factsOf), today)?.doc ?? null;
    const raw = t.activatedAt === null ? t.raw : null;
    return {
      id: String(t._id),
      productId: t.productId,
      version: t.version,
      status: this.statusOf(t, today, siblings.some((s) => String(s._id) === String(t._id)) ? siblings : [...siblings, t]),
      effectiveFrom: t.effectiveFrom,
      effectiveTo: t.effectiveTo,
      source: { fileName: t.source.fileName, type: t.source.type },
      uploadedAt: t.uploadedAt.toISOString(),
      uploadedBy: actor(t.uploadedBy)!,
      activatedAt: t.activatedAt?.toISOString() ?? null,
      activatedBy: actor(t.activatedBy),
      turnedOffAt: t.turnedOffAt?.toISOString() ?? null,
      turnedOffBy: actor(t.turnedOffBy),
      basis: t.basis,
      mapped: t.mappedAt !== null,
      rowCount: t.rowCount,
      gaps: t.gaps,
      gapCount: t.gapCount,
      testCases: t.testCases,
      overrideReason: t.overrideReason,
      rules: t.rules,
      frequencies: t.frequencies,
      rulesSource: t.rulesSource,
      rulesConfirmed: t.rulesConfirmed,
      used: t.firstUsedAt !== null,
      file: raw ? {
        header: raw.header,
        columnMap: t.columnMap,
        preview: raw.rows.slice(0, PRODUCT_DATA.PREVIEW_ROWS),
        rows: raw.rows.length,
        ketentuan: raw.ketentuan !== null,
        ketentuanProblems: raw.ketentuan && facts ? rulesFromKetentuan(raw.ketentuan, facts).problems : [],
      } : null,
      previous: inForce
        ? { rules: inForce.rules, frequencies: inForce.frequencies, from: 'version', version: inForce.version }
        : { rules: product ? catalogueRulesOf(product) : t.rules, frequencies: NO_FACTORS, from: 'catalogue', version: null },
    };
  }

  private async namesOf(ids: readonly (string | null)[]): Promise<Map<string, string | null>> {
    const valid = [...new Set(ids.filter((id): id is string => !!id && isValidObjectId(id)))];
    const rows = valid.length
      ? await this.users.find({ _id: { $in: valid.map((id) => new Types.ObjectId(id)) } }).select('fullName').lean().exec()
      : [];
    return new Map(rows.map((u) => [String(u._id), (u as { fullName?: string }).fullName ?? null]));
  }

  private async record(
    ctx: RequestContext, action: string, table: RateTableDocument, before: Record<string, unknown> | null,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.recordForCompany(ctx, {
      action, targetCollection: 'rateTables', targetId: String(table._id),
      // `companyId` and `productId` on both sides: *Perubahan oleh pengelola* (ADR-0260 §6) reads them from the entry.
      before: before ? { companyId: table.companyId, productId: table.productId, ...before } : null,
      after: { companyId: table.companyId, productId: table.productId, ...after },
    });
  }
}

/** A version's facts for the status rules, carrying the document. */
function factsOf(t: RateTableDocument): VersionFacts & { doc: RateTableDocument } {
  return {
    id: String(t._id), version: t.version, effectiveFrom: t.effectiveFrom, effectiveTo: t.effectiveTo,
    activatedAt: t.activatedAt, turnedOffAt: t.turnedOffAt, deletedAt: t.deletedAt, doc: t,
  };
}

function refuse(sentence: Sentence<'RATE_TABLE_NOT_READY'>, details: Record<string, unknown>): never {
  throw new DomainException(ErrorCode.RATE_TABLE_NOT_READY, sentence, HttpStatus.UNPROCESSABLE_ENTITY, details);
}

/** **The file, read as a table** (step 1): Excel by its signature, a PDF refused to *Unggah file*, anything else CSV. */
async function readTable(file: FileUpload): Promise<{ raw: RawTable; type: RateTableSource }> {
  const bytes = new Uint8Array(file.buffer);
  const malformed = notATableOf;
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const pdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  if (pdf) throw malformed(SAY.UPLOAD_MALFORMED_CSV.notATable);
  let raw: RawTable | null;
  let type: RateTableSource;
  if (zip) {
    raw = rawFromSheets(await readWorkbookSheets(bytes));
    type = 'xlsx';
  } else {
    const { text } = decodeText(bytes);
    const records = parseCsv(text, delimiterOf(text));
    raw = rawFromRows(records.map((r) => r.cells), records.map((r) => r.line));
    type = 'csv';
  }
  if (!raw || raw.header.every((h) => h === '')) throw malformed(SAY.UPLOAD_MALFORMED_CSV.noHeader);
  if (raw.rows.length > PRODUCT_DATA.ROWS_MAX) throw malformed(SAY.UPLOAD_MALFORMED_CSV.tooManyRows({ max: PRODUCT_DATA.ROWS_MAX }));
  return { raw, type };
}

function notATableOf(sentence: Sentence<'UPLOAD_MALFORMED_CSV'>): DomainException {
  return new DomainException(ErrorCode.UPLOAD_MALFORMED_CSV, sentence, HttpStatus.UNPROCESSABLE_ENTITY);
}

/** *Berlaku mulai* and *Berlaku sampai*: days, in order. */
export function checkedDates(from: unknown, to: unknown): { effectiveFrom: string; effectiveTo: string | null } {
  if (!isLocalDate(from)) throw new InvalidRequestException(SAY.VALIDATION_FAILED.dateShape({ field: 'effectiveFrom' }), { field: 'effectiveFrom' });
  const end = to === undefined || to === null || to === '' ? null : to;
  if (end !== null && !isLocalDate(end)) throw new InvalidRequestException(SAY.VALIDATION_FAILED.dateShape({ field: 'effectiveTo' }), { field: 'effectiveTo' });
  if (end !== null && end < from) throw new InvalidRequestException(SAY.VALIDATION_FAILED.dateOrder, { field: 'effectiveTo' });
  return { effectiveFrom: from, effectiveTo: end };
}

/** A mapping as the file's columns allow it, or `400` naming what is wrong. */
function checkedMap(header: readonly string[], map: Record<string, string>): Record<string, RateColumnRole> {
  const fault = mappingFault(header, map);
  if (fault) {
    const sentence = fault.kind === 'columnUnknown' ? SAY.VALIDATION_FAILED.columnUnknown({ column: fault.column })
      : fault.kind === 'roleTwice' ? SAY.VALIDATION_FAILED.roleTwice({ role: fault.role })
        : fault.kind === 'bandColumns' ? SAY.VALIDATION_FAILED.bandColumns
          : fault.kind === 'role' ? SAY.VALIDATION_FAILED.rule({ field: `columnMap.${fault.column}` })
            : SAY.VALIDATION_FAILED.rateColumn;
    throw new InvalidRequestException(sentence, { field: 'columnMap', ...fault });
  }
  const full: Record<string, RateColumnRole> = {};
  for (const column of header) full[column] = (map[column] as RateColumnRole | undefined) ?? 'ignore';
  return full;
}

const wholeOrNull = (value: unknown, field: string, min: number, max: number): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InvalidRequestException(SAY.VALIDATION_FAILED.rule({ field }), { field });
  }
  return value;
};

/** **A version's rules**, each a whole amount or age or `null`, each minimum no larger than its maximum. */
export function checkedRules(input: Record<string, unknown>): RateRules {
  const money = 1_000_000_000_000_000;
  const rules: RateRules = {
    upStep: wholeOrNull(input.upStep, 'rules.upStep', 1, money),
    upMin: wholeOrNull(input.upMin, 'rules.upMin', 0, money),
    upMax: wholeOrNull(input.upMax, 'rules.upMax', 0, money),
    premiumMin: wholeOrNull(input.premiumMin, 'rules.premiumMin', 0, money),
    premiumMax: wholeOrNull(input.premiumMax, 'rules.premiumMax', 0, money),
    entryAgeMin: wholeOrNull(input.entryAgeMin, 'rules.entryAgeMin', 0, 120),
    entryAgeMax: wholeOrNull(input.entryAgeMax, 'rules.entryAgeMax', 0, 120),
    payTermMaxAge: {},
  };
  const terms = input.payTermMaxAge ?? {};
  if (typeof terms !== 'object' || terms === null || Array.isArray(terms)) {
    throw new InvalidRequestException(SAY.VALIDATION_FAILED.rule({ field: 'rules.payTermMaxAge' }), { field: 'rules.payTermMaxAge' });
  }
  for (const [key, age] of Object.entries(terms)) {
    const value = wholeOrNull(age, `rules.payTermMaxAge.${key}`, 0, 120);
    if (value !== null) rules.payTermMaxAge[key] = value;
  }
  for (const [min, max] of [['upMin', 'upMax'], ['premiumMin', 'premiumMax'], ['entryAgeMin', 'entryAgeMax']] as const) {
    if (rules[min] !== null && rules[max] !== null && rules[min]! > rules[max]!) {
      throw new InvalidRequestException(SAY.VALIDATION_FAILED.ruleOrder({ field: `rules.${min}` }), { field: `rules.${min}` });
    }
  }
  return rules;
}

/** **The *Cara bayar* factors**, each above zero and at most `FACTOR_MAX`, or `null`. */
export function checkedFactors(input: Record<string, unknown>): FrequencyFactors {
  const out = { ...NO_FACTORS };
  for (const key of ['monthly', 'quarterly', 'semiannual', 'annual'] as const) {
    const value = input[key];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > PRODUCT_DATA.FACTOR_MAX) {
      throw new InvalidRequestException(SAY.VALIDATION_FAILED.rule({ field: `frequencies.${key}` }), { field: `frequencies.${key}` });
    }
    out[key] = Math.round(value * 1e6) / 1e6;
  }
  return out;
}

/** One test profile as typed, checked. */
function checkedTest(input: TestInput, i: number): RateTestCase['inputs'] & { expectedMinor: number } {
  const at = (field: string) => `cases[${i}].${field}`;
  const bad = (field: string): never => { throw new InvalidRequestException(SAY.VALIDATION_FAILED.testShape({ field: at(field) }), { field: at(field) }); };
  if (!Number.isInteger(input.age) || input.age < 0 || input.age > 120) bad('age');
  if (input.gender !== 'male' && input.gender !== 'female') bad('gender');
  if (!(PROPOSAL_PAY_FREQUENCIES as readonly string[]).includes(input.payFrequency)) bad('payFrequency');
  if (!Number.isInteger(input.amountMinor) || input.amountMinor < 0) bad('amountMinor');
  if (!Number.isInteger(input.expectedMinor) || input.expectedMinor < 0) bad('expectedMinor');
  return {
    age: input.age, gender: input.gender, smoker: input.smoker ?? null, plan: input.plan ?? null, payTerm: input.payTerm ?? null,
    payFrequency: input.payFrequency, amountMinor: input.amountMinor, expectedMinor: input.expectedMinor,
  };
}

/** A stored profile's inputs with its expected premium, to run again. */
function inputOf(c: RateTestCase): RateTestCase['inputs'] & { expectedMinor: number } {
  return { ...c.inputs, expectedMinor: c.expectedMinor };
}
