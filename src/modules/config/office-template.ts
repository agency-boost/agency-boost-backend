import type { Sentence } from '@/common/i18n/sentence';
import { trainingLinkModuleCode } from '@/modules/activation/activation-input';
import type { StoredObject } from '@/modules/assets/storage.port';
import type { TrainingContentPayload, TrainingTaxonomyPayload } from '@/modules/training/training-payload';
import { withCascadeTypes, type NamedTemplateKind, type OfficeTemplateKind } from './template-defaults';
import {
  BINDING_ROLE_LABEL, BINDING_ROLES, bindingOfPayload, defaultBinding, type CascadeBinding,
} from './activity-binding';
import { TEMPLATE_MESSAGES } from './template.messages';

/** Why a setting was left out, in both languages (P18.10-T5 AC-4): written for the person who saved. */
const SAY = TEMPLATE_MESSAGES;

/**
 * **An office's published settings, as a template's kinds** (P13.2-T7, ADR-0115 §5, §6).
 *
 * Pure: `OfficeSettingsSource` reads the rows, `TemplateCopyService` writes the template, and this
 * decides what crosses — so the rule *"what its agents read, never the draft, never anything
 * archived"* is one function with its own unit spec, and the demo seed's *BSD City settings* is made
 * by the same function the console's *Save as template* is.
 */

type Status = 'active' | 'archived';
type Row = Record<string, unknown>;

/**
 * One office's configuration, as `OfficeSettingsSource.publishedSettingsOf` reads it.
 *
 * **The snapshot is the source of everything but the checklist and module content** (exit review of
 * P13.2, finding 1). The Owner's staged batch writes the live training, event-type and capability rows
 * before anybody presses Publish, so reading those rows copied the Owner's unpublished edits into a
 * template, while the office's agents read the snapshot (`TenantConfigService.readPublished`). The
 * checklist is published on its own (`activationTemplates`, `status: 'published'`), and a module's
 * content is files, which no snapshot carries (P5-T2): both are read as agents are shown them.
 */
export interface OfficeSettings {
  /**
   * The office's newest published `configSnapshots` payload: the activity taxonomy, ratios and both
   * pipelines, the training agents are offered (`training`), the event types (`eventTypes`) and the
   * capability catalog with each row's status (`capability`). `null` when the office has none.
   */
  snapshot: Row | null;
  /** The newest **published** activation checklist version, or none. */
  checklist: { aspects: ChecklistAspect[] } | null;
  /**
   * The content of the modules the snapshot offers, by code — read live, as an agent opening the
   * module is shown it: the office's replacement where it has one, else the company's (ADR-0032). A
   * code the snapshot does not offer is never asked for, and a row for one is ignored.
   */
  moduleContent: { code: string; companyContent?: ContentRows | null; officeContent?: ContentRows | null }[];
  /**
   * The office's **live** activity binding (ADR-0163): the Super Admin keeps it and the Owner does not publish it,
   * so the live row is never an unpublished edit — it is what the office counts. Absent, the snapshot's
   * `activityBinding`, and without either the template carries none and its offices count the default binding.
   */
  binding?: CascadeBinding | null;
}

/** The snapshot's training, as `TrainingService.offered` rendered it: nested, each row with its status. */
interface SnapshotTrainingCategory {
  code: string; label: string; description?: string | null; displayOrder: number; status?: Status;
  skills?: {
    code: string; categoryCode: string; label: string; displayOrder: number; status?: Status;
    modules?: {
      code: string; skillCode: string; title: string; publishState?: string; displayOrder: number; status?: Status;
    }[];
  }[];
}

/** The snapshot's event types: active rows only, without a status (`SnapshotEventTypeView`). */
interface SnapshotEventType {
  code: string; label: string; description?: string | null; emoji?: string | null; color?: string | null;
  displayOrder: number; status?: Status;
}

