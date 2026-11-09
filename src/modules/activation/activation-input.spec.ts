import type { DomainException } from '@/common/errors/domain.exception';
import type { Sentence } from '@/common/i18n/sentence';
import { englishAll, indonesianAll } from '../../../test/i18n';
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

/** The same sentences as given — both languages — read in Indonesian (P18.10-T5 AC-3). */
function indonesianViolations(body: unknown): string[] {
  try {
    checkActivationChecklist(body);
    return [];
  } catch (err) {
    return indonesianAll((err as DomainException).givenDetails!.violations as Sentence[]);
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

  it('P18.10-T5 AC-3 names every problem in Indonesian too, each place in the checklist as the reader counts it', () => {
    const body = {
      aspects: [
        { code: 'INTRODUCTION', label: '', items: [item({ autoLink: 'feature:coaching' }), item({ code: 'X_ITEM', autoLink: 7 })] },
        { code: 'INTRODUCTION', label: 'Again', items: [item({ autoLink: 'sales:first' }), item({ code: 'Y_ITEM', autoLink: 'training:no' })] },
        { code: 'THIRD', label: 'Third', items: 'none' },
        'nope',
      ],
    };
    expect(violations(body)).toEqual([
      'Aspect 1: label must be 1–80 characters.',
      'Aspect 1, item 1: feature:coaching is not a link this product has. Use one of feature:goals, feature:leads, '
        + 'feature:activity, training:<module code>, or nothing at all for a manual item.',
      'Aspect 1, item 2: autoLink must be text, or null for a manual item.',
      'The aspect code INTRODUCTION is used twice.',
      'Aspect 2, item 1: sales:first is not chosen for an item. It belongs to the item whose code it is bound to, '
        + 'which reads it on its own.',
      'The item code INSURANCE_BASICS is used twice.',
      'Aspect 2, item 2: a training link names a module code. A code is 3–40 characters of A–Z, 0–9 and underscore, '
        + 'starting with a letter.',
      'Aspect 3: items must be a list.',
      'Aspect 4 must be an object of fields.',
    ]);
    expect(indonesianViolations(body)).toEqual([
      'Aspek 1: label harus 1–80 karakter.',
      'Aspek 1, item 1: feature:coaching bukan tautan yang dimiliki produk ini. Gunakan salah satu dari feature:goals, '
        + 'feature:leads, feature:activity, training:<kode modul>, atau kosongkan untuk item manual.',
      'Aspek 1, item 2: autoLink harus berupa teks, atau null untuk item manual.',
      'Kode aspek INTRODUCTION dipakai dua kali.',
      'Aspek 2, item 1: sales:first tidak dipilih untuk sebuah item. Tautan ini milik item yang kodenya terikat padanya, '
        + 'dan item itu membacanya sendiri.',
      'Kode item INSURANCE_BASICS dipakai dua kali.',
      'Aspek 2, item 2: tautan training menyebut kode modul. Kode terdiri dari 3–40 karakter A–Z, 0–9 dan garis bawah, '
        + 'diawali huruf.',
      'Aspek 3: items harus berupa daftar.',
      'Aspek 4 harus berupa objek berisi kolom.',
    ]);
    expect(indonesianViolations({ aspects: [] })).toEqual(['Checklist memiliki 1–20 aspek; checklist ini memiliki 0.']);
    expect(indonesianViolations(checklist({ aspects: [{ code: 'INTRODUCTION', label: '1. Introduction', items: [] }] })))
      .toEqual(['Aspek 1 memiliki 0 item; satu aspek berisi 1–50 item.']);
    expect(indonesianViolations(null)).toEqual(['aspects harus berupa daftar.']);
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
    expect(englishAll(activationChecklistProblems({ aspects: [] }))[0]).toContain('1–20 aspects');
    // Two sentences: it is not an object, and it has no aspects. A caller hears both.
    expect(englishAll(activationChecklistProblems('not a checklist')).join(' '))
      .toContain('The change must be an object of fields. aspects must be a list.');
  });

  it('P18.10-T5 AC-3 reports them in both languages, read from the refusal’s sentences as given', () => {
    expect(indonesianAll(activationChecklistProblems('not a checklist')))
      .toEqual(['Perubahan harus berupa objek berisi kolom.', 'aspects harus berupa daftar.']);
  });

  it('throws on what is not a refusal: a fault is not the payload’s problem', () => {
    const faulty = { get aspects(): unknown { throw new Error('the payload could not be read'); } };
    expect(() => activationChecklistProblems(faulty)).toThrow('the payload could not be read');
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
