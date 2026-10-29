import { readerIn } from '@/common/i18n/reader';
import { render, type Message } from '@/common/i18n/sentence';
import { english, indonesian } from '../../../test/i18n';
import { CONFIG_REFUSALS } from './config.messages';

const R = CONFIG_REFUSALS;
const V = R.VALIDATION_FAILED;

/**
 * **Every sentence the office's configuration refuses with, in both languages** (P18.98-T5 AC-2, AC-3): each said
 * with its values — a code, a label an office typed, an op — kept as they are, both arms of every choice included, and
 * every entry of the catalogue here.
 */
const CASES: [entry: string, sentence: Message, values: string[]][] = [
  ['ACTIVITY_TYPE_BOUND.typeBound', R.ACTIVITY_TYPE_BOUND.typeBound({ label: 'Melakukan aktivitas', role: 'Set appointment' }),
    ['“Melakukan aktivitas”', 'Set appointment']],
  ['ACTIVITY_TYPE_BOUND.sectionBound', R.ACTIVITY_TYPE_BOUND.sectionBound({ section: 'Selling', labels: ['A', 'B'] }),
    ['Selling', '“A”, “B”']],
  ['CONFIG_RATIO_UNREACHABLE_INPUT.narrowFirst', R.CONFIG_RATIO_UNREACHABLE_INPUT.narrowFirst({ ratios: ['R1', 'R2'] }),
    ['R1, R2']],
  ['CONFIG_SUMMARY_GROUP_LABEL_MISMATCH.twoLabels',
    R.CONFIG_SUMMARY_GROUP_LABEL_MISMATCH.twoLabels({ code: 'CORE', labels: ['Core', 'Main'] }), ['CORE', '“Core”', '“Main”']],
  ['CONFIG_SUMMARY_GROUP_CODE_TAKEN.codeOfATile', R.CONFIG_SUMMARY_GROUP_CODE_TAKEN.codeOfATile({ code: 'CORE', label: 'Core' }),
    ['CORE', '“Core”']],
  ['CONFIG_RUNG_UNKNOWN.notActiveRungs', R.CONFIG_RUNG_UNKNOWN.notActiveRungs({ codes: ['DIRECTOR'] }), ['DIRECTOR']],
  ['VERSION_CONFLICT.rowChanged', R.VERSION_CONFLICT.rowChanged({ code: 'SELLING', version: 3, read: 2 }), ['SELLING', '3', '2']],
  ['VERSION_CONFLICT.bindingChanged', R.VERSION_CONFLICT.bindingChanged({ version: 4, read: 3 }), ['4', '3']],
  ['VALIDATION_FAILED.nothingToChange', V.nothingToChange, []],
  ['VALIDATION_FAILED.summaryGroupPair', V.summaryGroupPair, ['summaryGroupCode', 'summaryGroupLabel', 'null']],
  ['VALIDATION_FAILED.ratioSideEmpty', V.ratioSideEmpty({ side: 'numerator' }), []],
  ['VALIDATION_FAILED.ratioSideEmpty', V.ratioSideEmpty({ side: 'denominator' }), []],
  ['VALIDATION_FAILED.ratioSideTooMany', V.ratioSideTooMany({ side: 'numerator', max: 50 }), ['50']],
  ['VALIDATION_FAILED.sendEverySection', V.sendEverySection, []],
  ['VALIDATION_FAILED.sendEveryType', V.sendEveryType, []],
  ['VALIDATION_FAILED.categoryTaken', V.categoryTaken({ code: 'SELLING' }), ['SELLING']],
  ['VALIDATION_FAILED.typeTaken', V.typeTaken({ code: 'SELL_SUBMISSION' }), ['SELL_SUBMISSION']],
  ['VALIDATION_FAILED.noActiveCategory', V.noActiveCategory({ code: 'GHOST' }), ['GHOST']],
  ['VALIDATION_FAILED.leadStatusTaken', V.leadStatusTaken({ code: 'CLOSED' }), ['CLOSED']],
  ['VALIDATION_FAILED.archivedCannotClose', V.archivedCannotClose, []],
  ['VALIDATION_FAILED.terminalIsClosed', V.terminalIsClosed, []],
  ['VALIDATION_FAILED.archivedHoldsNoLeads', V.archivedHoldsNoLeads, []],
  ['VALIDATION_FAILED.sendEveryStatus', V.sendEveryStatus({ pipeline: 'sales' }), ['sales']],
  ['VALIDATION_FAILED.terminalCannotArchive', V.terminalCannotArchive, []],
  ['VALIDATION_FAILED.ratioTaken', V.ratioTaken({ code: 'REFERRAL_RATE' }), ['REFERRAL_RATE']],
  ['VALIDATION_FAILED.codeTwiceInSide', V.codeTwiceInSide({ code: 'LEADS', side: 'denominator' }), ['LEADS']],
  ['VALIDATION_FAILED.unknownTypesInSide', V.unknownTypesInSide({ side: 'numerator', codes: ['X', 'Y'] }), ['X, Y']],
  ['VALIDATION_FAILED.unknownTypesInSide', V.unknownTypesInSide({ side: 'denominator', codes: ['X'] }), ['X']],
  ['VALIDATION_FAILED.unknownChange', V.unknownChange({ op: 'category.delete' }), ['category.delete']],
  ['VALIDATION_FAILED.codeInUse', V.codeInUse({ code: 'SELLING' }), ['SELLING']],
  ['VALIDATION_FAILED.noActiveSection', V.noActiveSection({ code: 'GHOST' }), ['GHOST']],
  ['VALIDATION_FAILED.sayTheVersion', V.sayTheVersion, []],
  ['VALIDATION_FAILED.noTrainingCategory', V.noTrainingCategory({ code: 'SALES' }), ['SALES']],
  ['VALIDATION_FAILED.noTrainingSkill', V.noTrainingSkill({ code: 'PROSPECTING' }), ['PROSPECTING']],
  ['VALIDATION_FAILED.noCategoryToMoveInto', V.noCategoryToMoveInto({ category: 'SALES', row: 'PROSPECTING' }),
    ['SALES', 'PROSPECTING']],
  ['VALIDATION_FAILED.noSkillToMoveUnder', V.noSkillToMoveUnder({ skill: 'PROSPECTING', row: 'MOD_1' }),
    ['PROSPECTING', 'MOD_1']],
  ['VALIDATION_FAILED.categoryArchived', V.categoryArchived({ row: 'PROSPECTING', parent: 'SALES' }), ['PROSPECTING', 'SALES']],
  ['VALIDATION_FAILED.skillArchived', V.skillArchived({ row: 'MOD_1', parent: 'PROSPECTING' }), ['MOD_1', 'PROSPECTING']],
  ['VALIDATION_FAILED.atChange', V.atChange({ n: 3, op: 'type.create', inner: V.nothingToChange }), ['3', '(type.create)']],
  ['VALIDATION_FAILED.atChangeUnexpected', V.atChangeUnexpected({ n: 1, op: 'ratio.update', detail: 'Cast failed' }),
    ['1', '(ratio.update)', 'Cast failed']],
  ['VALIDATION_FAILED.bindingNotAnObject', V.bindingNotAnObject, ['Set appointment', 'Sales meeting', 'Submission polis']],
  ['VALIDATION_FAILED.bindingNotAList', V.bindingNotAList({ label: 'Set appointment' }), ['Set appointment']],
  ['VALIDATION_FAILED.bindingCountsNone', V.bindingCountsNone({ label: 'Sales meeting' }), ['Sales meeting']],
  ['VALIDATION_FAILED.bindingTooMany', V.bindingTooMany({ label: 'Sales meeting', count: 21, max: 20 }), ['21', '20']],
  ['VALIDATION_FAILED.bindingTwice', V.bindingTwice({ label: 'Set appointment', code: 'LEAD' }), ['LEAD']],
  ['VALIDATION_FAILED.bindingInTwoRoles', V.bindingInTwoRoles({ code: 'LEAD', other: 'Set appointment', label: 'Sales meeting' }),
    ['LEAD', 'Set appointment', 'Sales meeting']],
  ['VALIDATION_FAILED.bindingUnknownCodes', V.bindingUnknownCodes({ label: 'Sales meeting', codes: ['GHOST'] }), ['GHOST']],
  ['VALIDATION_FAILED.bindingUnknownCodes', V.bindingUnknownCodes({ label: 'Sales meeting', codes: ['A', 'B'] }), ['A, B']],
];

