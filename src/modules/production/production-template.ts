import type { Language } from '@/domain/constants';
import type { AdvancedAnalyticsConfig, UploadField } from '@/modules/config/analytics-config';
import { PRODUCTION_METRICS, type ProductionMetric } from './monthly-agent-data.schema';
import { cellKey } from './upload-columns';

/**
 * The file's own words for the six metrics (`KPM_Owner.html:4681`), verbatim.
 *
 * *Rp M* stays in the label because the file is for the person filling it in, and they think in
 * millions. What is *stored* is minor units — `production-units.ts` is where the two meet.
 */
export const METRIC_FILE_LABEL: Record<ProductionMetric, string> = {
  ape: 'APE (Rp M)',
  persistency: 'Rolling Persistency (%)',
  recruitment: 'Recruitment',
  newActiveAgents: 'New Active Agents',
  fyp: 'FYP (Rp M)',
  policyCount: '# of Policy',
};

/**
 * **The leader rows' column, in the file's words** (P19.3-T1; ADR-0201 §2, the data sources' D6): `UNIT_PERSISTENCY`, the
 * insurer's persistency for a leader's unit, a percentage. Apart from the six above because it has **one cadence**, this
 * month's — no year to date — and is filled on AB and AAB rows only. *Unit Persistency (%)*, as *Rolling Persistency (%)*
 * is written beside it.
 */
export const UNIT_PERSISTENCY_FILE_LABEL = 'Unit Persistency (%)';

/**
 * The header row is the contract, and the contract is the version.
 *
 * **Monthly columns first, then the same six as YTD** — the prototype's own order
 * (`KPM_Owner.html:4683`: *"one file covers both cadences instead of needing a separate annual
 * upload"*). The separator is the prototype's em dash (`:4687-4688`), so a file produced by either
 * side carries the same fourteen cells.
 *
 * **There is no version line in the file.** One would be possible — the roster template carried
 * comment lines until ADR-0184, and its importer still skips them — but a line is something an operator deletes and a
 * spreadsheet moves, and what an importer needs to know is whether the columns are the ones it
 * expects. The header says that by itself. So a file is identified by its **header cells, compared
 * one by one after the file has been decoded and parsed**, and a header nobody issued is
 * `UPLOAD_TEMPLATE_MISMATCH`. What the importer forgives on the way there — a byte-order mark, a
 * delimiter, a dash a spreadsheet re-encoded — is ADR-0052, and P9-T3 builds it. Changing a label is
 * a new version, never an edit to this one.
 */
export const TEMPLATE_HEADER_V1: readonly string[] = [
  'Agent Code',
  'Agent Name',
  ...PRODUCTION_METRICS.map((m) => `${METRIC_FILE_LABEL[m]} — This Month`),
  ...PRODUCTION_METRICS.map((m) => `${METRIC_FILE_LABEL[m]} — YTD`),
];

/**
 * **Version 2, since P19.3-T1** (ADR-0201 §2, D6): version 1's fourteen columns, unchanged and in their order, then **one
 * more at the end** — *Unit Persistency (%) — This Month*, the leader rows' own figure. Added last so a file filled in
 * against version 1 is still version 1, read exactly as before (ADR-0051), and nothing in version 1 moves.
 */
export const TEMPLATE_HEADER_V2: readonly string[] = [
  ...TEMPLATE_HEADER_V1,
  `${UNIT_PERSISTENCY_FILE_LABEL} — This Month`,
];

/**
 * **Every header this product issued before P19.5-T2, by version** — no longer the contract (ADR-0214 §5, amending
 * ADR-0052): a file is matched column by column against the KPM's template, and each of these headers' cells is an
 * alias of its kode (`issuedAliases` in `analytics-config.ts`), so a file filled in against version 1 or 2 still imports.
 * Kept for the specs that build such a file.
 */
export const TEMPLATE_HEADERS: Readonly<Record<number, readonly string[]>> = {
  1: TEMPLATE_HEADER_V1,
  2: TEMPLATE_HEADER_V2,
};

// ------------------------------------------------------------------------------- the template's own header

/** A column's unit as its header writes it: *Rp juta* (EN *Rp M*), *%*, nothing for a count (ADR-0214 §5). */
export function unitLabel(unit: UploadField['unit'], language: Language): string | null {
  if (unit === 'rp_million') return language === 'id' ? 'Rp juta' : 'Rp M';
  if (unit === 'percent') return '%';
  return null;
}

/** A column's name in the reader's language; the ID label stands in for an empty EN one (ADR-0214 §2). */
export const labelIn = (field: Pick<UploadField, 'label'>, language: Language): string =>
  (language === 'en' && field.label.en.trim() !== '' ? field.label.en : field.label.id).trim();

