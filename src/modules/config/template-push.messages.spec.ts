import type { Message } from '@/common/i18n/sentence';
import { english, indonesian } from '../../../test/i18n';
import { TEMPLATE_PUSH_REFUSALS } from './template-push.messages';

const R = TEMPLATE_PUSH_REFUSALS;
const V = R.VALIDATION_FAILED;

/** Every refusal of the template's material and its push, with the values it must keep as they are. */
const REFUSALS: [entry: string, sentence: Message, values: string[]][] = [
  ['VALIDATION_FAILED.moduleNotInTemplate', V.moduleNotInTemplate({ code: 'PROSPECT_LIST' }), ['PROSPECT_LIST']],
  ['VALIDATION_FAILED.notThisCompanysFile', V.notThisCompanysFile({ label: 'Modul.pdf' }), ['“Modul.pdf”']],
  ['VALIDATION_FAILED.nothingToApply', V.nothingToApply, []],
  ['VALIDATION_FAILED.unknownKind', V.unknownKind({ kinds: ['campaign_kinds', 'x'] }), ['campaign_kinds, x']],
  ['VALIDATION_FAILED.builtInReachesNobody', V.builtInReachesNobody, []],
  ['VALIDATION_FAILED.notPublished', V.notPublished({ kinds: ['event_types'] }), ['event_types']],
  ['VALIDATION_FAILED.ratioTypesMissing', V.ratioTypesMissing({ codes: ['OLD_VISIT'] }), ['OLD_VISIT']],
  ['VALIDATION_FAILED.checklistModulesMissing', V.checklistModulesMissing({ codes: ['MOD_1', 'MOD_2'] }), ['MOD_1, MOD_2']],
  ['VALIDATION_FAILED.earlierKindRefused', V.earlierKindRefused, []],
  ['TEMPLATE_APPLY_UNCONFIRMED.unconfirmed', R.TEMPLATE_APPLY_UNCONFIRMED.unconfirmed({ codes: ['0417', '0555'] }), ['KPM 0417, 0555']],
];

describe('P19.4-T1 the push’s sentences, in both languages (ADR-0208)', () => {
  it.each(REFUSALS)('P19.4-T1 AC-6 %s is said in English and in Indonesian, its values kept as they are', (_entry, sentence, values) => {
    const [en, id] = [english(sentence), indonesian(sentence)];
    expect(en).toBeTruthy();
    expect(id).toBeTruthy();
    expect(id).not.toBe(en);
    for (const value of values) {
      expect(en).toContain(value);
      expect(id).toContain(value);
    }
  });

  it('P19.4-T1 AC-6 has a case for every entry of the catalogue', () => {
    const filed = Object.entries(R).flatMap(([code, section]) => Object.keys(section).map((name) => `${code}.${name}`));
    expect(REFUSALS.map(([entry]) => entry).sort()).toEqual(filed.sort());
  });
});
