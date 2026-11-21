import type { TenantConfigView } from './tenant-config.service';

/**
 * **The settings published each on its own** (P19.21-T2 AC-3; ADR-0274 §5; `revisions/2026-11-19/BRIEF-ADJUSTMENTS-
 * 2026-11-19.md`, *Pengaturan*).
 *
 * Six of the eleven settings have a draft agents do not see until it is published: these. Each has its own published
 * version and its own unpublished state; *Terbitkan* publishes one, *Terbitkan semua* every one with changes. The other
 * five — Campaigns, Products, Recruitment pitch, Branch info, Tampilan KPM — are saved live and have no draft.
 *
 * - `activity_types` — the activity taxonomy **and** the ratio benchmarks, which stay a tab inside Activity types
 *   (OD-405): a ratio names activity types by code, so the two go out together;
 * - `activation_checklist` — the 90-day checklist, whose draft and version are the activation module's own
 *   (`ActivationService`): publishing it publishes that draft as the next version, then renders it into the snapshot.
 */
export const PUBLISHED_SETTINGS = [
  'activity_types', 'lead_statuses', 'activation_checklist', 'training', 'capability_mapping', 'events',
] as const;

export type PublishedSetting = (typeof PUBLISHED_SETTINGS)[number];

export function isPublishedSetting(value: unknown): value is PublishedSetting {
  return typeof value === 'string' && (PUBLISHED_SETTINGS as readonly string[]).includes(value);
}

/** Which parts of the consolidated read each setting owns — what publishing it renders, and what its state compares. */
export const SETTING_SECTIONS: Readonly<Record<PublishedSetting, readonly (keyof TenantConfigView)[]>> = {
  activity_types: ['activity', 'ratios'],
  lead_statuses: ['leadPipelines'],
  activation_checklist: ['activationChecklist'],
  training: ['training'],
  capability_mapping: ['capability'],
  events: ['eventTypes'],
};

/**
 * **One setting's rows, as `kind:id:version`** — the publish gate of P5-T11, split by setting. Which rows are present at
 * which version: a create brings a new id, an edit a new version, an archive or a restore changes which ids are there,
 * and **a reorder changes none of them**. Order is presentation and deliberately absent.
 */
export function settingFingerprint(setting: PublishedSetting, view: TenantConfigView): string[] {
  const keys: string[] = [];
  switch (setting) {
    case 'activity_types':
      for (const category of view.activity ?? []) {
        keys.push(`category:${category.id}:${category.version}`);
        // The summary tile, by value as well as by version (ADR-0064): the second lock on a regrouping.
        keys.push(`category_tile:${category.id}:${category.summaryGroupCode ?? ''}:${category.summaryGroupLabel ?? ''}`);
        for (const type of category.types) keys.push(`type:${type.id}:${type.version}`);
      }
      for (const ratio of view.ratios ?? []) keys.push(`ratio:${ratio.id}:${ratio.version}`);
      break;
    case 'lead_statuses':
      for (const pipeline of view.leadPipelines ?? []) {
        for (const status of pipeline.statuses) keys.push(`lead_status:${status.id}:${status.version}`);
      }
      break;
    case 'training':
      for (const category of view.training ?? []) {
        keys.push(`training_category:${category.id}:${category.version}`);
        for (const skill of category.skills) {
          keys.push(`training_skill:${skill.id}:${skill.version}`);
          for (const module of skill.modules) keys.push(`training_module:${module.id}:${module.version}`);
        }
      }
      break;
    case 'activation_checklist':
      if (view.activationChecklist) keys.push(`activation:${view.activationChecklist.id}:${view.activationChecklist.version}`);
      break;
    case 'events':
      for (const type of view.eventTypes ?? []) keys.push(`event_type:${type.id}:${type.version}`);
      break;
    case 'capability_mapping':
      if (view.capability) keys.push(`capability:${view.capability.version}`);
      break;
  }
  return keys.sort();
}

/** Whether a setting's rows differ between what agents read and the working copy. Nothing published differs. */
export function settingChanged(
  setting: PublishedSetting, published: TenantConfigView | null, working: TenantConfigView,
): boolean {
  if (!published) return true;
  const before = settingFingerprint(setting, published);
  const now = settingFingerprint(setting, working);
  return before.length !== now.length || before.some((key, i) => key !== now[i]);
}

/**
 * **What a publish of `settings` renders** (AC-3): the working copy's sections for those settings, every other setting's
 * as agents read it now. The activity binding is the working copy's whatever is published — a record of what counted,
 * never an Owner's change waiting on *Terbitkan* (ADR-0163 §1).
 */
export function mergeForPublish(
  published: TenantConfigView, working: TenantConfigView, settings: readonly PublishedSetting[],
): TenantConfigView {
  const merged = { ...published, activityBinding: working.activityBinding } as TenantConfigView;
  const target = merged as unknown as Record<string, unknown>;
  const source = working as unknown as Record<string, unknown>;
  for (const setting of settings) {
    for (const section of SETTING_SECTIONS[setting]) target[section] = source[section];
  }
  merged.version = highestVersion(merged);
  return merged;
}

/** The highest row `version` across a consolidated read — `TenantConfigView.version`, informational only. */
export function highestVersion(view: TenantConfigView): number {
  const versions = [
    ...(view.activity ?? []).map((c) => c.version),
    ...(view.activity ?? []).flatMap((c) => c.types.map((t) => t.version)),
    ...(view.ratios ?? []).map((r) => r.version),
    ...(view.leadPipelines ?? []).flatMap((p) => p.statuses.map((s) => s.version)),
    ...(view.training ?? []).map((c) => c.version),
    ...(view.training ?? []).flatMap((c) => c.skills.map((s) => s.version)),
    ...(view.training ?? []).flatMap((c) => c.skills.flatMap((s) => s.modules.map((m) => m.version))),
    ...(view.activationChecklist ? [view.activationChecklist.version] : []),
    ...(view.eventTypes ?? []).map((t) => t.version),
    ...(view.capability ? [view.capability.version] : []),
  ];
  return versions.length ? Math.max(...versions) : 0;
}

/**
 * **Each setting's published version** (AC-3, *"Agent masih memakai versi n"*), from a snapshot. A snapshot written
 * before per-setting publishing carries no `settingVersions`: every publish then rendered every setting, so each stands
 * at the snapshot's own version — no migration needed. `0` where nothing was ever published.
 */
export function settingVersionsOf(
  snapshot: { version: number; settingVersions?: Partial<Record<string, number>> | null } | null,
): Record<PublishedSetting, number> {
  const out = {} as Record<PublishedSetting, number>;
  for (const setting of PUBLISHED_SETTINGS) {
    const own = snapshot?.settingVersions?.[setting];
    out[setting] = typeof own === 'number' ? own : snapshot ? snapshot.version : 0;
  }
  return out;
}
