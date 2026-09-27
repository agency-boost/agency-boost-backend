import { PRODUCTION_METRICS, type ProductionMetric } from './monthly-agent-data.schema';

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
 * The header row is the contract, and the contract is the version.
 *
 * **Monthly columns first, then the same six as YTD** — the prototype's own order
 * (`KPM_Owner.html:4683`: *"one file covers both cadences instead of needing a separate annual
 * upload"*). The separator is the prototype's em dash (`:4687-4688`), so a file produced by either
 * side carries the same fourteen cells.
 *
 * **There is no version line in the file.** One would be possible — the roster template carries
 * comment lines and its importer skips them — but a line is something an operator deletes and a
 * spreadsheet moves, and what an importer needs to know is whether the columns are the ones it
 * expects. The header says that by itself. So a file is identified by its **header cells, compared
 * one by one after the file has been decoded and parsed**, and a header nobody issued is
 * `UPLOAD_TEMPLATE_MISMATCH`. What the importer forgives on the way there — a byte-order mark, a
 * delimiter, a dash a spreadsheet re-encoded — is OD-75, and P9-T3's to build. Changing a label is
 * a new version, never an edit to this one.
 */
export const TEMPLATE_VERSION = 1;

export const TEMPLATE_HEADER_V1: readonly string[] = [
  'Agent Code',
  'Agent Name',
  ...PRODUCTION_METRICS.map((m) => `${METRIC_FILE_LABEL[m]} — This Month`),
  ...PRODUCTION_METRICS.map((m) => `${METRIC_FILE_LABEL[m]} — YTD`),
];

/** Every header this product has ever issued, by version — what P9-T3 matches a file against. */
export const TEMPLATE_HEADERS: Readonly<Record<number, readonly string[]>> = {
  1: TEMPLATE_HEADER_V1,
};

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

const MONTH_ABBREV = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `KPM0417-agent-data-Sep-2026.csv` — the prototype's own name (`KPM_Owner.html:4721`).
 *
 * The `KPM` prefix is the prototype's, kept because the flow doc cites the filename and an operator
 * who has seen the mockup will look for it. Built from a fixed table rather than `Intl`, so the name
 * does not depend on the server's locale.
 *
 * **Not the version.** A filename is the first thing an operator changes, and a check that trusted
 * it would refuse a good file for being renamed.
 */
export function templateFilename(officeCode: string, month: string): string {
  const [year, mm] = month.split('-');
  return `KPM${officeCode}-agent-data-${MONTH_ABBREV[Number(mm) - 1]}-${year}.csv`;
}

/** One row per agent: the code as stored, the name as text, and twelve empty fields. */
export function templateBody(rows: readonly { agentCode: string; name: string }[]): string {
  const blanks = TEMPLATE_HEADER_V1.length - 2;
  const lines = [
    TEMPLATE_HEADER_V1.map(csvField).join(','),
    ...rows.map((r) => [csvField(r.agentCode), csvName(r.name), ...Array<string>(blanks).fill('')].join(',')),
  ];
  // `\n`, as the prototype writes it (`KPM_Owner.html:4717`). A spreadsheet saves `\r\n`; reading
  // both is the importer's.
  return lines.join('\n');
}
