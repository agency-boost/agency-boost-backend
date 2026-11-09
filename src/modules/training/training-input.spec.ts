import {
  checkTrainingCategoryCreate, checkTrainingCategoryUpdate, checkTrainingModuleCreate,
  checkTrainingModuleUpdate, checkTrainingSkillCreate, checkTrainingSkillUpdate,
} from './training-input';

const long = (length: number) => 'x'.repeat(length);

/** The refusal's violations, or `null` when the checker accepts. */
function violations(check: () => unknown): string[] | null {
  try {
    check();
    return null;
  } catch (err) {
    return (err as { details: { violations: string[] } }).details.violations;
  }
}

/** What a write to an office's training taxonomy may contain (P5-T1, ADR-0030). */
describe('training field rules', () => {
  it('normalises what it accepts', () => {
    expect(checkTrainingCategoryCreate({ code: ' onboarding ', label: ' Onboarding ', description: '  ' }))
      .toEqual({ code: 'ONBOARDING', label: 'Onboarding', description: null });
    expect(checkTrainingSkillCreate({ code: 'first_week', categoryCode: 'onboarding', label: 'First week' }))
      .toEqual({ code: 'FIRST_WEEK', categoryCode: 'ONBOARDING', label: 'First week', description: null });
    expect(checkTrainingSkillUpdate({ categoryCode: 'sales' })).toEqual({ categoryCode: 'SALES' });
    expect(checkTrainingModuleUpdate({ title: ' New ', publishState: 'published', skillCode: 'closing' }))
      .toEqual({ title: 'New', publishState: 'published', skillCode: 'CLOSING' });
    expect(checkTrainingCategoryUpdate({})).toEqual({});
  });

  it('makes a new module a draft unless it is told otherwise', () => {
    expect(checkTrainingModuleCreate({ code: 'WELCOME', skillCode: 'FIRST_WEEK', title: 'Welcome' }).publishState)
      .toBe('draft');
    expect(checkTrainingModuleCreate({
      code: 'WELCOME', skillCode: 'FIRST_WEEK', title: 'Welcome', publishState: 'published',
    }).publishState).toBe('published');
  });

  it.each([
    ['a category label', () => checkTrainingCategoryUpdate({ label: long(80) }),
      () => checkTrainingCategoryUpdate({ label: long(81) }), 'label must be 1–80 characters.'],
    ['a description', () => checkTrainingCategoryUpdate({ description: long(200) }),
      () => checkTrainingCategoryUpdate({ description: long(201) }), 'description must be at most 200 characters.'],
    ['a skill label', () => checkTrainingSkillUpdate({ label: long(80) }),
      () => checkTrainingSkillUpdate({ label: long(81) }), 'label must be 1–80 characters.'],
    ['a module title', () => checkTrainingModuleUpdate({ title: long(200) }),
      () => checkTrainingModuleUpdate({ title: long(201) }), 'title must be 1–200 characters.'],
  ])('holds %s at its edge', (_name, atTheEdge, overIt, violation) => {
    expect(violations(atTheEdge)).toBeNull();
    expect(violations(overIt)).toEqual([violation]);
  });

  it('refuses what a write cannot be, every field at once', () => {
    expect(violations(() => checkTrainingModuleCreate({ code: '1x', title: 7, publishState: 'live', colour: 'red' })))
      .toEqual([
        'property colour should not exist',
        expect.stringContaining('code: A code is 3–40 characters'),
        'skillCode is required.',
        'title must be text.',
        'publishState must be one of draft, published.',
      ]);
    expect(violations(() => checkTrainingSkillCreate({ code: 'OK_ONE', label: 'x' })))
      .toEqual(['categoryCode is required.']);
    expect(violations(() => checkTrainingCategoryCreate({ code: 'OK_ONE' }))).toEqual(['label is required.']);
    // A code is the identity, so no update carries one.
    expect(violations(() => checkTrainingModuleUpdate({ code: 'NEW_CODE' })))
      .toEqual(['property code should not exist']);
  });
});

/** P19.6-T4 (ADR-0220 §1; UI-161): a skill's and a module's *Deskripsi singkat*. */
describe('short descriptions (P19.6-T4)', () => {
  it('P19.6-T4 AC-1 takes a description on a skill and a module, trimmed, plain text, blank or null clearing it', () => {
    expect(checkTrainingSkillCreate({
      code: 'LEADS_GEN', categoryCode: 'SALES', label: 'Leads generation', description: '  8 cara <b>mendapat</b> calon nasabah ',
    })).toEqual({
      code: 'LEADS_GEN', categoryCode: 'SALES', label: 'Leads generation', description: '8 cara mendapat calon nasabah',
    });
    expect(checkTrainingModuleCreate({ code: 'LEADS_101', skillCode: 'LEADS_GEN', title: 'Leads', description: 'Satu baris' }))
      .toMatchObject({ description: 'Satu baris' });
    expect(checkTrainingModuleCreate({ code: 'LEADS_101', skillCode: 'LEADS_GEN', title: 'Leads' }))
      .toMatchObject({ description: null });
    expect(checkTrainingSkillUpdate({ description: '   ' })).toEqual({ description: null });
    expect(checkTrainingModuleUpdate({ description: null })).toEqual({ description: null });
    expect(checkTrainingModuleUpdate({ description: '<script>alert(1)</script>' })).toEqual({ description: null });
    // Absent leaves it alone: an update naming no description changes none.
    expect(checkTrainingSkillUpdate({ label: 'Closing' })).toEqual({ label: 'Closing' });
  });

  it.each([
    ['a skill\'s', (d: unknown) => checkTrainingSkillUpdate({ description: d })],
    ['a module\'s', (d: unknown) => checkTrainingModuleUpdate({ description: d })],
  ])('P19.6-T4 AC-1 holds %s description at 160 characters, and refuses one that is not text', (_name, check) => {
    expect(violations(() => check(long(160)))).toBeNull();
    expect(violations(() => check(long(161)))).toEqual(['description must be at most 160 characters.']);
    expect(violations(() => check(7))).toEqual(['description must be text.']);
  });
});
