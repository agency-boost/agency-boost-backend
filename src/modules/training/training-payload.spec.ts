import { SEED_TRAINING_CATEGORIES, SEED_TRAINING_MODULES, SEED_TRAINING_SKILLS } from '@/domain/constants';
import {
  defaultTrainingTaxonomy, trainingSeedDocuments, trainingTaxonomyProblems,
} from './training-payload';

/** A `training_taxonomy` payload: its defaults, what breaks one, and the rows it seeds (P5-T1). */
describe('the training taxonomy payload', () => {
  it('starts from the domain defaults, which pass their own check', () => {
    const payload = defaultTrainingTaxonomy();
    expect(payload.categories).toHaveLength(SEED_TRAINING_CATEGORIES.length);
    expect(payload.skills).toHaveLength(SEED_TRAINING_SKILLS.length);
    expect(payload.modules).toHaveLength(SEED_TRAINING_MODULES.length);
    expect(trainingTaxonomyProblems(payload)).toEqual([]);
  });

  it('accepts an empty taxonomy — a company may publish nothing under a category yet', () => {
    expect(trainingTaxonomyProblems({ categories: [], skills: [], modules: [] })).toEqual([]);
  });

  it('names every problem: a missing list, a row its checker refuses, a code twice, a reference to nothing', () => {
    expect(trainingTaxonomyProblems(undefined)).toEqual([
      'categories must be a list.', 'skills must be a list.', 'modules must be a list.',
    ]);

    const problems = trainingTaxonomyProblems({
      categories: [{ code: 'SALES', label: 'Sales' }, { code: 'sales', label: 'Again' }, { code: 'no', label: 'x' }],
      skills: [{ code: 'LOST', categoryCode: 'NOWHERE', label: 'Lost' }],
      modules: [{ code: 'ORPHAN', skillCode: 'MISSING', title: 'Orphan' }, { code: 'EMPTY', skillCode: 'LOST', title: '' }],
    });
    expect(problems).toEqual([
      'The category code SALES is used twice.',
      expect.stringContaining('Category 3: code: A code is'),
      'Module 2: title must be 1–200 characters.',
      'The skill LOST names NOWHERE, which no category in this taxonomy is.',
      'The module ORPHAN names MISSING, which no skill in this taxonomy is.',
    ]);
  });

  it('seeds rows numbered within their parent, with codes normalised and a draft as the default', () => {
    const rows = trainingSeedDocuments('kpm-1', {
      categories: [{ code: ' a_one ', label: ' A ', description: ' About A ' }, { code: 'B_TWO', label: 'B' }],
      skills: [
        { code: 'S_ONE', categoryCode: 'a_one', label: 'S1' },
        { code: 'S_TWO', categoryCode: 'B_TWO', label: 'S2' },
        { code: 'S_THREE', categoryCode: 'A_ONE', label: 'S3' },
      ],
      modules: [
        { code: 'M_ONE', skillCode: 'S_THREE', title: ' M1 ' },
        { code: 'M_TWO', skillCode: 's_three', title: 'M2', publishState: 'published' },
      ],
    });

    expect(rows.categories.map((c) => [c.code, c.label, c.description, c.displayOrder]))
      .toEqual([['A_ONE', 'A', 'About A', 1], ['B_TWO', 'B', null, 2]]);
    expect(rows.skills.map((s) => [s.code, s.categoryCode, s.displayOrder]))
      .toEqual([['S_ONE', 'A_ONE', 1], ['S_TWO', 'B_TWO', 1], ['S_THREE', 'A_ONE', 2]]);
    expect(rows.modules.map((m) => [m.code, m.skillCode, m.title, m.publishState, m.displayOrder]))
      .toEqual([['M_ONE', 'S_THREE', 'M1', 'draft', 1], ['M_TWO', 'S_THREE', 'M2', 'published', 2]]);
    expect(rows.modules[0]).toMatchObject({
      kpmId: 'kpm-1', version: 1, status: 'active', archivedAt: null, deletedAt: null,
    });
  });
});
