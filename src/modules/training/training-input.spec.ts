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
      .toEqual({ code: 'FIRST_WEEK', categoryCode: 'ONBOARDING', label: 'First week' });
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
