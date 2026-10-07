import {
  filesOfTraining, rungCodesOf, templateKindsFromOffice, withCopiedFiles, type OfficeSettings,
} from './office-template';

/**
 * **What crosses when an office's settings become a template** (P13.2-T7 AC-2, ADR-0115 §5): the pure
 * half — what agents read, never the draft, never anything archived, codes kept.
 */
const file = (key: string, label = key) => ({ id: `f-${key}`, label, storageKey: key, mimeType: 'application/pdf', bytes: 10 });
type Rows = Record<string, unknown>[];

function settings(over: Partial<OfficeSettings> = {}): OfficeSettings {
  return {
    snapshot: {
      activity: [
        {
          code: 'SELLING', label: 'Penjualan', description: 'Jual', displayOrder: 2, status: 'active',
          summaryGroupCode: null, summaryGroupLabel: null, appliesToOrgLevelCodes: ['AB'],
          types: [
            { code: 'SELL_SUBMISSION', label: 'SPAJ', description: null, displayOrder: 2, status: 'active' },
            { code: 'SELL_PRESENTATION', label: 'Presentasi', description: null, displayOrder: 1, status: 'active' },
          ],
        },
        {
          code: 'LEADS_GENERATION', label: 'Prospek', description: null, displayOrder: 1, status: 'active',
          types: [{ code: 'LEADS_CONTACTED', label: 'Dihubungi', description: 'x', displayOrder: 1, status: 'active' }],
        },
      ],
      ratios: [{
        code: 'CLOSING', label: 'Closing', numerator: ['SELL_SUBMISSION'], denominator: ['SELL_PRESENTATION'],
        benchmark: 0.3, comparison: 'gte', displayUnit: 'ratio', displayOrder: 1, status: 'active',
        appliesToOrgLevelCodes: ['AAB', 'AB'], origin: 'platform', divergesFromStandard: false,
      }],
      leadPipelines: [
        { pipeline: 'sales', statuses: [{ pipeline: 'sales', code: 'NEW', label: 'Baru', rank: 1, isTerminal: true, isLateStage: false, status: 'active' }] },
        { pipeline: 'recruitment', statuses: [] },
      ],
      // As `TrainingService.offered` renders it into the snapshot: nested, each row with its status.
      training: [
        {
          code: 'CAT', label: 'Cat', description: null, displayOrder: 1, status: 'active',
          skills: [{
            code: 'SK', categoryCode: 'CAT', label: 'Skill', displayOrder: 1, status: 'active',
            modules: [
              { code: 'MOD_B', skillCode: 'SK', title: 'B', publishState: 'published', displayOrder: 2, status: 'active' },
              { code: 'MOD_A', skillCode: 'SK', title: 'A', publishState: 'published', displayOrder: 1, status: 'active' },
              { code: 'MOD_DRAFT', skillCode: 'SK', title: 'Draft', publishState: 'draft', displayOrder: 3, status: 'active' },
              { code: 'MOD_GONE', skillCode: 'SK', title: 'Gone', publishState: 'published', displayOrder: 4, status: 'archived' },
            ],
          }],
        },
        {
          code: 'OLD', label: 'Old', description: null, displayOrder: 2, status: 'archived',
          skills: [{
            code: 'SK_OLD', categoryCode: 'OLD', label: 'Under archived', displayOrder: 1, status: 'active',
            modules: [{ code: 'MOD_ORPHAN', skillCode: 'SK_OLD', title: 'Orphan', publishState: 'published', displayOrder: 1, status: 'active' }],
          }],
        },
      ],
      // `SnapshotEventTypeView`: active rows only, and no status.
      eventTypes: [
        { code: 'TRAINING', label: 'Pelatihan', description: null, emoji: '🎓', color: '#2D9CDB', displayOrder: 2 },
      ],
      capability: {
        stages: [
          { code: 'S1', label: 'One', requiredMilestoneCodes: ['M1'], stageOrder: 1, displayOrder: 1, status: 'active' },
          { code: 'S_OLD', label: 'Old', requiredMilestoneCodes: ['M1'], stageOrder: 2, displayOrder: 2, status: 'archived' },
        ],
        milestones: [
          { code: 'M1', label: 'M one', displayOrder: 1, status: 'active' },
          { code: 'M_OLD', label: 'M old', displayOrder: 2, status: 'archived' },
        ],
        grids: [
          { code: 'G1', label: 'G', displayOrder: 1, status: 'active', items: [
            { code: 'I1', label: 'i', displayOrder: 1, status: 'active' },
            { code: 'I_OLD', label: 'old', displayOrder: 2, status: 'archived' },
          ] },
        ],
        version: 3,
      },
    },
    checklist: {
      aspects: [
        { code: 'B', label: 'Second', displayOrder: 2, items: [{ code: 'B1', label: 'b', displayOrder: 1, autoLink: null }] },
        { code: 'A', label: 'First', displayOrder: 1, items: [
          { code: 'A2', label: 'a2', displayOrder: 2, autoLink: 'training:MOD_A' },
          { code: 'A1', label: 'a1', displayOrder: 1 },
        ] },
      ],
    },
    moduleContent: [
      { code: 'MOD_A', companyContent: { files: [file('co/1')], videos: [], links: [] }, officeContent: null },
      {
        code: 'MOD_B',
        companyContent: { files: [file('co/2')] },
        officeContent: { files: [file('kpm/9', 'Ours')], videos: [file('kpm/v')], links: [{ id: 'l', label: 'Link', url: 'https://x.test' }] },
      },
      // Read for a code the snapshot does not offer: never used.
      { code: 'MOD_DRAFT', companyContent: { files: [file('co/draft')] }, officeContent: null },
    ],
    ...over,
  };
}

