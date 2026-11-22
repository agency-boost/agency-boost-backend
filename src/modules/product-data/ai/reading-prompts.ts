import type { CatalogueEntry, FileReadingInput, IllustrationReadingInput } from './reader.port';

/**
 * **What Claude is told** (P19.15-T2, T3; ADR-0259 §3). Stable text first — the hard rules never change between calls —
 * and the request's own facts (the catalogue, today, the file) after it. The words a person reads (`summary`, a
 * question's `text` and `choices`) are asked for in plain Indonesian; everything else is data.
 *
 * The rules here are **also enforced in code** (`intake-numbers.ts`, `intake-understanding.ts`, `illustration-check.ts`):
 * the prompt makes a good answer likely, and the code makes a bad one harmless.
 */

const HARD_RULES = `
HARD RULES FOR SENSITIVE NUMBERS (premiums, rates, sums assured "UP", limits, ages, factors):
1. Take a number ONLY exactly as it is written in the file. Never estimate, interpolate, extrapolate, round, recalculate,
   convert, or copy a number from another product, plan, age, gender, row or insurer. If a number is not in the file, it
   is missing: say so in "gaps", never fill it in.
2. For every number give "asWritten" (the characters exactly as the file shows them, including separators and words such
   as "jt" or "M") and "value" (the same number as plain digits with "." as the decimal mark and no grouping marks).
   "value" must be a pure re-writing of "asWritten", never a calculation.
3. Mark "certain": false for any number you did not read with full certainty: a photo, a scan, a blurred or cut digit,
   handwriting, merged or shifted cells, a value whose row or column you are not sure of. Never guess the digit.
4. A message such as "premi naik 5%" is NOT a new table. Report it as ONE item of kind "percent_change" with the
   percentage as written and its direction. Never apply it to any number yourself.
5. Never decide the company, the product or the effective date when the file does not say it clearly. Set "clear": false
   and add a question instead. Match a product only to the catalogue given (by name, code or syariah name; "PRU Cerah" is
   "PRUCerah"); a name not in the catalogue gets id null and kind "new_product" if it reads as a product.
6. Anything unclear becomes a question, in plain Indonesian, short. Examples:
   - "File ini untuk produk apa?" (kind "product", choices = the likely catalogue product names)
   - "Kolom 'Rate A' ini tarif laki-laki atau perempuan?" (kind "column", choices ["Laki-laki", "Perempuan", "Abaikan kolom ini"])
   - "Tanggal berlaku tidak ditemukan. Mulai kapan?" (kind "date", no choices)
   - "Produk 'PRU New X' tidak ada di katalog: produk baru, nama baru dari produk lama, atau abaikan?" (kind "unknown_product")
   - "Angka di baris usia 47 tidak terbaca jelas di foto. Ketik angkanya." (kind "type_number")
`.trim();

const ITEM_GUIDE = `
WHAT TO RETURN: one item per product and kind of update you find. Kinds:
- "premium_table": a premium/rate table. Fill "table": the columns and what each means (age at next birthday, gender,
  smoker, plan, pay term, rate, band min/max), the basis ("per_mille" = rate per Rp1.000 UP, "per_plan" = a fixed premium
  per plan, "per_band" = a premium per UP band) and the currency. For a SPREADSHEET or CSV (text given as a grid with
  "row | COL=value" lines) give only the sheet, headerRow, firstRow, lastRow and the column letters with their meaning:
  leave "rows" EMPTY, our code reads the cells itself. For a PDF, a picture or a Word file transcribe every row in "rows",
  each cell by its column, each value as written with its certainty. A rate column for one gender, smoker status, plan or
  pay term carries it in "gender", "smoker", "plan" or "payTermKey". List every combination the table does not have in
  "gaps" in plain Indonesian ("Usia 61–65 tidak ada di tabel").
- "product_rules": UP step, UP min/max, premium min/max, entry age min/max, a pay term's maximum entry age, frequency
  factors (monthly/quarterly/semiannual against annual). One "changes" entry per value, key from the allowed list.
- "field_change": the product's name, smoker rating, allowed payment frequencies, an option added to or removed from a
  field. One "changes" entry each.
- "illustration": an official benefit illustration of a product (we condense it separately; just identify the product,
  plan and date).
- "new_product": a product that is not in the catalogue. Put its name in "newProductName".
- "withdrawn_product": a product the file says is withdrawn or no longer sold.
- "percent_change": a percentage change of premiums or rates; fill "percent".
Dates are "YYYY-MM-DD" in "date" only when the file states the day clearly; otherwise null with "clear": false.
"source" says where: the PDF page (1-based), the sheet and the cell or cell range, and a short quote.
"summary" is one short Indonesian line a Super Admin reads, e.g. "Tabel premi baru PRUCerah, berlaku 1 Des 2026".
Return no items for a file that holds nothing of these (a brochure's marketing text) and say why in "notes".
`.trim();

