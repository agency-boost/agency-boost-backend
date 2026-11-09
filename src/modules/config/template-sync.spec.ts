import type { Message } from '@/common/i18n/sentence';
import { english, indonesian } from '../../../test/i18n';
import { templateSyncDifferences, trainingRevision } from './template-sync';
import { TEMPLATE_SYNC_REFUSALS } from './template-sync.messages';

const office = () => ({
  categories: [{ _id: 'c1', code: 'SALES', label: 'Sales', description: 'Temukan prospek.', version: 1, status: 'active' }],
  skills: [
    { _id: 's1', code: 'PROSPECTING', label: 'Pencarian prospek', description: null, version: 1, status: 'active' },
    { _id: 's2', code: 'KPM_ONLY', label: 'Milik KPM', version: 1, status: 'active' },
    { _id: 's3', code: 'RETIRED', label: 'Lama', version: 2, status: 'archived' },
  ],
  modules: [{ _id: 'm1', code: 'PROSPECT_LIST', title: 'Leads generation: 8 cara', description: null, version: 3, status: 'active' }],
  grids: [{
    code: 'PERSONAL_SELLING', status: 'active',
    items: [{ code: 'LEADS_GEN', label: 'Konsistensi pencarian leads', status: 'active' }, { code: 'OLD', label: 'Lama', status: 'archived' }],
  }],
});

const template = () => ({
  training: {
    categories: [{ code: 'SALES', label: 'Sales', description: 'Temukan prospek.' }],
    skills: [
      { code: 'prospecting', label: ' Leads generation ', description: '8 cara mendapat calon nasabah' },
      { code: 'TEMPLATE_ONLY', label: 'Hanya template' },
      { code: 'RETIRED', label: 'Baru' },
    ],
    modules: [{ code: 'PROSPECT_LIST', title: 'Leads generation', description: '8 cara' }],
  },
  capability: {
    grids: [{ code: 'PERSONAL_SELLING', items: [{ code: 'LEADS_GEN', label: 'Leads generation' }, { code: 'OLD', label: 'Baru' }] }],
  },
});

