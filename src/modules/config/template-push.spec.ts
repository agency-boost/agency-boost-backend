import { trainingSeedDocuments, defaultTrainingTaxonomy } from '@/modules/training/training-payload';
import { capabilitySeedDocument, defaultCapabilityLadder } from '@/modules/capability/capability-payload';
import {
  differencesOf, itemsOfOffice, itemsOfPayload, kindsInOrder, mergeDifferences, ownMaterialDifferences, pushStateOf,
  type OfficeRows,
} from './template-push';
import { platformDefaultPayload, withCascadeTypes } from './template-defaults';
import { PUBLISH_ORDER } from './template.service';

type Row = Record<string, unknown>;

const empty = (): OfficeRows => ({
  activityCategories: [], activityTypes: [], binding: null, ratios: [], leadStatuses: [],
  trainingCategories: [], trainingSkills: [], trainingModules: [], checklist: null, capability: null, eventTypes: [],
});

/** An office provisioned from an activity payload, row for row, as `seedActivityTaxonomy` writes it. */
function activityOffice(payload: Record<string, unknown>): OfficeRows {
  const source = payload as { categories?: never[]; types?: never[] };
  const { categories, types } = withCascadeTypes(source.categories ?? [], source.types ?? []);
  return {
    ...empty(),
    activityCategories: categories.map((c, i) => ({
      ...c, _id: `c${i}`, version: 1, status: 'active', description: null, appliesToOrgLevelCodes: [],
      summaryGroupCode: c.summaryGroupCode ?? null, summaryGroupLabel: c.summaryGroupLabel ?? null,
    })),
    activityTypes: types.map((t, i) => ({ ...t, _id: `t${i}`, version: 1, status: 'active', description: t.description ?? null })),
  };
}

/** An office provisioned from a training payload, as `seedTrainingTaxonomy` writes it. */
function trainingOffice(payload = defaultTrainingTaxonomy()): OfficeRows {
  const rows = trainingSeedDocuments('kpm-1', payload);
  return {
    ...empty(),
    trainingCategories: rows.categories as unknown as Row[],
    trainingSkills: rows.skills as unknown as Row[],
    trainingModules: rows.modules as unknown as Row[],
  };
}