/** The snapshot's capability catalog: every row, archived ones included, each with its status. */
interface SnapshotCapability {
  stages: { code: string; label: string; requiredMilestoneCodes: string[]; stageOrder: number; displayOrder: number; status?: Status }[];
  milestones: { code: string; label: string; displayOrder: number; status?: Status }[];
  grids: {
    code: string; label: string; requiresDownline?: boolean; displayOrder: number; status?: Status;
    items: { code: string; label: string; displayOrder: number; status?: Status }[];
  }[];
}

interface ChecklistAspect {
  code: string;
  label: string;
  displayOrder: number;
  items: { code: string; label: string; displayOrder: number; autoLink?: string | null }[];
}

type FileRow = { id: string; label: string; storageKey: string; mimeType: string; bytes: number };
interface ContentRows {
  files?: FileRow[];
  videos?: FileRow[];
  links?: { id: string; label: string; url: string }[];
}

/**
 * A template's kinds, each the payload its published version 1 will hold. Absent: held empty. The recruitment playbook
 * among them (ADR-0210 §1): a copy carries it; an office's settings never hold one.
 */
export type TemplateKinds = Partial<Record<NamedTemplateKind, Record<string, unknown>>>;

/**
 * **A file a template's training content names**, and whose it is (ADR-0032): `office` for an
 * office's own replacement material, `company` for the company's, referenced.
 */
export interface TemplateFile {
  storageKey: string;
  label: string;
  moduleCode: string;
  owner: 'office' | 'company';
}

/**
 * **Something an office holds that a template made from it leaves out or changes, and why** (exit review
 * of P13.2, finding 2).
 *
 * An office may legally hold what no template may: a ratio naming an activity type archived since
 * (`ActivityConfigService.archiveType` allows it), a capability stage whose every required milestone is
 * archived, a published checklist item linking to a training module no longer offered. Each is what
 * archiving leaves behind, and each would make an office built from the template broken — so rather than
 * refuse the whole save, the archived input is dropped, and the drop is said: in the audit row and in the
 * answer, which the office page shows when the dialog closes.
 */
export interface DroppedSetting {
  kind: OfficeTemplateKind;
  /** The ratio, stage, grid or checklist item concerned; `null` when the whole kind is left out. */
  code: string | null;
  /**
   * One sentence, naming the codes, in both languages (P18.10-T5 AC-4): written for the person who saved where the
   * answer and the audit row are made (`TemplateCopyService.saveOffice`), as the office page shows it.
   */
  reason: Sentence<null>;
}

/** A dropped setting as the answer and the audit row carry it: its reason written for its reader. */
export interface DroppedSettingView extends Omit<DroppedSetting, 'reason'> {
  reason: string;
}

const live = (row: { status?: Status }) => (row.status ?? 'active') === 'active';
const byOrder = <T extends { displayOrder: number }>(a: T, b: T) => a.displayOrder - b.displayOrder;

/**
 * **What an office's agents read, as template kinds** (ADR-0115 §5).
 *
 * From the newest published snapshot — never the live rows, which may hold the Owner's unpublished
 * edits — the **taxonomy, ratios and both pipelines**; the **training** agents are offered, each module
 * with the content agents are shown (the office's replacement where it has one, else the company's); the
 * **event types**; the **capability ladder** without its archived rows. And the **newest published
 * checklist**: a draft is somebody's work in progress.
 *
 * Codes are kept (invariant §4). A kind the office holds nothing of is left out, so the template
 * leaves it unpublished — which is how a template says *empty* (ADR-0115 §3). Nothing here reads a
 * member, a log, a lead or any other business record: there is no field for one to arrive in.
 *
 * **What archiving left behind is dropped, and listed in `dropped`** (exit review, finding 2): an
 * archived activity type out of a ratio, and the ratio itself when a side is left counting nothing; a
 * stage's archived milestones out of its requirement, and the stage when none is left; a grid whose
 * every item is archived; the whole ladder when it is left with no stage or no milestone; a checklist
 * item's link to a module the template does not offer, the item kept as a manual one.
 */