/** *Sinkron dari template*, the pure half (P19.6-T4, ADR-0220 §4). */
describe('P19.6-T4 what a KPM would take from its template, by code', () => {
  it('P19.6-T4 AC-3 lists names and descriptions that differ, on items in both and active in the KPM, in the dialog’s order', () => {
    expect(templateSyncDifferences(template(), office())).toEqual([
      { level: 'skill', code: 'PROSPECTING', field: 'name', from: 'Pencarian prospek', to: 'Leads generation' },
      { level: 'skill', code: 'PROSPECTING', field: 'description', from: null, to: '8 cara mendapat calon nasabah' },
      { level: 'module', code: 'PROSPECT_LIST', field: 'name', from: 'Leads generation: 8 cara', to: 'Leads generation' },
      { level: 'module', code: 'PROSPECT_LIST', field: 'description', from: null, to: '8 cara' },
      { level: 'capability_item', code: 'PERSONAL_SELLING:LEADS_GEN', field: 'name', from: 'Konsistensi pencarian leads', to: 'Leads generation' },
    ]);
  });

  it('P19.6-T4 AC-2 a row from before the split (no description) reads split, so it differs from a split template in nothing', () => {
    const rows = office();
    delete (rows.modules[0] as { description?: unknown }).description;
    expect(templateSyncDifferences(template(), rows).filter((d) => d.level === 'module')).toEqual([]);
  });

  it('P19.6-T4 AC-3 a template without a kind gives nothing of it; a template description of none clears the KPM’s', () => {
    expect(templateSyncDifferences({ training: null, capability: null }, office())).toEqual([]);
    const t = template();
    t.training.categories[0].description = '';
    expect(templateSyncDifferences({ training: t.training, capability: null }, office()))
      .toContainEqual({ level: 'category', code: 'SALES', field: 'description', from: 'Temukan prospek.', to: null });
  });

  it('P19.6-T4 AC-5 capability items are compared by name only: they have no description', () => {
    const found = templateSyncDifferences({ training: null, capability: template().capability }, office());
    expect(found.every((d) => d.level === 'capability_item' && d.field === 'name')).toBe(true);
  });

  it('P19.6-T4 AC-3 reads a row stored without a status as active, a missing text as none, and a missing list as empty', () => {
    const rows = {
      categories: [{ _id: 'c1', code: 'SALES', label: 'Sales' }],
      skills: [{ _id: 's1', code: 'PROSPECTING', label: 'Pencarian prospek', description: null }],
      modules: [],
      grids: [{ code: 'PERSONAL_SELLING', items: [{ code: 'LEADS_GEN', label: 'Konsistensi' }] }, { code: 'EMPTY' }],
    };
    expect(templateSyncDifferences({
      // A category with no description against the KPM's with none: nothing to take. No skills or modules list at all.
      training: { categories: [{ code: 'SALES', label: 'Sales', description: null }] },
      capability: { grids: [{ code: 'PERSONAL_SELLING', items: [{ code: 'LEADS_GEN', label: 'Leads generation' }] }, { code: 'EMPTY' }] },
    }, rows)).toEqual([
      { level: 'capability_item', code: 'PERSONAL_SELLING:LEADS_GEN', field: 'name', from: 'Konsistensi', to: 'Leads generation' },
    ]);
    // A template name that is no text is no name to take: the KPM's stays.
    expect(templateSyncDifferences({ training: { categories: [{ code: 'SALES', label: 42 }] }, capability: null }, rows)).toEqual([]);
  });

  it('P19.6-T4 AC-3 the revision reads a row’s id where it has no _id, and a KPM with no capability catalogue has one too', () => {
    const rows = office();
    const byId = (list: Record<string, unknown>[]) => list.map(({ _id, ...r }) => ({ ...r, id: _id }));
    const withUnderscore = trainingRevision({ categories: rows.categories, skills: rows.skills, modules: rows.modules, catalog: { _id: 'cap', version: 1 } });
    expect(trainingRevision({
      categories: byId(rows.categories), skills: byId(rows.skills), modules: byId(rows.modules), catalog: { id: 'cap', version: 1 },
    })).toBe(withUnderscore);
    const none = trainingRevision({ categories: rows.categories, skills: rows.skills, modules: rows.modules, catalog: null });
    expect(none).toMatch(/^[0-9a-f]{16}$/);
    expect(none).not.toBe(withUnderscore);
  });

  it('P19.6-T4 AC-3 the revision moves on any version or status, and not on a reorder', () => {
    const rows = office();
    const at = (o: ReturnType<typeof office>, catalog: Record<string, unknown> | null = { _id: 'cap', version: 1 }) =>
      trainingRevision({ categories: o.categories, skills: o.skills, modules: o.modules, catalog });
    const first = at(rows);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(at({ ...rows, skills: [...rows.skills].reverse() })).toBe(first);
    expect(at({ ...rows, modules: [{ ...rows.modules[0], version: 4 }] })).not.toBe(first);
    expect(at({ ...rows, skills: rows.skills.map((s) => ({ ...s, status: 'archived' })) })).not.toBe(first);
    expect(at(rows, { _id: 'cap', version: 2 })).not.toBe(first);
  });
});

const REFUSALS: [string, Message][] = [
  ['VALIDATION_FAILED.noTemplate', TEMPLATE_SYNC_REFUSALS.VALIDATION_FAILED.noTemplate],
  ['VERSION_CONFLICT.templateMoved', TEMPLATE_SYNC_REFUSALS.VERSION_CONFLICT.templateMoved],
  ['VERSION_CONFLICT.trainingMoved', TEMPLATE_SYNC_REFUSALS.VERSION_CONFLICT.trainingMoved],
];

describe('P19.6-T4 the sync’s refusals, in both languages', () => {
  it.each(REFUSALS)('P19.6-T4 AC-3 %s is said in English and in Indonesian', (_entry, sentence) => {
    expect(english(sentence)).toBeTruthy();
    expect(indonesian(sentence)).toBeTruthy();
    expect(indonesian(sentence)).not.toBe(english(sentence));
  });

  it('P19.6-T4 AC-3 has a case for every entry of the catalogue', () => {
    const filed = Object.entries(TEMPLATE_SYNC_REFUSALS).flatMap(([code, section]) => Object.keys(section).map((n) => `${code}.${n}`));
    expect(REFUSALS.map(([entry]) => entry).sort()).toEqual(filed.sort());
  });
});