/** The settings with one part of the snapshot replaced. */
const withSnapshot = (patch: Record<string, unknown>) => {
  const s = settings();
  return { ...s, snapshot: { ...s.snapshot!, ...patch } };
};

describe('templateKindsFromOffice (P13.2-T7 AC-2)', () => {
  it('takes the taxonomy, ratios and pipelines from the snapshot, in display order, codes kept', () => {
    const { kinds } = templateKindsFromOffice(settings());
    expect(kinds.activity_taxonomy).toEqual({
      categories: [
        expect.objectContaining({ code: 'LEADS_GENERATION', label: 'Prospek', appliesToOrgLevelCodes: [] }),
        expect.objectContaining({ code: 'SELLING', description: 'Jual', appliesToOrgLevelCodes: ['AB'] }),
      ],
      types: [
        { code: 'LEADS_CONTACTED', categoryCode: 'LEADS_GENERATION', label: 'Dihubungi', description: 'x', displayOrder: 1 },
        { code: 'SELL_PRESENTATION', categoryCode: 'SELLING', label: 'Presentasi', description: null, displayOrder: 1 },
        { code: 'SELL_SUBMISSION', categoryCode: 'SELLING', label: 'SPAJ', description: null, displayOrder: 2 },
      ],
    });
    // A ratio as a template holds it: no office bookkeeping (origin, divergence) comes with it.
    expect(kinds.ratio_set).toEqual({ ratios: [{
      code: 'CLOSING', label: 'Closing', numerator: ['SELL_SUBMISSION'], denominator: ['SELL_PRESENTATION'],
      benchmark: 0.3, comparison: 'gte', displayUnit: 'ratio', displayOrder: 1, appliesToOrgLevelCodes: ['AAB', 'AB'],
    }] });
    expect(kinds.lead_pipeline).toEqual({ statuses: [
      { pipeline: 'sales', code: 'NEW', label: 'Baru', rank: 1, isTerminal: true, isLateStage: false },
    ] });
  });

  it('leaves out anything archived: a type, a section, a ratio, a stage', () => {
    const s = settings();
    const activity = (s.snapshot!.activity as Rows);
    (activity[0].types as Rows)[0].status = 'archived';
    activity.push({ code: 'GONE', label: 'Gone', displayOrder: 3, status: 'archived', types: [] });
    (s.snapshot!.ratios as Rows).push({ code: 'OLD', status: 'archived', numerator: [], denominator: [] });
    const { kinds } = templateKindsFromOffice(s);
    const taxonomy = kinds.activity_taxonomy as { categories: { code: string }[]; types: { code: string }[] };
    expect(taxonomy.categories.map((c) => c.code)).toEqual(['LEADS_GENERATION', 'SELLING']);
    expect(taxonomy.types.map((t) => t.code)).not.toContain('SELL_SUBMISSION');
    expect((kinds.ratio_set as { ratios: { code: string }[] }).ratios.map((r) => r.code)).toEqual(['CLOSING']);
  });

  it('takes the published checklist in display order, with its links', () => {
    expect(templateKindsFromOffice(settings()).kinds.activation_checklist).toEqual({ aspects: [
      { code: 'A', label: 'First', items: [
        { code: 'A1', label: 'a1', autoLink: null }, { code: 'A2', label: 'a2', autoLink: 'training:MOD_A' },
      ] },
      { code: 'B', label: 'Second', items: [{ code: 'B1', label: 'b', autoLink: null }] },
    ] });
  });

  it('takes the training agents are offered, each module with the content they are shown', () => {
    const { kinds, files } = templateKindsFromOffice(settings());
    const training = kinds.training_taxonomy as {
      categories: { code: string }[]; skills: { code: string }[];
      modules: { code: string; publishState: string; content?: Record<string, { storageKey?: string; url?: string }[]> }[];
    };
    expect(training.categories.map((c) => c.code)).toEqual(['CAT']);
    expect(training.skills.map((s) => s.code)).toEqual(['SK']);
    // Never a draft, an archived module, or one under an archived section; in display order.
    expect(training.modules.map((m) => m.code)).toEqual(['MOD_A', 'MOD_B']);
    expect(training.modules.every((m) => m.publishState === 'published')).toBe(true);
    // The office's replacement where it has one, else the company's; links as links.
    expect(training.modules[0].content!.files.map((f) => f.storageKey)).toEqual(['co/1']);
    expect(training.modules[1].content!.files.map((f) => f.storageKey)).toEqual(['kpm/9']);
    expect(training.modules[1].content!.links).toEqual([{ id: 'l', label: 'Link', url: 'https://x.test' }]);
    expect(files).toEqual([
      { storageKey: 'co/1', label: 'co/1', moduleCode: 'MOD_A', owner: 'company' },
      { storageKey: 'kpm/9', label: 'Ours', moduleCode: 'MOD_B', owner: 'office' },
      { storageKey: 'kpm/v', label: 'kpm/v', moduleCode: 'MOD_B', owner: 'office' },
    ]);
  });

  it('takes the event types and the capability ladder with nothing archived in it — all from the snapshot', () => {
    const { kinds, dropped } = templateKindsFromOffice(settings());
    expect(kinds.event_types).toEqual({ types: [
      { code: 'TRAINING', label: 'Pelatihan', description: null, emoji: '🎓', color: '#2D9CDB' },
    ] });
    expect(kinds.capability_ladder).toEqual({
      stages: [{ code: 'S1', label: 'One', requiredMilestoneCodes: ['M1'], stageOrder: 1 }],
      milestones: [{ code: 'M1', label: 'M one' }],
      grids: [{ code: 'G1', label: 'G', requiresDownline: false, items: [{ code: 'I1', label: 'i' }] }],
    });
    expect(dropped).toEqual([]);
  });

  it('leaves a kind the office holds nothing of out — the template holds it empty', () => {
    const { kinds, files, dropped } = templateKindsFromOffice({ snapshot: null, checklist: null, moduleContent: [] });
    expect(kinds).toEqual({});
    expect(files).toEqual([]);
    expect(dropped).toEqual([]);
    // A snapshot published before a phase added a field carries none of it: its agents are offered nothing.
    const old = templateKindsFromOffice(withSnapshot({ training: undefined, eventTypes: undefined, capability: undefined }));
    expect(old.kinds).not.toHaveProperty('training_taxonomy');
    expect(old.kinds).not.toHaveProperty('event_types');
    expect(old.kinds).not.toHaveProperty('capability_ladder');
    expect(templateKindsFromOffice(settings({ checklist: { aspects: [] } })).kinds).not.toHaveProperty('activation_checklist');
  });
});