export function templateKindsFromOffice(
  settings: OfficeSettings,
): { kinds: TemplateKinds; files: TemplateFile[]; dropped: DroppedSetting[] } {
  const kinds: TemplateKinds = {};
  const files: TemplateFile[] = [];
  const dropped: DroppedSetting[] = [];

  const snapshot = settings.snapshot ?? {};
  const categories = ((snapshot.activity ?? []) as Row[]).filter(live as (r: Row) => boolean)
    .sort(byOrder as (a: Row, b: Row) => number);
  if (categories.length) {
    kinds.activity_taxonomy = {
      categories: categories.map((c) => ({
        code: c.code,
        label: c.label,
        description: c.description ?? null,
        displayOrder: c.displayOrder,
        summaryGroupCode: c.summaryGroupCode ?? null,
        summaryGroupLabel: c.summaryGroupLabel ?? null,
        appliesToOrgLevelCodes: [...((c.appliesToOrgLevelCodes as string[] | undefined) ?? [])],
      })),
      types: categories.flatMap((c) => ((c.types ?? []) as Row[])
        .filter(live as (r: Row) => boolean)
        .sort(byOrder as (a: Row, b: Row) => number)
        .map((t) => ({
          code: t.code,
          categoryCode: c.code,
          label: t.label,
          description: t.description ?? null,
          displayOrder: t.displayOrder,
        }))),
    };
    const bindings = bindingFrom(settings, kinds.activity_taxonomy, dropped);
    if (bindings) kinds.activity_taxonomy.bindings = bindings;
  }

  const statuses = ((snapshot.leadPipelines ?? []) as { statuses?: Row[] }[])
    .flatMap((p) => (p.statuses ?? []).filter(live as (r: Row) => boolean));
  if (statuses.length) {
    kinds.lead_pipeline = {
      statuses: statuses.map((s) => ({
        pipeline: s.pipeline,
        code: s.code,
        label: s.label,
        rank: s.rank,
        isTerminal: Boolean(s.isTerminal),
        isLateStage: Boolean(s.isLateStage),
      })),
    };
  }

  const ratios = ratiosFrom(snapshot, kinds, dropped);
  if (ratios.length) kinds.ratio_set = { ratios };

  const training = trainingFrom(snapshot, settings.moduleContent, files);
  if (training) kinds.training_taxonomy = training as unknown as Record<string, unknown>;

  const checklist = checklistFrom(settings.checklist, training, dropped);
  if (checklist) kinds.activation_checklist = checklist;

  const eventTypes = ((snapshot.eventTypes ?? []) as SnapshotEventType[]).filter(live).sort(byOrder);
  if (eventTypes.length) {
    kinds.event_types = {
      types: eventTypes.map((t) => ({
        code: t.code, label: t.label, description: t.description ?? null, emoji: t.emoji ?? null, color: t.color ?? null,
      })),
    };
  }

  const capability = capabilityFrom((snapshot.capability ?? null) as SnapshotCapability | null, dropped);
  if (capability) kinds.capability_ladder = capability;

  return { kinds, files, dropped };
}

/**
 * **The office's activity binding, for the template** (ADR-0163 §1): each role's codes that are among the
 * template's activity types — the office's active ones. An archived code counts in the office for its history, and
 * an office made from the template has no history: it is taken out, and said. A role left counting nothing leaves
 * the whole binding out, said too, and the template's offices count the default binding.
 */
function bindingFrom(settings: OfficeSettings, taxonomy: Record<string, unknown>, dropped: DroppedSetting[]): CascadeBinding | null {
  const held = settings.binding
    ?? bindingOfPayload({ bindings: (settings.snapshot as Row | null)?.activityBinding ?? null });
  if (!held) return null;
  // `taxonomy` is the kind `templateKindsFromOffice` has just built, whose `types` is always a list.
  const typeCodes = new Set((taxonomy.types as Row[]).map((t) => String(t.code)));
  const kept = Object.fromEntries(BINDING_ROLES.map((role) => [role, held[role].filter((c) => typeCodes.has(c))])) as unknown as CascadeBinding;
  const gone = [...new Set(BINDING_ROLES.flatMap((role) => held[role].filter((c) => !typeCodes.has(c))))];
  const empty = BINDING_ROLES.filter((role) => kept[role].length === 0);
  if (empty.length) {
    dropped.push({
      kind: 'activity_taxonomy',
      code: null,
      reason: SAY.bindingLeftOut({ roles: empty.map((role) => BINDING_ROLE_LABEL[role]), gone }),
    });
    return null;
  }
  if (gone.length) {
    dropped.push({
      kind: 'activity_taxonomy',
      code: null,
      reason: SAY.bindingNoLonger({ gone }),
    });
  }
  return kept;
}

