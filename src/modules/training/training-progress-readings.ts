import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import type { TrainingStatus } from '@/domain/constants';
import { completionByScope, type TrainingStatuses } from '@/domain/metrics/training-completion';
import { OfferedTraining, type OfferedCatalog } from './offered-training';
import { TrainingProgressRepository } from './training-progress.repository';
import type { TrainingProgressDocument } from './training-progress.schema';
import {
  TrainingCategoryRepository, TrainingModuleRepository, TrainingSkillRepository,
} from './training.repository';
import { asContent } from './training.service';
import type {
  TrainingArchivedModuleView, TrainingCategoryProgressView, TrainingItemKind, TrainingProgressView,
  TrainingSkillProgressView,
} from './training-progress.view';

/** One member's row of one module, as every reader of progress reads it. */
export interface TrainingProgressRow {
  id: string;
  membershipId: string;
  moduleCode: string;
  status: TrainingStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  openedItemIds: string[];
}

/** What the rows are filtered to, beyond the members. */
export interface TrainingRowFilter {
  moduleCodes?: readonly string[];
  status?: TrainingStatus;
}

/**
 * **`TrainingProgressReadings` — the one read of training progress** (P18.2-T2 AC-3): the port T1's learner
 * read, T4's coach read, T3's activation evaluator and Phase 18.3's compliance tree read through, so none of
 * them can disagree about what a member has done.
 *
 * **Bounded for many members** (AC-3): `ofMany` reads the offered catalog once, every member's rows in one
 * query (`$in` over the memberships, within the office), the offered modules' content in one query (for the
 * *Format* column), and — only when somebody holds history — the history's modules, skills and categories in
 * one query each. Never a query per member.
 *
 * **Counts through `TRAINING_COMPLETION_PCT`'s one function** (`domain/metrics/training-completion.ts`), at the
 * catalog, each category and each skill: offered modules only, `done` only, `null` over nothing.
 *
 * **D-history**: a row `done` on a module no longer offered stays on the record and is served under its skill
 * as an `archived` row, outside every count. The learner's list ignores them; the person tab draws them.
 *
 * **Leavers and re-joins** (AC-5): rows are keyed by membership, so a re-joined member's new membership reads
 * nothing done and the old rows stay with the old one. Whose rows to read is the caller's question.
 */
@Injectable()
export class TrainingProgressReadings {
  constructor(
    private readonly rows: TrainingProgressRepository,
    private readonly offered: OfferedTraining,
    private readonly modules: TrainingModuleRepository,
    private readonly skills: TrainingSkillRepository,
    private readonly categories: TrainingCategoryRepository,
  ) {}

  /** The offered catalog (`OfferedTraining`), for a caller that needs it beside the rows. */
  catalog(ctx: RequestContext): Promise<OfferedCatalog> {
    return this.offered.catalog(ctx);
  }

