import type { Message } from '@/common/i18n/sentence';
import { english, indonesian } from '../../../test/i18n';
import { CAPABILITY_REFUSALS } from './capability.messages';

const SAY = CAPABILITY_REFUSALS.VALIDATION_FAILED;

/**
 * **Every sentence the capability catalog refuses with, in both languages** (P18.10-T5 AC-2): each entry said with its
 * values, the values kept as they are in both, and every entry of the catalogue here — so one added without a case
 * fails, and one without its Indonesian cannot be written at all (`tsc`).
 */
const CASES: [entry: keyof typeof SAY, sentence: Message, values: string[]][] = [
  ['notAList', SAY.notAList({ key: 'stages' }), ['stages']],
  ['noStages', SAY.noStages, []],
  ['noMilestones', SAY.noMilestones, []],
  ['noCode', SAY.noCode({ place: { part: 'stage', n: 2 } }), ['2']],
  ['noCode', SAY.noCode({ place: { part: 'item', grid: 3, n: 4 } }), ['Grid 3, item 4']],
  ['codeTwice', SAY.codeTwice({ code: 'LEADS_GEN' }), ['LEADS_GEN']],
  ['noLabel', SAY.noLabel({ place: { part: 'milestone', n: 5 } }), ['Milestone 5']],
  ['stageOrderMin', SAY.stageOrderMin({ stage: 2 }), ['2', 'stageOrder']],
  ['stageOrderShared', SAY.stageOrderShared({ order: 3 }), ['stageOrder 3']],
  ['stageNoMilestone', SAY.stageNoMilestone({ stage: 1 }), ['1']],
  ['stageUnknownMilestone', SAY.stageUnknownMilestone({ stage: 1, code: 'GHOST' }), ['GHOST']],
  ['gridNoItems', SAY.gridNoItems({ grid: 2 }), ['Grid 2']],
  ['labelEmpty', SAY.labelEmpty, []],
  ['milestoneRequired', SAY.milestoneRequired({ stages: ['Competent Producer', 'Leader'] }), ['Competent Producer, Leader']],
  ['itemNeedsCode', SAY.itemNeedsCode, []],
  ['itemNeedsLabel', SAY.itemNeedsLabel, []],
  ['codeUsed', SAY.codeUsed({ code: 'CLOSES_ALONE' }), ['CLOSES_ALONE']],
  ['sendEvery', SAY.sendEvery({ part: 'stage', count: 4 }), ['4']],
  ['sendEvery', SAY.sendEvery({ part: 'grid', count: 1250 }), []],
];

describe('P18.10-T5 AC-2 the capability catalog’s sentences', () => {
  it.each(CASES)('%s is said in English and in Indonesian, its values kept as they are', (_entry, sentence, values) => {
    const [en, id] = [english(sentence), indonesian(sentence)];
    expect(en).toBeTruthy();
    expect(id).toBeTruthy();
    expect(id).not.toBe(en);
    for (const value of values) {
      expect(en).toContain(value);
      expect(id).toContain(value);
    }
  });

  it('has a case for every entry', () => {
    expect([...new Set(CASES.map(([entry]) => entry))].sort()).toEqual(Object.keys(SAY).sort());
  });

  it('names a place, a stage and a count the Indonesian way', () => {
    expect(indonesian(SAY.noCode({ place: { part: 'stage', n: 2 } })))
      .toBe('Tahap 2 tidak memiliki kode. Setiap item memilikinya, sehingga mengganti nama tidak pernah memindahkan centang.');
    expect(english(SAY.sendEvery({ part: 'grid', count: 1250 }))).toBe('Send every grid once each — 1250 of them.');
    expect(indonesian(SAY.sendEvery({ part: 'grid', count: 1250 })))
      .toBe('Kirim setiap grid masing-masing sekali — semuanya 1.250.');
    expect(indonesian(SAY.sendEvery({ part: 'stage', count: 4 }))).toBe('Kirim setiap tahap masing-masing sekali — semuanya 4.');
  });
});
