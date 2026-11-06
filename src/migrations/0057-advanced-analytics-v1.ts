import { DateTime } from 'luxon';
import mongoose from 'mongoose';
import { ANALYTICS, DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import {
  analyticsConfigV1, KODE_OF_CELL, prudentialSeedDraft, V1_PATTERN_CANDIDATES,
} from '@/modules/config/analytics-config';
import { compileLinearPattern } from '@/modules/config/linear-pattern';

/** One template given its version 1, as the deploy log reports it (ADR-0214 §7, §9: *"the migration reports it"*). */
export interface AnalyticsV1Report {
  companyId: string;
  templateId: string;
  name: string;
  /** The KPMs that read the template. */
  kpms: number;
  /** The registered agent codes of those KPMs, every one of which the pattern matches. */
  codes: number;
  agentCodePattern: string;
  effectiveFrom: string;
  /** Prudential's §3 seed offered as a draft beside it (OD-266 Q3). */
  prudentialDraft: boolean;
}

/** What one run did. Printed by `run.ts`, so the deploy log is the record of it. */
export interface AdvancedAnalyticsV1Result {
  /** Templates given a published version 1 this run. */
  written: number;
  /** Templates that already held the section — an earlier run's, or made since with one — left alone. */
  current: number;
  /** Prudential drafts written. */
  drafts: number;
  reports: AnalyticsV1Report[];
}

/** The month cells today's rows hold, each as the kode version 1 gives it. */
const LEGACY_CELLS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(KODE_OF_CELL)
    .filter(([cell]) => cell !== 'unitPersistency')
    .flatMap(([cell, kode]) => [[`${cell}Monthly`, kode], [`${cell}Ytd`, kode]])),
  unitPersistencyMonthly: 'UNIT_PERSISTENCY',
};

/**
 * **`advanced-analytics-v1` — every template's *Advanced analytics* version 1, equal to today's upload** (P19.5-T1 AC-3;
 * ADR-0214 §9).
 *
 * For each named template not deleted — archived ones too, whose KPMs still read them — that holds no
 * `advanced_analytics` row yet:
 *
 * - **a published version 1** of today's **seven** columns (`v1UploadFields`: the six of `TEMPLATE_HEADER_V1` and
 *   P19.3-T1's `UNIT_PERSISTENCY`, rows `leaders`), each `required: false` and with its issued headers as aliases, so
 *   **no KPM's upload changes until a Super Admin publishes**; `unknownAgent: 'reject'`, as today's import refuses an
 *   unregistered code; every section on; the spec's surveys and thresholds;
 * - its **agent-code pattern**: the first of `^\d{3,32}$`, `^[A-Za-z0-9-]{1,32}$` and `^.{1,64}$` that **every code
 *   registered** on the template's KPMs already matches (`V1_PATTERN_CANDIDATES`);
 * - its columns' **`effectiveFrom`**: the earliest month any of those KPMs holds a figure for, or this month where none
 *   holds one.
 *
 * **The Prudential template** — the default template of the company named *Prudential* — is also offered the spec's §3
 * seed as a **draft** beside it: `^[0-9]{8}$`, `unknownAgent: 'flag'` and the mockup's required flags. A Super Admin
 * publishes it once its pattern test passes (OD-266 Q3).
 *
 * The KPMs a template answers for are resolved as `AnalyticsConfigReader` resolves them: the template a KPM was made
 * from when it is its company's own, else the company's default.
 *
 * **Idempotent**: a template holding any `advanced_analytics` row is `current`, and a second run writes nothing (a test
 * runs it twice).
 */