describe('P18.98-T5 AC-2 the office configuration’s sentences', () => {
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
    const filed = Object.entries(R).flatMap(([code, section]) => Object.keys(section).map((name) => `${code}.${name}`));
    expect([...new Set(CASES.map(([entry]) => entry))].sort()).toEqual(filed.sort());
  });

  it('says a ratio’s side and a count by the value, in each language', () => {
    expect(english(V.ratioSideEmpty({ side: 'denominator' }))).toBe('A ratio needs at least one activity type in its denominator.');
    expect(indonesian(V.ratioSideEmpty({ side: 'denominator' })))
      .toBe('Ratio memerlukan paling sedikit satu jenis aktivitas di penyebutnya.');
    expect(indonesian(V.unknownTypesInSide({ side: 'numerator', codes: ['X'] }))).toMatch(/^Pembilang menyebut X, /);
    expect(indonesian(V.unknownTypesInSide({ side: 'denominator', codes: ['X'] }))).toMatch(/^Penyebut menyebut X, /);
    expect(english(V.bindingUnknownCodes({ label: 'L', codes: ['A'] }))).toBe('L names A, which is not an activity type here.');
    expect(english(V.bindingUnknownCodes({ label: 'L', codes: ['A', 'B'] })))
      .toBe('L names A, B, which are not activity types here.');
  });

  it('says a refusal for the op it came from in each language, the inner sentence’s figures the reader’s', () => {
    const inner = V.noActiveSection({ code: 'GHOST' });
    const wrapped = V.atChange({ n: 2, op: 'type.create', inner });
    expect(english(wrapped)).toBe('Change 2 (type.create): No active section called GHOST. Add the section first, or check the code.');
    expect(indonesian(wrapped))
      .toBe('Perubahan 2 (type.create): Tidak ada bagian aktif bernama GHOST. Tambahkan bagian itu terlebih dahulu, atau periksa kodenya.');
    expect(render(wrapped, readerIn('en'))).toBe(english(wrapped));
  });
});