function catalogueText(catalogue: readonly CatalogueEntry[]): string {
  if (catalogue.length === 0) return '(the catalogue is empty)';
  return catalogue.map((p) => {
    const terms = p.payTerms.length ? ` | pay terms: ${p.payTerms.map((t) => `${t.key}="${t.label}"`).join(', ')}` : '';
    const syariah = p.syariahName ? ` | syariah name: ${p.syariahName}` : '';
    return `- id ${p.id} | company ${p.companyId} | code ${p.code} | ${p.name}${syariah} | ${p.category} | ${p.lifecycle}${terms}`;
  }).join('\n');
}

export const FILE_SYSTEM_PROMPT = [
  'You read files that an insurance office in Indonesia received from an insurer (premium tables, product rules, official '
    + 'illustrations, brochures, photos or screenshots of messages) and report what they change in our product catalogue. '
    + 'A person confirms every item before anything is applied; your job is to report exactly what the file says and to '
    + 'ask about anything it does not say clearly.',
  HARD_RULES,
  ITEM_GUIDE,
].join('\n\n');

/** The request's own facts, after the stable rules: the company, the catalogue, today, and the file's name. */
export function fileInstruction(input: Omit<FileReadingInput, 'file'> & { fileName: string }): string {
  const company = input.company
    ? `The upload is for the company ${input.company.name} (id ${input.company.id}). Use that id for every item.`
    : `The company is NOT known: the file must say it. Companies: ${input.companies.map((c) => `${c.name} (id ${c.id})`).join(', ')}. `
      + 'When the file does not name one clearly, set company.clear false and ask (kind "company").';
  return [
    company,
    `Today is ${input.today} (Asia/Jakarta).`,
    `The catalogue:\n${catalogueText(input.catalogue)}`,
    `The file is "${input.fileName}". Read it and return the items.`,
  ].join('\n\n');
}

export const ILLUSTRATION_SYSTEM_PROMPT = [
  'You condense an insurer\'s official benefit illustration (Indonesian) into the short detail blocks of a one-page '
    + 'client proposal, for a reader aged 50+. Plain, short Indonesian. A person checks and edits every block before it '
    + 'is published.',
  HARD_RULES,
  `
THE BLOCKS (each row has the page it comes from):
- "manfaat" (Manfaat utama): 3 to 6 main benefits, each with its amount as a FORMULA, e.g. label "Meninggal dunia",
  formula "100% × up".
- "jadwal": for products that pay out over time, one row per year or school stage ("SD", "SMP", "SMA", "Kuliah") with its
  payout as a formula, e.g. "25% × target_dana".
- "masa": waiting period and coverage period, one short line each, as text (formula null).
- "pengecualian" (Yang tidak ditanggung): the 3 most important exclusions in plain words, as text.
- "nilai_tunai": up to 3 sample years of cash value, each a formula if the illustration shows it as a share of an input,
  otherwise leave it out. It is always "tidak dijamin".
EVERY AMOUNT IS A FORMULA of the agent's inputs, never a number copied from this one client's illustration. A formula
uses only these names: the product's inputs listed below, numbers, "%", "×", "/", "+", "-" and brackets. Write "up" for
the sum assured.
CHECKING: for each formula row give up to 2 "evidence" entries: an amount PRINTED in the illustration ("printed", as
written) and the illustration's own input values it was computed from ("inputs", e.g. name "up", value "Rp500.000.000").
List the illustration's sample inputs (the UP, the target fund…) in "sampleInputs". Do not compute anything: we evaluate
your formula against the printed amounts ourselves and flag any that do not match.
DROP: legal boilerplate, fund descriptions, repeated tables, agent-only notes; say briefly what you dropped in "dropped".
`.trim(),
].join('\n\n');

export function illustrationInstruction(input: Omit<IllustrationReadingInput, 'file'> & { fileName: string }): string {
  const p = input.product;
  return [
    `The product is ${p.name} (id ${p.id}, code ${p.code}, ${p.category}). Plan: ${input.plan ?? 'not given'}.`,
    `The formula names allowed for this product: ${p.formulaNames.length ? p.formulaNames.join(', ') : '(none: write every row as text)'}.`,
    `Today is ${input.today} (Asia/Jakarta). The illustration's date is the one printed on it.`,
    `The file is "${input.fileName}". Condense it.`,
  ].join('\n\n');
}