  /** **Many members' rows, in one query**, filtered by module code and status where asked. None for nobody. */
  async rowsOf(
    ctx: RequestContext, membershipIds: readonly string[], filter: TrainingRowFilter = {},
  ): Promise<TrainingProgressRow[]> {
    if (membershipIds.length === 0) return [];
    if (filter.moduleCodes && filter.moduleCodes.length === 0) return [];
    const docs = await this.rows.find(ctx, {
      membershipId: { $in: [...new Set(membershipIds)] },
      ...(filter.moduleCodes ? { moduleCode: { $in: [...new Set(filter.moduleCodes)] } } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    });
    return docs.map(toRow);
  }

  /** **Each member's training, against the offered catalog** — one view per member asked, in one bounded pass. */
  async ofMany(ctx: RequestContext, membershipIds: readonly string[]): Promise<Map<string, TrainingProgressView>> {
    const members = [...new Set(membershipIds)];
    const out = new Map<string, TrainingProgressView>();
    if (members.length === 0) return out;

    const catalog = await this.offered.catalog(ctx);
    const offeredCodes = [...catalog.modules.keys()];
    const [rows, formats] = await Promise.all([
      this.rowsOf(ctx, members),
      this.formatsOf(ctx, offeredCodes),
    ]);

    const byMember = new Map<string, TrainingProgressRow[]>(members.map((m) => [m, []]));
    for (const row of rows) byMember.get(row.membershipId)?.push(row);

    // D-history: a module done and no longer offered. Its labels come from the live rows, read once for everybody.
    const historyCodes = [...new Set(rows
      .filter((row) => row.status === 'done' && !catalog.modules.has(row.moduleCode))
      .map((row) => row.moduleCode))];
    const history = await this.historyPlaces(ctx, historyCodes);

    for (const membershipId of members) {
      out.set(membershipId, compose(membershipId, catalog, formats, byMember.get(membershipId)!, history));
    }
    return out;
  }

  /** One member's training: `ofMany` for one, so the learner's read and the coach's are the same computation. */
  async of(ctx: RequestContext, membershipId: string): Promise<TrainingProgressView> {
    return (await this.ofMany(ctx, [membershipId])).get(membershipId)!;
  }

  /** The kinds each offered module's live content holds (`officeContent ?? companyContent`), in one query. */
  private async formatsOf(ctx: RequestContext, codes: readonly string[]): Promise<Map<string, TrainingItemKind[]>> {
    const out = new Map<string, TrainingItemKind[]>();
    if (codes.length === 0) return out;
    const docs = await this.modules.find(
      ctx, { code: { $in: [...codes] } }, { projection: { code: 1, companyContent: 1, officeContent: 1 } },
    );
    for (const doc of docs) out.set(doc.code, formatsOfContent(doc));
    return out;
  }

  /**
   * Where each module of the history sits now — its title, its skill and its category, read from the live rows, one
   * query per level. **Only an archived module is history** (D-history: *done, and then archived*; the exit review,
   * training review 2): a module set back to draft is neither offered nor withdrawn for good, so a row on it is
   * shown nowhere until the office publishes it again. A module whose place is gone is left out too.
   */
  private async historyPlaces(ctx: RequestContext, codes: readonly string[]): Promise<Map<string, HistoryPlace>> {
    const out = new Map<string, HistoryPlace>();
    if (codes.length === 0) return out;
    const modules = await this.modules.find(ctx, { code: { $in: [...codes] }, status: 'archived' });
    const skills = await this.skills.find(ctx, { code: { $in: [...new Set(modules.map((m) => m.skillCode))] } });
    const categories = await this.categories.find(
      ctx, { code: { $in: [...new Set(skills.map((s) => s.categoryCode))] } },
    );
    const skillOf = new Map(skills.map((s) => [s.code, s]));
    const categoryOf = new Map(categories.map((c) => [c.code, c]));
    for (const module of modules) {
      const skill = skillOf.get(module.skillCode);
      const category = skill ? categoryOf.get(skill.categoryCode) : undefined;
      if (!skill || !category) continue;
      out.set(module.code, {
        title: module.title,
        // What it held when it was withdrawn, so the person tab's *Format* cell says what it was, as an offered row's does.
        formats: formatsOfContent(module),
        displayOrder: module.displayOrder,
        skill: {
          code: skill.code, label: skill.label, description: skill.description ?? null, displayOrder: skill.displayOrder,
        },
        category: {
          code: category.code, label: category.label, description: category.description,
          displayOrder: category.displayOrder,
        },
      });
    }
    return out;
  }
}

/** A withdrawn module's place, read from the live rows. */
interface HistoryPlace {
  title: string;
  formats: TrainingItemKind[];
  displayOrder: number;
  skill: { code: string; label: string; description: string | null; displayOrder: number };
  category: { code: string; label: string; description: string | null; displayOrder: number };
}

/** The kinds a module's live content holds, File · Video · Link order — the *Format* column. */
function formatsOfContent(doc: { officeContent?: unknown; companyContent?: unknown }): TrainingItemKind[] {
  const content = asContent(doc.officeContent ?? doc.companyContent);
  const kinds: TrainingItemKind[] = [];
  if (content.files.length > 0) kinds.push('file');
  if (content.videos.length > 0) kinds.push('video');
  if (content.links.length > 0) kinds.push('link');
  return kinds;
}

export function toRow(doc: TrainingProgressDocument): TrainingProgressRow {
  return {
    id: String(doc._id),
    membershipId: doc.membershipId,
    moduleCode: doc.moduleCode,
    status: doc.status,
    startedAt: doc.startedAt ?? null,
    completedAt: doc.completedAt ?? null,
    openedItemIds: (doc.opened ?? []).map((o) => o.itemId),
  };
}

const NOTHING = { done: 0, total: 0, pct: null } as const;

/** One member's view: the offered tree with their statuses and counts, then their history placed under it. */
function compose(
  membershipId: string,
  catalog: OfferedCatalog,
  formats: ReadonlyMap<string, TrainingItemKind[]>,
  rows: readonly TrainingProgressRow[],
  history: ReadonlyMap<string, HistoryPlace>,
): TrainingProgressView {
  const byCode = new Map(rows.map((row) => [row.moduleCode, row]));
  const statuses: TrainingStatuses = new Map(rows.map((row) => [row.moduleCode, row.status]));
  const counts = completionByScope(catalog.tree, statuses);

  // The history, grouped by skill, each skill's rows in the module's own order.
  const archivedBySkill = new Map<string, { place: HistoryPlace; rows: TrainingArchivedModuleView[] }[]>();
  for (const row of rows) {
    if (row.status !== 'done' || catalog.modules.has(row.moduleCode)) continue;
    const place = history.get(row.moduleCode);
    if (!place) continue;
    const list = archivedBySkill.get(place.skill.code) ?? [];
    list.push({
      place,
      rows: [{
        code: row.moduleCode, title: place.title, formats: place.formats, status: 'done',
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      }],
    });
    archivedBySkill.set(place.skill.code, list);
  }
  const archivedOf = (skillCode: string): TrainingArchivedModuleView[] => (archivedBySkill.get(skillCode) ?? [])
    .sort((a, b) => a.place.displayOrder - b.place.displayOrder)
    .flatMap((entry) => entry.rows);

  const offeredSkills = new Set(catalog.tree.flatMap((c) => c.skills.map((s) => s.code)));
  const offeredCategories = new Set(catalog.tree.map((c) => c.code));

  /*
   * **A category with no published module is not offered** (P18.9-T4 AC-9, ADR-0176 §9; the client's UI-031): the
   * snapshot carries every active category, and *Product* or *Recruiting* with nothing in them drew a tab an agent
   * opened onto *coming soon*. Such a category is left out — or, where the member's history sits under it, read as
   * no longer offered, its skills with it, so the person tab still draws what was done and no tab is drawn.
   */
  const categories: TrainingCategoryProgressView[] = catalog.tree.flatMap((category) => {
    const offersSomething = category.skills.some((skill) => skill.modules.length > 0);
    const skills: TrainingSkillProgressView[] = category.skills.map((skill) => ({
      code: skill.code,
      label: skill.label,
      // A snapshot published before P19.6-T4 carries none: read as none.
      description: skill.description ?? null,
      offered: offersSomething,
      ...(counts.skills.get(skill.code) ?? NOTHING),
      modules: skill.modules.map((module) => {
        const row = byCode.get(module.code);
        const status = row?.status ?? 'not_started';
        return {
          code: module.code,
          title: module.title,
          description: module.description ?? null,
          formats: formats.get(module.code) ?? [],
          status,
          completedAt: status === 'done' && row?.completedAt ? row.completedAt.toISOString() : null,
        };
      }),
      archived: archivedOf(skill.code),
    }));
    // A skill with nothing offered and no history has nothing to draw.
    const drawn = [
      ...skills,
      ...withdrawnSkills(archivedBySkill, offeredSkills, category.code, archivedOf),
    ].filter((s) => s.modules.length > 0 || s.archived.length > 0);
    if (!offersSomething && drawn.length === 0) return [];
    return [{
      code: category.code,
      label: category.label,
      description: category.description,
      offered: offersSomething,
      ...(counts.categories.get(category.code) ?? NOTHING),
      skills: drawn,
    }];
  });

  // A category no longer offered that still holds the member's history: after the offered ones, in its order.
  const withdrawnCategories = new Map<string, HistoryPlace['category']>();
  for (const [skillCode, entries] of archivedBySkill) {
    // A skill still offered draws its history under itself, wherever the snapshot places it.
    if (offeredSkills.has(skillCode)) continue;
    const { category } = entries[0].place;
    if (!offeredCategories.has(category.code)) withdrawnCategories.set(category.code, category);
  }
  for (const category of [...withdrawnCategories.values()].sort((a, b) => a.displayOrder - b.displayOrder)) {
    categories.push({
      code: category.code,
      label: category.label,
      description: category.description,
      offered: false,
      ...NOTHING,
      skills: withdrawnSkills(archivedBySkill, offeredSkills, category.code, archivedOf),
    });
  }

  return {
    membershipId,
    ...counts.catalog,
    categories,
    allOfferedDone: counts.allOfferedDone,
  };
}

/** The skills of one category that are no longer offered and hold history, in their order. */
function withdrawnSkills(
  archivedBySkill: ReadonlyMap<string, { place: HistoryPlace }[]>,
  offeredSkills: ReadonlySet<string>,
  categoryCode: string,
  archivedOf: (skillCode: string) => TrainingArchivedModuleView[],
): TrainingSkillProgressView[] {
  return [...archivedBySkill.entries()]
    .filter(([skillCode, entries]) => !offeredSkills.has(skillCode) && entries[0].place.category.code === categoryCode)
    .sort(([, a], [, b]) => a[0].place.skill.displayOrder - b[0].place.skill.displayOrder)
    .map(([skillCode, entries]) => ({
      code: skillCode,
      label: entries[0].place.skill.label,
      description: entries[0].place.skill.description ?? null,
      offered: false,
      ...NOTHING,
      modules: [],
      archived: archivedOf(skillCode),
    }));
}