/**
 * The active ratios, each counting only activity types an office made from the template will have: the
 * template's own, and the three cascade types every office is given (ADR-0115 §2) — the set provisioning's
 * whole-source check holds a ratio to. An archived code is taken out; a ratio with a side left counting
 * nothing is left out. Each is recorded.
 */
function ratiosFrom(snapshot: Row, kinds: TemplateKinds, dropped: DroppedSetting[]): Row[] {
  const taxonomy = (kinds.activity_taxonomy ?? {}) as {
    categories?: Parameters<typeof withCascadeTypes>[0];
    types?: Parameters<typeof withCascadeTypes>[1];
  };
  // The types the template's own binding gives an office, or the default binding's (ADR-0163 §5).
  const given = withCascadeTypes(
    taxonomy.categories ?? [], taxonomy.types ?? [], bindingOfPayload(kinds.activity_taxonomy) ?? defaultBinding(),
  );
  const sections = new Set(given.categories.map((c) => c.code));
  const typeCodes = new Set(given.types.filter((t) => sections.has(t.categoryCode)).map((t) => t.code));

  const kept: Row[] = [];
  for (const r of ((snapshot.ratios ?? []) as Row[]).filter(live as (r: Row) => boolean)
    .sort(byOrder as (a: Row, b: Row) => number)) {
    const code = String(r.code);
    const numerator = [...((r.numerator as string[] | undefined) ?? [])];
    const denominator = [...((r.denominator as string[] | undefined) ?? [])];
    const gone = [...new Set([...numerator, ...denominator].filter((c) => !typeCodes.has(c)))];
    const top = numerator.filter((c) => typeCodes.has(c));
    const bottom = denominator.filter((c) => typeCodes.has(c));

    if (gone.length && (top.length === 0 || bottom.length === 0)) {
      const side = top.length === 0 && bottom.length === 0 ? 'both' : top.length === 0 ? 'numerator' : 'denominator';
      dropped.push({ kind: 'ratio_set', code, reason: SAY.ratioLeftOut({ code, side, gone }) });
      continue;
    }
    if (gone.length) {
      dropped.push({
        kind: 'ratio_set',
        code,
        reason: SAY.ratioNoLonger({ code, gone }),
      });
    }
    kept.push({
      code: r.code,
      label: r.label,
      numerator: top,
      denominator: bottom,
      benchmark: r.benchmark,
      comparison: r.comparison,
      displayUnit: r.displayUnit,
      displayOrder: r.displayOrder,
      appliesToOrgLevelCodes: [...((r.appliesToOrgLevelCodes as string[] | undefined) ?? [])],
    });
  }
  return kept;
}

/**
 * The newest published checklist, each item's link to a module the template does not offer taken off —
 * the item kept, as a manual one, because what it asks of a hire still stands; only the tick that
 * finishing the module would have given it is gone.
 */
function checklistFrom(
  checklist: OfficeSettings['checklist'],
  training: TrainingTaxonomyPayload | null,
  dropped: DroppedSetting[],
): Record<string, unknown> | null {
  if (!checklist || checklist.aspects.length === 0) return null;
  const offered = new Set((training?.modules ?? []).map((m) => m.code));
  return {
    aspects: [...checklist.aspects].sort(byOrder).map((aspect) => ({
      code: aspect.code,
      label: aspect.label,
      items: [...aspect.items].sort(byOrder).map((item) => {
        const link = item.autoLink ?? null;
        const moduleCode = trainingLinkModuleCode(link);
        if (moduleCode !== null && !offered.has(moduleCode)) {
          dropped.push({
            kind: 'activation_checklist',
            code: item.code,
            reason: SAY.checklistManual({ item: item.code, moduleCode }),
          });
          return { code: item.code, label: item.label, autoLink: null };
        }
        return { code: item.code, label: item.label, autoLink: link };
      }),
    })),
  };
}