export async function up(db: mongoose.mongo.Db, now: Date): Promise<AdvancedAnalyticsV1Result> {
  const named = db.collection('templates');
  const sections = db.collection('companyTemplates');
  const kpms = db.collection('kpms');
  const companies = db.collection('companies');
  const memberships = db.collection('memberships');
  const months = db.collection('monthlyAgentData');
  const result: AdvancedAnalyticsV1Result = { written: 0, current: 0, drafts: 0, reports: [] };
  const thisMonth = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(DEFAULT_TENANT_TIMEZONE).toFormat('yyyy-MM');

  const templates = await named.find({ deletedAt: null }).sort({ _id: 1 }).toArray();
  for (const template of templates) {
    const companyId = String(template.companyId);
    const templateId = String(template._id);
    const kind = { companyId, templateId, kind: 'advanced_analytics', deletedAt: null };
    if (await sections.findOne(kind, { projection: { _id: 1 } })) {
      result.current += 1;
      continue;
    }

    const offices = await officesReading(kpms, named, companyId, templateId);
    const codes = (await memberships.distinct('agentCode', {
      kpmId: { $in: offices }, status: 'active', deletedAt: null,
    }) as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim() !== '').sort();
    const candidates = V1_PATTERN_CANDIDATES.map((c) => {
      const compiled = compileLinearPattern(c.pattern, ANALYTICS.CODE_PATTERN_MAX_LENGTH);
      return { ...c, test: compiled.ok ? compiled.pattern.test : () => false };
    });
    const chosen = candidates.find((c) => codes.every((code) => c.test(code))) ?? candidates[candidates.length - 1];
    const effectiveFrom = (await earliestHeld(months, offices)) ?? thisMonth;
    // An example from the KPMs' own codes, where one is registered: what the field shows as *Contoh yang cocok*.
    const payload = analyticsConfigV1({
      effectiveFrom, agentCodePattern: chosen.pattern, agentCodeExample: codes.find((c) => chosen.test(c)) ?? chosen.example,
    });

    // Timestamps by hand: this insert has no Mongoose in between to stamp it.
    await sections.insertOne({
      ...kind,
      version: 1,
      revision: 1,
      status: 'published',
      payload,
      publishedAt: now,
      migratedFrom: null,
      createdBy: null,
      updatedBy: null,
      createdAt: now,
      updatedAt: now,
    });
    result.written += 1;

    let prudentialDraft = false;
    if (template.isDefault === true) {
      const company = await companies.findOne({ _id: { $in: ids([companyId]) } }, { projection: { name: 1, kind: 1 } });
      if (company && company.kind !== 'template' && /^prudential\b/i.test(String(company.name ?? ''))) {
        await sections.insertOne({
          ...kind,
          version: 2,
          revision: 2,
          status: 'draft',
          payload: prudentialSeedDraft(payload),
          publishedAt: null,
          migratedFrom: null,
          createdBy: null,
          updatedBy: null,
          createdAt: now,
          updatedAt: now,
        });
        result.drafts += 1;
        prudentialDraft = true;
      }
    }

    result.reports.push({
      companyId, templateId, name: String(template.name ?? ''), kpms: offices.length, codes: codes.length,
      agentCodePattern: chosen.pattern, effectiveFrom, prudentialDraft,
    });
  }
  return result;
}

/** The live KPMs whose resolution lands on one template, as `AnalyticsConfigReader.officesReading` resolves them. */
async function officesReading(
  kpms: mongoose.mongo.Collection, named: mongoose.mongo.Collection, companyId: string, templateId: string,
): Promise<string[]> {
  const [offices, templates] = await Promise.all([
    kpms.find({ companyId, deletedAt: null }, { projection: { startedFrom: 1 } }).toArray(),
    named.find({ companyId, deletedAt: null }, { projection: { _id: 1, isDefault: 1 } }).toArray(),
  ]);
  const own = new Set(templates.map((t) => String(t._id)));
  const byDefault = templates.find((t) => t.isDefault === true);
  const fallback = byDefault ? String(byDefault._id) : null;
  return offices.filter((office) => {
    const from = office.startedFrom as { source?: string; templateId?: string | null; companyId?: string } | null | undefined;
    const mine = from?.source === 'template' && from.templateId && (!from.companyId || from.companyId === companyId)
      && own.has(String(from.templateId)) ? String(from.templateId) : fallback;
    return mine === templateId;
  }).map((office) => String(office._id));
}

/** The earliest month any of the offices holds a figure in, or `null`. */
async function earliestHeld(months: mongoose.mongo.Collection, offices: string[]): Promise<string | null> {
  if (offices.length === 0) return null;
  const held = Object.keys(LEGACY_CELLS).map((cell) => ({ [`${cell}.value`]: { $ne: null } }));
  const row = await months
    .find({ kpmId: { $in: offices }, deletedAt: null, $or: held }, { projection: { month: 1 } })
    .sort({ month: 1 })
    .limit(1)
    .toArray();
  return row.length ? String(row[0].month) : null;
}

/** Ids as they may be stored: each as written, and as an ObjectId where it is one's hex. */
function ids(list: readonly string[]): mongoose.Types.ObjectId[] {
  return list.flatMap((id) => (/^[0-9a-f]{24}$/i.test(id)
    ? [id as unknown as mongoose.Types.ObjectId, new mongoose.Types.ObjectId(id)]
    : [id as unknown as mongoose.Types.ObjectId]));
}