/**
 * **Exit review of P13.2, finding 1** — the Owner's unpublished edits never reach a template. The staged
 * batch writes the live rows before Publish; the input here has no field for them to arrive in, so what is
 * not in the snapshot is not in the template, whatever the live rows hold.
 */
describe('never the Owner’s unpublished edits (exit review, finding 1)', () => {
  it('a module, an event type or a capability item the snapshot does not hold never reaches the template', () => {
    const s = settings({
      // Live content for a module created and published-as-a-module after the office's last Publish.
      moduleContent: [...settings().moduleContent, { code: 'MOD_NEW', companyContent: { files: [file('co/new')] } }],
    });
    const { kinds, files } = templateKindsFromOffice(s);
    const json = JSON.stringify(kinds);
    expect(json).not.toContain('MOD_NEW');
    expect(json).not.toContain('MOD_DRAFT');
    expect(files.map((f) => f.storageKey)).not.toContain('co/new');
    expect(files.map((f) => f.storageKey)).not.toContain('co/draft');
    expect((kinds.event_types as { types: { code: string }[] }).types.map((t) => t.code)).toEqual(['TRAINING']);
  });

  it('a module the snapshot offers with no live row is copied with no content, never refused', () => {
    const { kinds } = templateKindsFromOffice(settings({ moduleContent: [] }));
    const modules = (kinds.training_taxonomy as { modules: { code: string; content?: unknown }[] }).modules;
    expect(modules).toEqual([
      { code: 'MOD_A', skillCode: 'SK', title: 'A', publishState: 'published' },
      { code: 'MOD_B', skillCode: 'SK', title: 'B', publishState: 'published' },
    ]);
  });
});

