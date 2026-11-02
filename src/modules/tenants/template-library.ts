import type { CompanyKind } from './company.schema';

/**
 * **The Template company** (ADR-0164): the *Template library*, which holds the platform's templates and is
 * not an insurer. Made by migration `0037` in every environment, from the AgencyBoost defaults; a new company
 * copies it, and a new office may start from its Default template.
 *
 * **Its ids are fixed, and the same in every environment**, rather than minted on the run that makes it. The
 * migration writes the company's parts first and the company last, each part keyed on these ids, so a run
 * that stopped part-way is finished by the next one rather than leaving rows under an id nothing names. Each
 * id's timestamp half reads 1970, so no id Mongo mints can ever be one of them.
 */
export const TEMPLATE_LIBRARY = {
  companyId: '000000000000000000000001',
  name: 'Template',
  slug: 'template',
  /** Its one named template, the default (ADR-0164 §1). */
  defaultTemplateId: '000000000000000000000002',
  defaultTemplateName: 'Default template',
} as const;

/**
 * **The insurers, as a filter** (ADR-0164 §3): every company but the Template library. For each list that
 * means *the companies people work for* — registration, the platform overview, platform analytics.
 *
 * `$ne` rather than `kind: 'insurer'`, so a company written before migration `0036` gave it a kind is still
 * an insurer: what it always was.
 */
export const INSURERS_ONLY = { kind: { $ne: 'template' as CompanyKind } };

/** Whether this company is the Template library. Absent is an insurer, as `INSURERS_ONLY` reads it. */
export function isTemplateLibrary(company: { kind?: CompanyKind | null } | null | undefined): boolean {
  return company?.kind === 'template';
}
