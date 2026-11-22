import { z } from 'zod';
import {
  INTAKE_FIELD_KEYS, INTAKE_ITEM_KINDS, INTAKE_QUESTION_KINDS, INTAKE_RULE_KEYS, PDF_DETAIL_BLOCKS,
} from '@/domain/constants';

/**
 * **What Claude answers, as a schema** (P19.15-T2, T3; ADR-0259 §3, §6): sent as the request's structured output
 * (`output_config.format`), so the answer is JSON of exactly this shape, and parsed again here before a byte of it is
 * stored. Plain on purpose — objects, strings, enums, booleans, integers and `null` — so the schema needs none of what
 * structured outputs do not support.
 *
 * **Every number is a pair**: `asWritten`, the text the file shows, and `value`, the plain digits the model reads it as.
 * Nothing downstream trusts `value` alone: `intake-numbers.ts` keeps it only when it is an exact reading of `asWritten`.
 */

/** Where in the file: a PDF's page, a sheet and a cell, and the words quoted. */
export const sourceSchema = z.object({
  page: z.number().int().nullable(),
  sheet: z.string().nullable(),
  cell: z.string().nullable(),
  quote: z.string().nullable(),
});

/** A figure: the text as written, the plain reading of it, and whether it was read with full certainty. */
export const figureSchema = z.object({
  asWritten: z.string(),
  value: z.string().nullable(),
  certain: z.boolean(),
});

/** A company or a product as the file names it, the catalogue id it matches (or `null`), and whether the match is clear. */
export const namedSchema = z.object({
  asWritten: z.string(),
  id: z.string().nullable(),
  clear: z.boolean(),
});

export const daySchema = z.object({
  asWritten: z.string().nullable(),
  date: z.string().nullable(),
  clear: z.boolean(),
});

export const changeSchema = z.object({
  key: z.enum([...INTAKE_RULE_KEYS, ...INTAKE_FIELD_KEYS]),
  /** For `payTermMaxAge`: the pay term's key in the catalogue. */
  payTermKey: z.string().nullable(),
  /** For `frequencyFactor`: which frequency, against the annual premium. */
  frequency: z.enum(['monthly', 'quarterly', 'semiannual']).nullable(),
  /** For `optionAdded` / `optionRemoved`: the field's key in the catalogue. */
  fieldKey: z.string().nullable(),
  label: z.string(),
  value: figureSchema,
  source: sourceSchema,
});

export const columnSchema = z.object({
  column: z.string(),
  header: z.string(),
  meaning: z.enum(['age', 'gender', 'smoker', 'plan', 'pay_term', 'rate', 'band_min', 'band_max', 'ignore', 'unclear']),
  gender: z.enum(['male', 'female']).nullable(),
  smoker: z.boolean().nullable(),
  plan: z.string().nullable(),
  payTermKey: z.string().nullable(),
  clear: z.boolean(),
  question: z.string().nullable(),
});

export const tableRowSchema = z.object({
  source: sourceSchema,
  cells: z.array(z.object({ column: z.string(), value: figureSchema })),
});

export const tableSchema = z.object({
  sheet: z.string().nullable(),
  headerRow: z.number().int().nullable(),
  firstRow: z.number().int().nullable(),
  lastRow: z.number().int().nullable(),
  basis: z.enum(['per_mille', 'per_plan', 'per_band', 'unclear']),
  currency: z.enum(['IDR', 'USD', 'unclear']),
  columns: z.array(columnSchema),
  /** Transcribed rows, for a PDF, a picture or a Word file only; a workbook's and a CSV's are read by our own code. */
  rows: z.array(tableRowSchema),
  gaps: z.array(z.string()),
});

export const questionSchema = z.object({
  kind: z.enum(INTAKE_QUESTION_KINDS),
  text: z.string(),
  choices: z.array(z.string()),
});

export const itemSchema = z.object({
  kind: z.enum(INTAKE_ITEM_KINDS),
  summary: z.string(),
  company: namedSchema.nullable(),
  products: z.array(namedSchema),
  effectiveFrom: daySchema,
  effectiveTo: daySchema,
  source: sourceSchema,
  changes: z.array(changeSchema),
  table: tableSchema.nullable(),
  percent: z.object({ asWritten: z.string(), direction: z.enum(['up', 'down']), appliesTo: z.string() }).nullable(),
  newProductName: z.string().nullable(),
  questions: z.array(questionSchema),
});

export const fileReadingSchema = z.object({
  items: z.array(itemSchema),
  notes: z.string().nullable(),
});

export type FileReading = z.infer<typeof fileReadingSchema>;
export type ReadItem = z.infer<typeof itemSchema>;
export type ReadTable = z.infer<typeof tableSchema>;
export type ReadColumn = z.infer<typeof columnSchema>;
export type ReadFigure = z.infer<typeof figureSchema>;
export type ReadSource = z.infer<typeof sourceSchema>;

// ------------------------------------------------------------------------------------------------ the illustration

export const evidenceSchema = z.object({
  page: z.number().int().nullable(),
  printed: figureSchema,
  inputs: z.array(z.object({ name: z.string(), value: figureSchema })),
});

export const illustrationRowSchema = z.object({
  label: z.string(),
  note: z.string().nullable(),
  formula: z.string().nullable(),
  text: z.string().nullable(),
  page: z.number().int().nullable(),
  evidence: z.array(evidenceSchema),
});

export const illustrationReadingSchema = z.object({
  product: namedSchema,
  plan: z.string().nullable(),
  illustrationDate: daySchema,
  sampleInputs: z.array(z.object({ name: z.string(), value: figureSchema, page: z.number().int().nullable() })),
  blocks: z.array(z.object({
    block: z.enum(PDF_DETAIL_BLOCKS),
    page: z.number().int().nullable(),
    rows: z.array(illustrationRowSchema),
  })),
  dropped: z.array(z.string()),
});

export type IllustrationReading = z.infer<typeof illustrationReadingSchema>;
export type IllustrationRowReading = z.infer<typeof illustrationRowSchema>;
export type EvidenceReading = z.infer<typeof evidenceSchema>;