/**
 * **Exit review of P13.2, finding 2** — what archiving left behind is dropped and said, never refused: each
 * is a state an office may legally be in, and an office made from the template could not be given it.
 */
describe('what archiving left behind is dropped, and listed (exit review, finding 2)', () => {
  const ratio = (code: string, numerator: string[], denominator: string[]) => ({
    code, label: code, numerator, denominator, benchmark: 0.3, comparison: 'gte', displayUnit: 'ratio',
    displayOrder: 1, status: 'active', appliesToOrgLevelCodes: [],
  });

  it('takes an archived activity type out of a ratio, keeping the ratio', () => {
    const { kinds, dropped } = templateKindsFromOffice(withSnapshot({
      ratios: [ratio('CLOSING', ['SELL_SUBMISSION', 'OLD_VISIT'], ['SELL_PRESENTATION'])],
    }));
    expect((kinds.ratio_set as { ratios: Rows }).ratios[0]).toMatchObject({
      code: 'CLOSING', numerator: ['SELL_SUBMISSION'], denominator: ['SELL_PRESENTATION'],
    });
    expect(dropped).toEqual([{
      kind: 'ratio_set', code: 'CLOSING',
      reason: 'Ratio CLOSING no longer counts OLD_VISIT, which is not an active activity type in this office.',
    }]);
  });

  it('leaves a ratio out when a side is left counting nothing, and the kind out when no ratio is left', () => {
    const { kinds, dropped } = templateKindsFromOffice(withSnapshot({
      ratios: [ratio('VISITS', ['OLD_VISIT', 'OLD_CALL'], ['SELL_PRESENTATION'])],
    }));
    expect(kinds).not.toHaveProperty('ratio_set');
    expect(dropped).toEqual([{
      kind: 'ratio_set', code: 'VISITS',
      reason: 'Ratio VISITS was left out: its numerator counts only OLD_VISIT, OLD_CALL, which are not '
        + 'active activity types in this office.',
    }]);
  });

  it('counts a cascade type every office is given as present, though the snapshot lacks it', () => {
    const s = withSnapshot({ ratios: [ratio('CONTACT', ['LEADS_CONTACTED'], ['SELL_SUBMISSION'])] });
    (s.snapshot.activity as Rows).splice(1, 1); // LEADS_GENERATION, and LEADS_CONTACTED with it
    const { kinds, dropped } = templateKindsFromOffice(s);
    expect((kinds.ratio_set as { ratios: Rows }).ratios[0]).toMatchObject({ numerator: ['LEADS_CONTACTED'] });
    expect(dropped).toEqual([]);
  });

  it('takes a stage’s archived milestones out of its requirement, and the stage out when none is left', () => {
    const { kinds, dropped } = templateKindsFromOffice(withSnapshot({
      capability: {
        stages: [
          { code: 'S1', label: 'One', requiredMilestoneCodes: ['M1', 'M_OLD'], stageOrder: 1, displayOrder: 1, status: 'active' },
          { code: 'S2', label: 'Two', requiredMilestoneCodes: ['M_OLD'], stageOrder: 2, displayOrder: 2, status: 'active' },
        ],
        milestones: [
          { code: 'M1', label: 'M one', displayOrder: 1, status: 'active' },
          { code: 'M_OLD', label: 'M old', displayOrder: 2, status: 'archived' },
        ],
        grids: [
          { code: 'G1', label: 'G', displayOrder: 1, status: 'active', items: [{ code: 'I1', label: 'i', displayOrder: 1, status: 'active' }] },
          { code: 'G_EMPTY', label: 'E', displayOrder: 2, status: 'active', items: [{ code: 'I2', label: 'x', displayOrder: 1, status: 'archived' }] },
        ],
      },
    }));
    expect(kinds.capability_ladder).toEqual({
      stages: [{ code: 'S1', label: 'One', requiredMilestoneCodes: ['M1'], stageOrder: 1 }],
      milestones: [{ code: 'M1', label: 'M one' }],
      grids: [{ code: 'G1', label: 'G', requiresDownline: false, items: [{ code: 'I1', label: 'i' }] }],
    });
    expect(dropped).toEqual([
      { kind: 'capability_ladder', code: 'S1', reason: 'Stage S1 no longer requires M_OLD, which is archived in this office.' },
      {
        kind: 'capability_ladder', code: 'S2',
        reason: 'Stage S2 was left out: every milestone it requires (M_OLD) is archived in this office, so an '
          + 'office made from the template would put everybody on it.',
      },
      { kind: 'capability_ladder', code: 'G_EMPTY', reason: 'Grid G_EMPTY was left out: every item in it is archived in this office.' },
    ]);
  });

  it('leaves the whole ladder out when no stage is left to place anybody on, and says so', () => {
    const { kinds, dropped } = templateKindsFromOffice(withSnapshot({
      capability: {
        stages: [{ code: 'S1', label: 'One', requiredMilestoneCodes: ['M_OLD'], stageOrder: 1, displayOrder: 1, status: 'active' }],
        milestones: [{ code: 'M_OLD', label: 'M old', displayOrder: 1, status: 'archived' }],
        grids: [{ code: 'G1', label: 'G', displayOrder: 1, status: 'active', items: [{ code: 'I1', label: 'i', displayOrder: 1, status: 'active' }] }],
      },
    }));
    expect(kinds).not.toHaveProperty('capability_ladder');
    expect(dropped.map((d) => [d.kind, d.code])).toEqual([['capability_ladder', 'S1'], ['capability_ladder', null]]);
    expect(dropped[1].reason).toBe(
      'The capability ladder was left out: it has no active stage left, so an office made from the template could place nobody on it.',
    );
  });

  it('keeps a checklist item linking to a module no longer offered, as a manual item', () => {
    const s = settings();
    s.checklist!.aspects[0].items[0].autoLink = 'training:MOD_GONE';
    s.checklist!.aspects[1].items.push({ code: 'A3', label: 'feature', displayOrder: 3, autoLink: 'feature:leads' });
    const { kinds, dropped } = templateKindsFromOffice(s);
    const aspects = (kinds.activation_checklist as { aspects: { items: Rows }[] }).aspects;
    expect(aspects[1].items).toEqual([{ code: 'B1', label: 'b', autoLink: null }]);
    // A feature link, and a link to a module still offered, are kept as they were.
    expect(aspects[0].items.map((i) => i.autoLink)).toEqual([null, 'training:MOD_A', 'feature:leads']);
    expect(dropped).toEqual([{
      kind: 'activation_checklist', code: 'B1',
      reason: 'Checklist item B1 is kept as a manual item: the training module MOD_GONE it linked to is not offered in this office.',
    }]);
  });

  it('drops every training link when the office is offered no training at all', () => {
    const { kinds, dropped } = templateKindsFromOffice(withSnapshot({ training: [] }));
    expect(kinds).not.toHaveProperty('training_taxonomy');
    expect(JSON.stringify(kinds.activation_checklist)).not.toContain('training:');
    expect(dropped.map((d) => d.code)).toEqual(['A2']);
  });
});