/** The training an office's agents are offered — the snapshot's — with the content they are shown. */
function trainingFrom(
  snapshot: Row,
  moduleContent: OfficeSettings['moduleContent'],
  files: TemplateFile[],
): TrainingTaxonomyPayload | null {
  const categories = ((snapshot.training ?? []) as SnapshotTrainingCategory[]).filter(live).sort(byOrder);
  if (categories.length === 0) return null;
  const skills = categories.flatMap((c) => (c.skills ?? [])
    .filter(live)
    .sort(byOrder)
    .map((s) => ({ ...s, categoryCode: s.categoryCode ?? c.code })));
  const modules = skills.flatMap((s) => (s.modules ?? [])
    .filter((m) => live(m) && m.publishState === 'published')
    .sort(byOrder)
    .map((m) => ({ ...m, skillCode: m.skillCode ?? s.code })));
  const contentOfModule = new Map(moduleContent.map((row) => [row.code, row]));

  return {
    categories: categories.map((c) => ({ code: c.code, label: c.label, description: c.description ?? null })),
    skills: skills.map((s) => ({ code: s.code, categoryCode: s.categoryCode, label: s.label })),
    modules: modules.map((m) => {
      // What agents are shown: the office's replacement, where it has one, else the company's (ADR-0032).
      const row = contentOfModule.get(m.code);
      const own = row?.officeContent ?? null;
      const shown = own ?? row?.companyContent ?? null;
      const owner = own ? 'office' : 'company';
      const content = contentOf(shown);
      for (const file of [...(content?.files ?? []), ...(content?.videos ?? [])]) {
        files.push({ storageKey: file.storageKey, label: file.label, moduleCode: m.code, owner });
      }
      return {
        code: m.code,
        skillCode: m.skillCode,
        title: m.title,
        publishState: 'published' as const,
        ...(content ? { content } : {}),
      };
    }),
  };
}

/** A module's content as a template holds it, or nothing when it has none. Links are copied as links. */
function contentOf(rows: ContentRows | null): TrainingContentPayload | null {
  if (!rows) return null;
  const file = (f: FileRow) => ({ id: f.id, label: f.label, storageKey: f.storageKey, mimeType: f.mimeType, bytes: f.bytes });
  const content = {
    files: (rows.files ?? []).map(file),
    videos: (rows.videos ?? []).map(file),
    links: (rows.links ?? []).map((l) => ({ id: l.id, label: l.label, url: l.url })),
  };
  return content.files.length || content.videos.length || content.links.length ? content : null;
}

/**
 * The capability ladder with nothing archived in it: no stage, milestone, grid or item.
 *
 * An archived milestone takes no new tick, so a stage is not required to reach one: it leaves the
 * requirement, and a stage left requiring nothing is left out — an office made from the template would
 * otherwise put everybody on it. A grid whose every item is archived has nothing to assess and goes too.
 * A ladder left with no stage or no milestone could place nobody, so the whole kind is then left out —
 * and an office made from the template is given the platform's ladder instead, as one with no ladder
 * always is (ADR-0116). Each is recorded.
 */