describe('P19.4-T1 what a KPM changed in a section, by code (ADR-0208 §4)', () => {
  const activity = platformDefaultPayload('activity_taxonomy');

  it('P19.4-T1 AC-7 a KPM that never edited the section is unchanged, however old the version it was given', () => {
    const differences = differencesOf(
      'activity_taxonomy', itemsOfPayload('activity_taxonomy', activity), itemsOfOffice('activity_taxonomy', activityOffice(activity)),
    );
    expect(differences).toEqual([]);
    // Given version 1 of 5, untouched: unchanged, never "behind and therefore changed".
    expect(pushStateOf(1, 5, differences)).toBe('unchanged');
  });

  it('P19.4-T1 AC-7 a KPM that added, renamed or archived an item is changed, each said by code', () => {
    const office = activityOffice(activity);
    const [first, second] = office.activityTypes;
    first.label = 'Kopi bersama klien';
    second.status = 'archived';
    office.activityTypes.push({ code: 'COFFEE_MEETING', categoryCode: first.categoryCode, label: 'Ngopi', status: 'active' });
    const differences = differencesOf(
      'activity_taxonomy', itemsOfPayload('activity_taxonomy', activity), itemsOfOffice('activity_taxonomy', office),
    );
    expect(differences).toEqual(expect.arrayContaining([
      { level: 'types', code: first.code, change: 'changed', fields: ['label'] },
      { level: 'types', code: 'COFFEE_MEETING', change: 'added' },
      { level: 'types', code: second.code, change: 'removed' },
    ]));
    expect(differences).toHaveLength(3);
    expect(pushStateOf(1, 2, differences)).toBe('changed');
  });

  it('P19.4-T1 AC-7 ids, versions, authors, timestamps and display order are never compared', () => {
    const office = activityOffice(activity);
    for (const [i, row] of office.activityTypes.entries()) {
      Object.assign(row, { _id: `other-${i}`, version: 9, updatedBy: 'someone', updatedAt: new Date(), displayOrder: 99 - i });
    }
    expect(differencesOf(
      'activity_taxonomy', itemsOfPayload('activity_taxonomy', activity), itemsOfOffice('activity_taxonomy', office),
    )).toEqual([]);
  });

  it('P19.4-T1 AC-7 the three cascade types an office is given whatever its source are not the KPM’s own additions', () => {
    // A template holding none of them: provisioning adds the three (ADR-0115 §2), and so does the comparison.
    const bare = { categories: [], types: [] };
    expect(differencesOf(
      'activity_taxonomy', itemsOfPayload('activity_taxonomy', bare), itemsOfOffice('activity_taxonomy', activityOffice(bare)),
    )).toEqual([]);
  });

  it('P19.4-T1 AC-6 a KPM already on the newest version is current, whatever it changed since: a push skips it', () => {
    expect(pushStateOf(3, 3, [{ level: 'types', code: 'X', change: 'added' }])).toBe('current');
    expect(pushStateOf(null, 1, [])).toBe('unchanged');
    expect(pushStateOf(undefined, 1, [{ level: 'types', code: 'X', change: 'added' }])).toBe('changed');
  });

  it('P19.4-T1 AC-8 training: every module showing the KPM’s own material makes the section changed, counted', () => {
    const office = trainingOffice();
    const modules = office.trainingModules;
    for (const m of modules.slice(0, 3)) m.officeContent = { files: [{ id: 'f', label: 'Mine', storageKey: 'k', mimeType: 'application/pdf', bytes: 1 }], videos: [], links: [] };
    // An archived module's own material is not shown, so it is not counted.
    modules[3].officeContent = { files: [], videos: [], links: [] };
    modules[3].status = 'archived';
    const own = ownMaterialDifferences(modules);
    expect(own.map((d) => d.code)).toEqual(modules.slice(0, 3).map((m) => m.code));
    expect(own.every((d) => d.change === 'changed' && d.fields?.[0] === 'material')).toBe(true);

    const structural = differencesOf(
      'training_taxonomy', itemsOfPayload('training_taxonomy', defaultTrainingTaxonomy() as never), itemsOfOffice('training_taxonomy', office),
    );
    // The archived module is a removal; the three with material are changes of `material` alone.
    expect(structural).toEqual([{ level: 'modules', code: modules[3].code, change: 'removed' }]);
    const merged = mergeDifferences(structural, own);
    expect(merged).toHaveLength(4);
  });

  it('P19.4-T1 AC-8 a module both retitled and given the KPM’s own material says both fields, once', () => {
    const merged = mergeDifferences(
      [{ level: 'modules', code: 'M', change: 'changed', fields: ['title'] }],
      [{ level: 'modules', code: 'M', change: 'changed', fields: ['material'] }],
    );
    expect(merged).toEqual([{ level: 'modules', code: 'M', change: 'changed', fields: ['material', 'title'] }]);
  });

  it('P19.6-T4 AC-1 a skill’s and a module’s description are fields an Owner edits: a KPM that wrote one is changed', () => {
    const office = trainingOffice();
    expect(differencesOf(
      'training_taxonomy', itemsOfPayload('training_taxonomy', defaultTrainingTaxonomy() as never), itemsOfOffice('training_taxonomy', office),
    )).toEqual([]);
    office.trainingSkills[0].description = 'Cara mendapat calon nasabah';
    office.trainingModules[0].description = 'Satu baris';
    expect(differencesOf(
      'training_taxonomy', itemsOfPayload('training_taxonomy', defaultTrainingTaxonomy() as never), itemsOfOffice('training_taxonomy', office),
    )).toEqual([
      { level: 'skills', code: office.trainingSkills[0].code, change: 'changed', fields: ['description'] },
      { level: 'modules', code: office.trainingModules[0].code, change: 'changed', fields: ['description'] },
    ]);
  });

  it('P19.4-T1 AC-3 a template’s material is not a field an Owner edits: content alone never makes a KPM changed', () => {
    const withMaterial = defaultTrainingTaxonomy();
    withMaterial.modules[0].content = { links: [{ id: 'l', label: 'Baca', url: 'https://example.com/' }] };
    expect(differencesOf(
      'training_taxonomy', itemsOfPayload('training_taxonomy', withMaterial as never), itemsOfOffice('training_taxonomy', trainingOffice()),
    )).toEqual([]);
  });

  it('P19.4-T1 AC-7 the capability ladder: a template with none compares against the platform ladder its offices are given', () => {
    const ladder = capabilitySeedDocument('kpm-1', defaultCapabilityLadder());
    const office = { ...empty(), capability: ladder as never };
    expect(differencesOf('capability_ladder', itemsOfPayload('capability_ladder', null), itemsOfOffice('capability_ladder', office)))
      .toEqual([]);
    (ladder.grids[0].items[0] as Row).label = 'Renamed';
    expect(differencesOf('capability_ladder', itemsOfPayload('capability_ladder', null), itemsOfOffice('capability_ladder', office)))
      .toEqual([{ level: 'gridItems', code: `${ladder.grids[0].code}:${ladder.grids[0].items[0].code}`, change: 'changed', fields: ['label'] }]);
  });

  it('P19.4-T1 AC-7 the lead pipeline, the ratios, the checklist and the event types, by code', () => {
    const pipeline = platformDefaultPayload('lead_pipeline') as { statuses: Row[] };
    const statuses: Row[] = pipeline.statuses.map((s) => ({ ...s, isLateStage: s.isLateStage ?? false, status: 'active' }));
    statuses[0].label = 'Baru';
    expect(differencesOf('lead_pipeline', itemsOfPayload('lead_pipeline', pipeline), itemsOfOffice('lead_pipeline', { ...empty(), leadStatuses: statuses })))
      .toEqual([{ level: 'statuses', code: statuses[0].code, change: 'changed', fields: ['label'] }]);

    const ratios = platformDefaultPayload('ratio_set') as { ratios: Row[] };
    const rows: Row[] = ratios.ratios.map((r) => ({ ...r, status: 'active' }));
    expect(differencesOf('ratio_set', itemsOfPayload('ratio_set', ratios), itemsOfOffice('ratio_set', { ...empty(), ratios: rows }))).toEqual([]);
    rows[0].benchmark = 0.99;
    expect(differencesOf('ratio_set', itemsOfPayload('ratio_set', ratios), itemsOfOffice('ratio_set', { ...empty(), ratios: rows })))
      .toEqual([{ level: 'ratios', code: rows[0].code, change: 'changed', fields: ['benchmark'] }]);

    const events = platformDefaultPayload('event_types') as { types: Row[] };
    expect(differencesOf('event_types', itemsOfPayload('event_types', events), itemsOfOffice('event_types', { ...empty(), eventTypes: [] })))
      .toEqual(events.types.map((t) => ({ level: 'types', code: String(t.code).toUpperCase(), change: 'removed' })));

    const checklist = platformDefaultPayload('activation_checklist') as { aspects: (Row & { items: Row[] })[] };
    const aspects = checklist.aspects.map((a, i) => ({
      ...a, displayOrder: i + 1, items: a.items.map((item, j) => ({ ...item, displayOrder: j + 1, autoLink: item.autoLink ?? null })),
    }));
    expect(differencesOf('activation_checklist', itemsOfPayload('activation_checklist', checklist), itemsOfOffice('activation_checklist', { ...empty(), checklist: aspects })))
      .toEqual([]);
  });

  it('P19.4-T1 AC-6 the kinds a request names are applied in Terbitkan semua’s order, each once, and an unknown one is named', () => {
    expect(kindsInOrder(['training_taxonomy', 'activity_taxonomy', 'training_taxonomy'], PUBLISH_ORDER))
      .toEqual({ kinds: ['activity_taxonomy', 'training_taxonomy'], unknown: [] });
    expect(kindsInOrder(['campaign_kinds', 'nonsense'], PUBLISH_ORDER).unknown).toEqual(['campaign_kinds', 'nonsense']);
  });
});

