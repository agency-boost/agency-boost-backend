import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { Asset, AssetSchema } from '@/modules/assets/asset.schema';
import type { StoragePort } from '@/modules/assets/storage.port';
import { CompanyTemplate, CompanyTemplateSchema } from '@/modules/config/company-template.schema';
import { LessonFilesError, loadLessonSet } from '@/modules/config/lesson-files';
import { importLessons, type LessonImportReport } from '@/modules/config/lesson-import';
import { NamedTemplate, NamedTemplateSchema } from '@/modules/config/named-template.schema';
import { Company, CompanySchema } from '@/modules/tenants/company.schema';

/**
 * **The owner's 23 lessons in the demo's templates** (P19.6-T3 AC-2: *"The demo seed does the same"*; ADR-0208 §1,
 * ADR-0217): the operator's import (`importLessons`), run on **Prudential** and on the **Template company** (the
 * platform's *Default template*), each through a new published version of its template's *Training*.
 *
 * - **The folder is the superproject's** `revisions/2026-11-03/files/training-modules`, beside this repository on a
 *   laptop, or `SEED_LESSONS_DIR`. The lessons are never copied into this repository or its image: a run without the
 *   folder — the staging seed's tools image, a CI checkout of the backend alone — skips them and says so, and staging
 *   gets them the way production does, by the operator's `import-lessons.sh`.
 * - **The demo's modules are not production's**: the ten Sales modules the platform's defaults hold carry codes of our
 *   own, so they take their lessons by `DEMO_LESSON_MAP` (Sales's five lessons, by subject). A module titled as a lesson
 *   — production's names, P19.6-T4 — takes it by its title.
 * - **No KPM is written**, as the operator's import writes none: 0417 and 0555 are listed by *Dipakai N KPM* as given an
 *   older version, and a KPM made from the template at `/admin/tenants/new` has the lessons on day one (UI-162).
 * - **A re-run writes nothing**: the import's own rule (AC-2).
 */

/** Sales's five lessons for the ten Sales modules the platform's defaults hold, by subject. */
export const DEMO_LESSON_MAP: Readonly<Record<string, number>> = {
  PROSPECT_LIST: 1,
  REFERRAL_GENERATION: 1,
  COLD_APPROACH_SCRIPTS: 2,
  FINANCIAL_NEEDS_ANALYSIS: 3,
  DISCOVERY_QUESTIONS: 3,
  OBJECTION_FUNDAMENTALS: 4,
  CLOSING_TECHNIQUES: 4,
  PRICE_OBJECTIONS: 4,
  CROSS_SELL_OPPORTUNITIES: 5,
  CLIENT_RETENTION: 5,
};

/** The lessons' folder in the superproject, beside this repository: where a laptop has it. */
export const SUPERPROJECT_LESSONS_DIR = resolve(__dirname, '../../../revisions/2026-11-03/files/training-modules');

/** The folder the command seeds from: `SEED_LESSONS_DIR`, else the superproject's where it exists, else none. */
export function lessonsFolderFrom(env: NodeJS.ProcessEnv): string | null {
  const named = env.SEED_LESSONS_DIR?.trim();
  if (named) return named;
  return existsSync(SUPERPROJECT_LESSONS_DIR) ? SUPERPROJECT_LESSONS_DIR : null;
}

/** Who the versions name. */
export const SEED_LESSONS_ACTOR = 'seed:demo';

export interface LessonsFixtureDeps {
  clock: Clock;
  storage: StoragePort | null;
  /** The lessons' folder, or `null`: skipped. */
  folder: string | null;
  /** Prudential's id. */
  prudential: string;
}

export interface LessonsFixture {
  state: 'stored' | `skipped: ${string}`;
  /** Per company: its slug and the import's report. */
  companies: { slug: string; report: LessonImportReport }[];
  /** Modules attached, versions published and files sent, across the companies: 0 on a re-run. */
  attached: number;
  published: number;
  sent: number;
  guide: string;
}

const RECOMPILE = { overwriteModels: true } as const;

export async function seedLessonsFixture(deps: LessonsFixtureDeps): Promise<LessonsFixture> {
  const skipped = (why: string): LessonsFixture => ({
    state: `skipped: ${why}`, companies: [], attached: 0, published: 0, sent: 0,
    guide: `\n  LESSONS  the owner's 23 lessons were skipped: ${why}\n`,
  });
  if (!deps.folder) return skipped('no lessons folder (SEED_LESSONS_DIR, or the superproject\'s revisions/2026-11-03/files/training-modules)');
  if (!deps.storage) return skipped('storage is not configured');
  let set;
  try {
    set = loadLessonSet(deps.folder);
  } catch (err) {
    if (err instanceof LessonFilesError) return skipped(err.message);
    throw err;
  }

  const Companies = mongoose.model(Company.name, CompanySchema, undefined, RECOMPILE);
  const models = {
    namedTemplates: mongoose.model(NamedTemplate.name, NamedTemplateSchema, undefined, RECOMPILE),
    companyTemplates: mongoose.model(CompanyTemplate.name, CompanyTemplateSchema, undefined, RECOMPILE),
    assets: mongoose.model(Asset.name, AssetSchema, undefined, RECOMPILE),
  };
  const library = await Companies.findOne({ kind: 'template', deletedAt: null }).lean().exec();
  const targets = [
    { id: deps.prudential, slug: 'prudential' },
    ...(library ? [{ id: String(library._id), slug: library.slug }] : []),
  ];
  const companies: LessonsFixture['companies'] = [];
  for (const target of targets) {
    const report = await importLessons(
      { ...models, storage: deps.storage, clock: deps.clock, actor: SEED_LESSONS_ACTOR },
      target.id, set, { byCode: DEMO_LESSON_MAP },
    );
    companies.push({ slug: target.slug, report });
  }
  const sum = (key: 'attached' | 'published' | 'sent') => companies.reduce((n, c) => n + c.report[key], 0);
  const withLessons = (slug: string) => {
    const report = companies.find((c) => c.slug === slug)?.report;
    const modules = report?.templates.flatMap((t) => t.modules).filter((m) => m.lesson !== null) ?? [];
    return `${new Set(modules.map((m) => m.code)).size} module(s)`;
  };
  const guide = `
  LESSONS  the owner's 23 lessons (P19.6-T3, src/seed/lessons-fixture.ts), first in each module with the A4 PDF beside it
    superadmin@agencyboost.test  /admin/companies/{Prudential} > its template > Training: ${withLessons('prudential')} carry a
                                 lesson; Materi (n) > Buka opens it in the sandboxed frame. "Dipakai N KPM" lists 0417 and
                                 0555 as given an older version: push to 0417 and rina@kpm0417.test opens the lesson at
                                 /training/SALES/PROSPECT_LIST. A KPM made at /admin/tenants/new has them on day one
    ${library ? `The Template company's Default template: ${withLessons(library.slug)} carry a lesson\n` : ''}`;
  return { state: 'stored', companies, attached: sum('attached'), published: sum('published'), sent: sum('sent'), guide };
}