function capabilityFrom(catalog: SnapshotCapability | null, dropped: DroppedSetting[]): Record<string, unknown> | null {
  if (!catalog) return null;
  const milestones = (catalog.milestones ?? []).filter(live).sort(byOrder);
  const kept = new Set(milestones.map((m) => m.code));
  const activeStages = (catalog.stages ?? []).filter(live).sort(byOrder);
  const activeGrids = (catalog.grids ?? []).filter(live).sort(byOrder);
  if (!activeStages.length && !milestones.length && !activeGrids.length) return null;
  const found: DroppedSetting[] = [];

  const stages = activeStages.flatMap((s) => {
    const gone = s.requiredMilestoneCodes.filter((code) => !kept.has(code));
    const required = s.requiredMilestoneCodes.filter((code) => kept.has(code));
    if (gone.length && required.length === 0) {
      found.push({
        kind: 'capability_ladder',
        code: s.code,
        reason: SAY.stageLeftOut({ code: s.code, gone }),
      });
      return [];
    }
    if (gone.length) {
      found.push({
        kind: 'capability_ladder',
        code: s.code,
        reason: SAY.stageNoLonger({ code: s.code, gone }),
      });
    }
    return [{ code: s.code, label: s.label, requiredMilestoneCodes: required, stageOrder: s.stageOrder }];
  });

  const grids = activeGrids.flatMap((g) => {
    const items = (g.items ?? []).filter(live).sort(byOrder);
    if (items.length === 0) {
      found.push({
        kind: 'capability_ladder',
        code: g.code,
        reason: SAY.gridLeftOut({ code: g.code }),
      });
      return [];
    }
    return [{
      code: g.code,
      label: g.label,
      requiresDownline: g.requiresDownline ?? false,
      items: items.map((i) => ({ code: i.code, label: i.label })),
    }];
  });

  if (stages.length === 0 || milestones.length === 0) {
    dropped.push(...found, {
      kind: 'capability_ladder',
      code: null,
      reason: SAY.ladderLeftOut({ missing: stages.length === 0 ? 'stage' : 'milestone' }),
    });
    return null;
  }
  dropped.push(...found);
  return { stages, milestones: milestones.map((m) => ({ code: m.code, label: m.label })), grids };
}

/** Every file a template's training kind names — all of them the company's, in a company's template. */
export function filesOfTraining(payload: Record<string, unknown> | undefined): TemplateFile[] {
  const modules = ((payload as TrainingTaxonomyPayload | undefined)?.modules ?? []);
  return modules.flatMap((m) => [...(m.content?.files ?? []), ...(m.content?.videos ?? [])].map((f) => ({
    storageKey: f.storageKey, label: f.label, moduleCode: m.code, owner: 'company' as const,
  })));
}

/**
 * **The training kind with each copied file pointing at its copy** (ADR-0115 §6): the key, and what
 * storage says the copy is. Files not in `copies` — the company's own, referenced within a company —
 * and every link are left exactly as they were.
 */
export function withCopiedFiles(
  payload: Record<string, unknown>,
  copies: ReadonlyMap<string, StoredObject>,
): Record<string, unknown> {
  const training = payload as unknown as TrainingTaxonomyPayload;
  const swap = (f: FileRow): FileRow => {
    const copy = copies.get(f.storageKey);
    return copy ? { ...f, storageKey: copy.storageKey, mimeType: copy.mimeType, bytes: copy.bytes } : { ...f };
  };
  return {
    ...training,
    modules: training.modules.map((m) => (m.content
      ? {
        ...m,
        content: {
          ...m.content,
          files: (m.content.files ?? []).map(swap),
          videos: (m.content.videos ?? []).map(swap),
          links: (m.content.links ?? []).map((l) => ({ ...l })),
        },
      }
      : { ...m })),
  } as unknown as Record<string, unknown>;
}

/**
 * **Every rung code a template's kinds name** (ADR-0115 §6): a ratio's and an activity section's
 * `appliesToOrgLevelCodes`. A copy into another company must find each on the destination's ladder.
 */
export function rungCodesOf(kinds: TemplateKinds): string[] {
  const codes = new Set<string>();
  const add = (list: unknown) => {
    for (const raw of (Array.isArray(list) ? list : []) as string[]) {
      const code = String(raw).trim().toUpperCase();
      if (code) codes.add(code);
    }
  };
  for (const ratio of ((kinds.ratio_set?.ratios ?? []) as Row[])) add(ratio.appliesToOrgLevelCodes);
  for (const category of ((kinds.activity_taxonomy?.categories ?? []) as Row[])) add(category.appliesToOrgLevelCodes);
  return [...codes].sort();
}