/**
 * **Rows as a store holds them** (P19.4-T1 AC-7; ADR-0208 §4): a template that held none of a kind, a row written before
 * a field existed, a value of another type. Each is compared as provisioning would have written it, so that none of
 * them reads as a change the KPM made, and the push dialog never asks a Super Admin to confirm a change nobody made.
 */
describe('P19.4-T1 what a KPM changed, read from rows as a store holds them (ADR-0208 §4)', () => {
  const kindsWithNoPlatformRows = ['ratio_set', 'lead_pipeline', 'training_taxonomy', 'activation_checklist', 'event_types'] as const;

  it.each(kindsWithNoPlatformRows)('P19.4-T1 AC-7 a template that held no %s gives the office nothing of it', (kind) => {
    const items = itemsOfPayload(kind, null);
    expect(Object.values(items).every((level) => level.size === 0)).toBe(true);
  });

  it('P19.4-T1 AC-7 every row of a kind the template held none of is the KPM’s own addition', () => {
    const office = { ...empty(), ratios: [{ code: 'MINE', label: 'Milik KPM', numerator: ['A'], denominator: ['B'], status: 'active' }] };
    expect(differencesOf('ratio_set', itemsOfPayload('ratio_set', null), itemsOfOffice('ratio_set', office)))
      .toEqual([{ level: 'ratios', code: 'MINE', change: 'added' }]);
  });

  it('P19.4-T1 AC-7 a template that held no activity taxonomy gives the three cascade types and the default binding, as provisioning does', () => {
    expect(differencesOf(
      'activity_taxonomy', itemsOfPayload('activity_taxonomy', null), itemsOfOffice('activity_taxonomy', activityOffice({})),
    )).toEqual([]);
  });

  it('P19.4-T1 AC-7 a ratio a template holds without a display unit is the code’s default unit, as provisioning resolves it', () => {
    const ratios = platformDefaultPayload('ratio_set') as { ratios: Row[] };
    const rows: Row[] = ratios.ratios.map((r) => ({ ...r, status: 'active' }));
    const unitless = { ratios: ratios.ratios.map(({ displayUnit: _unit, ...r }) => r) };
    expect(differencesOf('ratio_set', itemsOfPayload('ratio_set', unitless), itemsOfOffice('ratio_set', { ...empty(), ratios: rows })))
      .toEqual([]);
  });

  it('P19.4-T1 AC-7 a display unit its comparison refuses is compared as it is stored, never resolved away', () => {
    const band = (displayUnit: string) => ({
      code: 'BALANCE', label: 'Balance', numerator: ['A'], denominator: ['B'], benchmark: 30, comparison: 'band', displayUnit,
    });
    const office = { ...empty(), ratios: [{ ...band('points'), status: 'active' }] };
    expect(differencesOf('ratio_set', itemsOfPayload('ratio_set', { ratios: [band('percent')] }), itemsOfOffice('ratio_set', office)))
      .toEqual([{ level: 'ratios', code: 'BALANCE', change: 'changed', fields: ['displayUnit'] }]);
  });

  it('P19.4-T1 AC-7 a row stored without its optional fields compares as empty: a bare ratio, a status with no rank, a row with no status is active', () => {
    const bare = { ...empty(), ratios: [{ code: 'X', label: 'X' }] };
    expect(differencesOf('ratio_set', itemsOfPayload('ratio_set', { ratios: [{ code: 'X', label: 'X' }] }), itemsOfOffice('ratio_set', bare)))
      .toEqual([]);
    bare.ratios[0] = { ...bare.ratios[0], numerator: ['A'] } as never;
    expect(differencesOf('ratio_set', itemsOfPayload('ratio_set', { ratios: [{ code: 'X', label: 'X' }] }), itemsOfOffice('ratio_set', bare)))
      .toEqual([{ level: 'ratios', code: 'X', change: 'changed', fields: ['numerator'] }]);

    const statuses = { statuses: [{ code: 'NEW', label: 'Baru' }] };
    expect(differencesOf('lead_pipeline', itemsOfPayload('lead_pipeline', statuses), itemsOfOffice('lead_pipeline', {
      ...empty(), leadStatuses: [{ code: 'NEW', label: 'Baru' }],
    }))).toEqual([]);
  });

  it('P19.4-T1 AC-7 a label stored as a number compares as its text', () => {
    const statuses = { statuses: [{ pipeline: 'sales', code: 'Y2024', label: '2024', rank: 1 }] };
    expect(differencesOf('lead_pipeline', itemsOfPayload('lead_pipeline', statuses), itemsOfOffice('lead_pipeline', {
      ...empty(), leadStatuses: [{ pipeline: 'sales', code: 'Y2024', label: 2024, rank: 1, status: 'active' }],
    }))).toEqual([]);
  });

  it('P19.4-T1 AC-7 an office’s ladder rows stored without a status, a stage order or grid items read as active and empty', () => {
    const items = itemsOfOffice('capability_ladder', {
      ...empty(),
      capability: {
        stages: [{ code: 'S1', label: 'One', requiredMilestoneCodes: ['M2', 'M1'] }],
        milestones: [{ code: 'M1', label: 'M one' }, { code: 'M2', label: 'M two', status: 'archived' }],
        grids: [{ code: 'G1', label: 'Grid' }],
      },
    });
    expect(Object.fromEntries(items.stages)).toEqual({ S1: { label: 'One', requiredMilestoneCodes: ['M1', 'M2'], stageOrder: null } });
    expect([...items.milestones.keys()]).toEqual(['M1']);
    expect(Object.fromEntries(items.grids)).toEqual({ G1: { label: 'Grid', requiresDownline: false } });
    expect(items.gridItems.size).toBe(0);
  });

  it('P19.4-T1 AC-7 a KPM with no published checklist has removed every aspect and item the template gave it', () => {
    const checklist = platformDefaultPayload('activation_checklist') as { aspects: (Row & { items: Row[] })[] };
    const given = itemsOfPayload('activation_checklist', checklist);
    const differences = differencesOf('activation_checklist', given, itemsOfOffice('activation_checklist', empty()));
    expect(differences).toHaveLength(given.aspects.size + given.items.size);
    expect(differences.every((d) => d.change === 'removed')).toBe(true);
    // An aspect published with no items holds none.
    const bare = itemsOfOffice('activation_checklist', { ...empty(), checklist: [{ code: 'A', label: 'Aspek' }] });
    expect([bare.aspects.size, bare.items.size]).toEqual([1, 0]);
  });

  it('P19.4-T1 AC-7 compares a field by its value: an object whatever its key order, a date by its instant, nothing as null', () => {
    const level = (fields: Record<string, unknown>) => ({ types: new Map([['T', fields]]) });
    const was = level({ autoLink: { kind: 'training', code: 'M' }, at: new Date('2026-01-01T00:00:00Z'), emoji: null });
    expect(differencesOf('event_types', was, level({
      autoLink: { code: 'M', kind: 'training' }, at: new Date('2026-01-01T00:00:00Z'), emoji: undefined,
    }))).toEqual([]);
    expect(differencesOf('event_types', was, level({
      autoLink: { code: 'M', kind: 'training' }, at: new Date('2026-02-01T00:00:00Z'), emoji: null,
    }))).toEqual([{ level: 'types', code: 'T', change: 'changed', fields: ['at'] }]);
  });

  it('P19.4-T1 AC-7 a level missing on either side reads as empty', () => {
    const held = { types: new Map([['T', { label: 'Pelatihan' }]]) };
    expect(differencesOf('event_types', {}, held)).toEqual([{ level: 'types', code: 'T', change: 'added' }]);
    expect(differencesOf('event_types', held, {})).toEqual([{ level: 'types', code: 'T', change: 'removed' }]);
  });

  it('P19.4-T1 AC-8 a module stored without a status, showing the KPM’s own material, is counted', () => {
    expect(ownMaterialDifferences([{ code: 'M1', officeContent: { files: [], videos: [], links: [] } }, { code: 'M2', officeContent: null }]))
      .toEqual([{ level: 'modules', code: 'M1', change: 'changed', fields: ['material'] }]);
  });
});