/**
 * **One column of the KPM's template, as the file's header** (P19.5-T2 AC-1; ADR-0214 §5): `<label> (<unit>) [KODE]`
 * for the month, and `<label> YTD [KODE_YTD]` for a `ytd: 'upload'` column's year to date.
 */
export function headerOf(field: UploadField, ytd: boolean, language: Language): string {
  const label = labelIn(field, language);
  if (ytd) return `${label} YTD [${cellKey(field.kode, true)}]`;
  const unit = unitLabel(field.unit, language);
  return `${label}${unit ? ` (${unit})` : ''} [${field.kode}]`;
}

/** The columns a file holds, in its order: each current column's month, then each `ytd: 'upload'` column's YTD. */
export function fileColumns(config: AdvancedAnalyticsConfig): { field: UploadField; ytd: boolean }[] {
  return [
    ...config.uploadFields.map((field) => ({ field, ytd: false })),
    ...config.uploadFields.filter((f) => f.ytd === 'upload').map((field) => ({ field, ytd: true })),
  ];
}

/**
 * **The template's header** (P19.5-T2 AC-1, AT-14): `Agent Code`, `Agent Name`, then `fileColumns` — the same for every
 * KPM on the template, at every moment, since every one reads it live. The YTD switch on screen never changes it.
 */
export function templateHeader(config: AdvancedAnalyticsConfig, language: Language): string[] {
  return ['Agent Code', 'Agent Name', ...fileColumns(config).map(({ field, ytd }) => headerOf(field, ytd, language))];
}

/**
 * One CSV field, RFC 4180: quoted when it holds a comma, a quote or a line break, and a quote
 * inside it is doubled.
 *
 * **The agent code goes through here untouched.** It is the importer's only join key, so what is
 * written is exactly what is stored — nothing is prefixed, padded or rewritten on the way out.
 */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** What a spreadsheet reads as the start of a formula (OWASP, *CSV injection*). */
const FORMULA_LEAD = /^[=+\-@]/;

/**
 * A member's name, as one quoted field that a spreadsheet will read as text.
 *
 * **Always quoted**, as the prototype has it (`KPM_Owner.html:4714`), so the column reads as one
 * kind of thing. **A quote inside is doubled**, which the prototype does not do: it writes
 * `"${name}"` and escapes nothing, which is malformed CSV for any conforming reader — a spreadsheet,
 * or the parser P9-T3 builds — even though its own `split(',')` happens to tolerate it.
 *
 * **One line.** A line break inside a quoted field is legal CSV, and it splits one agent across two
 * lines for every reader that counts them.
 *
 * **Never a formula.** A name is whatever its owner typed on their profile, and this file is opened
 * in a spreadsheet by somebody else. Quoting does not help — the spreadsheet unquotes the field and
 * then evaluates it — so a name that starts like a formula gets a leading apostrophe, which a
 * spreadsheet reads as *this is text*. Safe for the round trip because the name column is read and
 * never matched on; the agent code is the key, and it is left alone.
 */
export function csvName(value: string): string {
  const oneLine = value.replace(/\s*[\r\n\t]+\s*/g, ' ').trim();
  const inert = FORMULA_LEAD.test(oneLine) ? `'${oneLine}` : oneLine;
  return `"${inert.replace(/"/g, '""')}"`;
}

/**
 * **`<kpmCode>-agent-data-<YYYY-MM>.csv`** (P19.5-T2 AC-1; the Advanced analytics spec §4, *Agent code*) — or `.xlsx`.
 * It replaced the prototype's `KPM0417-agent-data-Sep-2026.csv`.
 *
 * **Not the version.** A filename is the first thing an operator changes, and a check that trusted
 * it would refuse a good file for being renamed.
 */
export function templateFilename(officeCode: string, month: string, extension: 'csv' | 'xlsx' = 'csv'): string {
  return `${officeCode}-agent-data-${month}.${extension}`;
}

/** One row per agent: the code as stored, the name as text, and an empty field for each of the header's value columns. */
export function templateBody(header: readonly string[], rows: readonly { agentCode: string; name: string }[]): string {
  const blanks = header.length - 2;
  const lines = [
    header.map(csvField).join(','),
    ...rows.map((r) => [csvField(r.agentCode), csvName(r.name), ...Array<string>(blanks).fill('')].join(',')),
  ];
  // `\n`, as the prototype writes it (`KPM_Owner.html:4717`). A spreadsheet saves `\r\n`; reading
  // both is the importer's.
  return lines.join('\n');
}
