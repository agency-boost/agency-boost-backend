import {
  highestVersion, isPublishedSetting, mergeForPublish, PUBLISHED_SETTINGS, SETTING_SECTIONS, settingChanged,
  settingFingerprint, settingVersionsOf,
} from './publish-settings';
import type { TenantConfigView } from './tenant-config.service';

/** A consolidated read with one row per section, each at the version given. */
function view(v: Partial<Record<'cat' | 'type' | 'ratio' | 'lead' | 'training' | 'checklist' | 'event' | 'cap', number>> = {}): TenantConfigView {
  const at = (k: keyof typeof v) => v[k] ?? 1;
  return {
    activity: [{
      id: 'c1', version: at('cat'), summaryGroupCode: null, summaryGroupLabel: null,
      types: [{ id: 't1', version: at('type') }],
    }],
    ratios: [{ id: 'r1', version: at('ratio') }],
    leadPipelines: [{ statuses: [{ id: 'l1', version: at('lead') }] }],
    training: [{ id: 'tc', version: at('training'), skills: [{ id: 'ts', version: 1, modules: [{ id: 'tm', version: 1 }] }] }],
    activationChecklist: { id: 'a1', version: at('checklist') },
    eventTypes: [{ id: 'e1', version: at('event') }],
    capability: { version: at('cap'), stages: [], milestones: [], grids: [] },
    activityBinding: null,
    version: 1,
  } as unknown as TenantConfigView;
}

describe('per-setting publishing (P19.21-T2 AC-3; ADR-0274 §5)', () => {
  it('P19.21-T2 AC-3 names the six settings with a draft, in the hub’s order', () => {
    expect(PUBLISHED_SETTINGS).toEqual([
      'activity_types', 'lead_statuses', 'activation_checklist', 'training', 'capability_mapping', 'events',
    ]);
    expect(isPublishedSetting('events')).toBe(true);
    expect(isPublishedSetting('products')).toBe(false);
    expect(isPublishedSetting(3)).toBe(false);
  });

  it('P19.21-T2 AC-3 ratio benchmarks go out with Activity types — one setting', () => {
    expect(SETTING_SECTIONS.activity_types).toEqual(['activity', 'ratios']);
  });

  it.each([
    ['activity_types', { type: 2 }], ['activity_types', { ratio: 2 }], ['activity_types', { cat: 2 }],
    ['lead_statuses', { lead: 2 }], ['training', { training: 2 }], ['activation_checklist', { checklist: 2 }],
    ['events', { event: 2 }], ['capability_mapping', { cap: 2 }],
  ] as const)('P19.21-T2 AC-3 an edit in %s changes that setting and no other', (setting, edit) => {
    const before = view();
    const after = view(edit);
    for (const other of PUBLISHED_SETTINGS) {
      expect(settingChanged(other, before, after)).toBe(other === setting);
    }
  });

  it('P19.21-T2 AC-3 a reorder is not a change; nothing published is', () => {
    const before = view();
    const after = view();
    after.activity[0].types = [...after.activity[0].types].reverse();
    expect(settingChanged('activity_types', before, after)).toBe(false);
    expect(settingChanged('events', null, after)).toBe(true);
  });

  it('P19.21-T2 AC-3 a regrouped summary tile is a change of Activity types', () => {
    const after = view();
    after.activity[0].summaryGroupCode = 'SELL';
    expect(settingFingerprint('activity_types', after)).toContain('category_tile:c1:SELL:');
    expect(settingChanged('activity_types', view(), after)).toBe(true);
  });

  it('P19.21-T2 AC-3 publishing one setting takes its sections from the working copy and keeps every other', () => {
    const published = view();
    const working = view({ lead: 5, event: 7, type: 3 });
    const merged = mergeForPublish(published, working, ['lead_statuses']);
    expect(merged.leadPipelines).toBe(working.leadPipelines);
    expect(merged.eventTypes).toBe(published.eventTypes);
    expect(merged.activity).toBe(published.activity);
    expect(merged.version).toBe(5);
    const both = mergeForPublish(published, working, ['lead_statuses', 'activity_types']);
    expect(both.activity).toBe(working.activity);
    expect(both.ratios).toBe(working.ratios);
  });

  it('P19.21-T2 AC-3 the activity binding is always the working copy’s record', () => {
    const working = { ...view(), activityBinding: { version: 9 } } as unknown as TenantConfigView;
    expect(mergeForPublish(view(), working, ['events']).activityBinding).toEqual({ version: 9 });
  });

  it('highestVersion reads every section, and 0 for an empty office', () => {
    expect(highestVersion(view({ cap: 4 }))).toBe(4);
    expect(highestVersion({
      activity: [], ratios: [], leadPipelines: [], training: [], activationChecklist: null, eventTypes: [],
      capability: null, activityBinding: null, version: 0,
    })).toBe(0);
  });

  it('P19.21-T2 AC-3 a snapshot before P19.21 reads every setting at its own version; none reads 0', () => {
    expect(settingVersionsOf(null).events).toBe(0);
    expect(settingVersionsOf({ version: 4 })).toEqual({
      activity_types: 4, lead_statuses: 4, activation_checklist: 4, training: 4, capability_mapping: 4, events: 4,
    });
    expect(settingVersionsOf({ version: 6, settingVersions: { events: 2 } }).events).toBe(2);
    expect(settingVersionsOf({ version: 6, settingVersions: { events: 2 } }).training).toBe(6);
  });
});
