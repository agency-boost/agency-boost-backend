import { checkActivationChecklist, trainingLinkModuleCode } from './activation-input';
import {
  activationChecklistProblems, activationTrainingLinks, defaultActivationChecklist,
} from './activation-payload';

const item = (over: Record<string, unknown> = {}) => ({
  code: 'INSURANCE_BASICS', label: 'Learn insurance basics', ...over,
});
const checklist = (over: Record<string, unknown> = {}) => ({
  aspects: [{ code: 'INTRODUCTION', label: '1. Introduction', items: [item()] }],
  ...over,
});

/** The refusal's sentences, which is what a form shows field by field. */
function violations(body: unknown): string[] {
  try {
    checkActivationChecklist(body);
    return [];
  } catch (err) {
    return (err as { details?: { violations?: string[] } }).details?.violations ?? [];
  }
}

describe('what a write to an activation checklist may contain (P5-T3, ADR-0030)', () => {
  it('normalises codes and takes order from position', () => {
    const checked = checkActivationChecklist({
      aspects: [
        {
          code: 'introduction',
          label: '  1. Introduction  ',
          items: [item({ code: 'second' }), item({ code: 'first' })],
        },
        { code: 'INITIAL_SETUP', label: '2. Initial Setup', items: [item({ code: 'third' })] },
      ],
    });

    expect(checked.aspects.map((a) => [a.code, a.label, a.displayOrder])).toEqual([
      ['INTRODUCTION', '1. Introduction', 1],
      ['INITIAL_SETUP', '2. Initial Setup', 2],
    ]);
    // The list the caller sent *is* the order — which is what makes a reorder an ordinary save.
    expect(checked.aspects[0].items.map((i) => [i.code, i.displayOrder])).toEqual([
      ['SECOND', 1], ['FIRST', 2],
    ]);
  });

  it('keeps a manual item’s link as null, however it was sent', () => {
    const checked = checkActivationChecklist(checklist({
      aspects: [{
        code: 'INTRODUCTION',
        label: '1. Introduction',
        items: [item(), item({ code: 'B_ITEM', autoLink: null }), item({ code: 'C_ITEM', autoLink: '' })],
      }],
    }));

    expect(checked.aspects[0].items.map((i) => i.autoLink)).toEqual([null, null, null]);
  });

  it('accepts the three feature links and a training link by module code', () => {
    const checked = checkActivationChecklist({
      aspects: [{
        code: 'INITIAL_SETUP',
        label: '2. Initial Setup',
        items: [
          item({ code: 'A_ITEM', autoLink: 'feature:goals' }),
          item({ code: 'B_ITEM', autoLink: 'feature:leads' }),
          item({ code: 'C_ITEM', autoLink: 'feature:activity' }),
          item({ code: 'D_ITEM', autoLink: 'training:prospect_list' }),
        ],
      }],
    });

    expect(checked.aspects[0].items.map((i) => i.autoLink)).toEqual([
      'feature:goals', 'feature:leads', 'feature:activity', 'training:PROSPECT_LIST',
    ]);
  });

  it('refuses a link this product does not have, naming what it accepts', () => {
    const [refusal] = violations(checklist({
      aspects: [{
        code: 'INTRODUCTION',
        label: '1. Introduction',
        items: [item({ autoLink: 'feature:coaching' })],
      }],
    }));

    expect(refusal).toContain('feature:coaching is not a link this product has');
    expect(refusal).toContain('feature:goals');
  });

  it('refuses a training link whose module code is not a code', () => {
    expect(violations(checklist({
      aspects: [{ code: 'INTRODUCTION', label: '1. Introduction', items: [item({ autoLink: 'training:no' })] }],
    }))[0]).toContain('a training link names a module code');
  });

  it('refuses a code used twice, saying which', () => {
    const problems = violations({
      aspects: [
        { code: 'INTRODUCTION', label: '1. Introduction', items: [item()] },
        { code: 'INTRODUCTION', label: 'Again', items: [item({ code: 'OTHER_ITEM' })] },
        { code: 'THIRD', label: 'Third', items: [item()] },
      ],
    });

    expect(problems).toContain('The aspect code INTRODUCTION is used twice.');
    expect(problems).toContain('The item code INSURANCE_BASICS is used twice.');
  });

  it('refuses an empty checklist and an empty aspect, because a hire would open nothing', () => {
    expect(violations({ aspects: [] })[0]).toContain('1–20 aspects');
    expect(violations(checklist({
      aspects: [{ code: 'INTRODUCTION', label: '1. Introduction', items: [] }],
    }))[0]).toContain('an aspect holds');
  });

  it('collects every problem at once, the way a form reports them', () => {
    const problems = violations({
      aspects: [{ code: 'ok_code', label: '', items: [{ code: '!', label: 'x'.repeat(201), autoLink: 7 }] }],
    });

    expect(problems.length).toBeGreaterThanOrEqual(4);
    expect(problems.join(' ')).toContain('label must be 1–80 characters');
    expect(problems.join(' ')).toContain('label must be 1–200 characters');
    expect(problems.join(' ')).toContain('autoLink must be text');
  });

  it('refuses a field nobody declared, rather than dropping it', () => {
    expect(violations({ aspects: [], extra: true }).join(' ')).toContain('property extra should not exist');
    expect(violations(checklist({
      aspects: [{ code: 'INTRODUCTION', label: '1. Introduction', items: [item({ done: true })] }],
    })).join(' ')).toContain('property done should not exist');
  });

  it('refuses what is not a checklist at all', () => {
    expect(violations(null).join(' ')).toContain('aspects must be a list');
    expect(violations({ aspects: ['nope'] }).join(' ')).toContain('must be an object of fields');
  });
});

describe('the checklist as a company template payload', () => {
  it('has no problems when it is the seed', () => {
    expect(activationChecklistProblems(defaultActivationChecklist())).toEqual([]);
  });

  it('is the prototype’s sixteen items across five aspects', () => {
    const payload = defaultActivationChecklist();
    expect(payload.aspects).toHaveLength(5);
    expect(payload.aspects.flatMap((a) => a.items)).toHaveLength(16);
  });

  it('reports a broken payload as sentences rather than throwing', () => {
    expect(activationChecklistProblems({ aspects: [] })[0]).toContain('1–20 aspects');
    // Two sentences: it is not an object, and it has no aspects. A caller hears both.
    expect(activationChecklistProblems('not a checklist').join(' '))
      .toContain('The change must be an object of fields. aspects must be a list.');
  });

  it('lists every training module a checklist names, once each', () => {
    const { aspects } = checkActivationChecklist({
      aspects: [{
        code: 'TRAINING_AND_CERTIFICATION',
        label: '3. Training & Certification',
        items: [
          item({ code: 'A_ITEM', autoLink: 'training:PROSPECT_LIST' }),
          item({ code: 'B_ITEM', autoLink: 'training:PROSPECT_LIST' }),
          item({ code: 'C_ITEM', autoLink: 'training:CLIENT_RETENTION' }),
          item({ code: 'D_ITEM', autoLink: 'feature:goals' }),
        ],
      }],
    });

    expect(activationTrainingLinks(aspects)).toEqual(['PROSPECT_LIST', 'CLIENT_RETENTION']);
  });

  it('reads a module code out of a link, and nothing out of the others', () => {
    expect(trainingLinkModuleCode('training:PROSPECT_LIST')).toBe('PROSPECT_LIST');
    expect(trainingLinkModuleCode('feature:goals')).toBeNull();
    expect(trainingLinkModuleCode(null)).toBeNull();
  });
});