describe('the files and rungs a template names (P13.2-T7 AC-3, AC-4)', () => {
  const training = {
    categories: [], skills: [],
    modules: [
      { code: 'M1', skillCode: 'S', title: 'x', content: { files: [file('a')], videos: [file('v')], links: [{ id: 'l', label: 'L', url: 'u' }] } },
      { code: 'M2', skillCode: 'S', title: 'y' },
    ],
  };

  it('lists every file and video, as the company’s', () => {
    expect(filesOfTraining(training)).toEqual([
      { storageKey: 'a', label: 'a', moduleCode: 'M1', owner: 'company' },
      { storageKey: 'v', label: 'v', moduleCode: 'M1', owner: 'company' },
    ]);
    expect(filesOfTraining(undefined)).toEqual([]);
  });

  it('points each copied file at its copy, and leaves the rest and every link as they were', () => {
    const copied = withCopiedFiles(training, new Map([['a', { storageKey: 'b', mimeType: 'image/png', bytes: 99 }]])) as typeof training;
    expect(copied.modules[0].content!.files).toEqual([{ ...file('a'), storageKey: 'b', mimeType: 'image/png', bytes: 99 }]);
    expect(copied.modules[0].content!.videos).toEqual([file('v')]);
    expect(copied.modules[0].content!.links).toEqual([{ id: 'l', label: 'L', url: 'u' }]);
    expect(copied.modules[1]).toEqual(training.modules[1]);
    // The source payload is not touched.
    expect(training.modules[0].content!.files[0].storageKey).toBe('a');
  });

  it('collects every rung a ratio or a section is shown to, once, upper-cased', () => {
    expect(rungCodesOf({
      ratio_set: { ratios: [{ appliesToOrgLevelCodes: ['ab', 'AAB'] }, { appliesToOrgLevelCodes: [] }, {}] },
      activity_taxonomy: { categories: [{ appliesToOrgLevelCodes: ['SM', ' '] }, {}] },
    })).toEqual(['AAB', 'AB', 'SM']);
    expect(rungCodesOf({})).toEqual([]);
  });
});
