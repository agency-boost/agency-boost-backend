import { joinSentences, type Message } from '@/common/i18n/sentence';
import { english, indonesian } from '../../../test/i18n';
import { TEMPLATE_MESSAGES, TEMPLATE_REFUSALS, TEMPLATE_SECTIONS } from './template.messages';

const R = TEMPLATE_REFUSALS;
const V = R.VALIDATION_FAILED;
const M = TEMPLATE_MESSAGES;

/**
 * **Every sentence the Super Admin's templates and provisioning write, in both languages** (P18.98-T5 AC-2, AC-4): each
 * refusal, and each reason *Save as template* gives for what it left out — said with its values kept as they are, both
 * arms of every choice included, and every entry of both catalogues here.
 */
const REFUSALS: [entry: string, sentence: Message, values: string[]][] = [
  ['VALIDATION_FAILED.nothingToPublish', V.nothingToPublish, []],
  ['VALIDATION_FAILED.editArchived', V.editArchived({ name: 'Jakarta branches' }), ['Jakarta branches']],
  ['VALIDATION_FAILED.noRatios', V.noRatios, []],
  ['VALIDATION_FAILED.ratioCodesUndeclared', V.ratioCodesUndeclared({ codes: ['X', 'Y'], version: 2 }), ['X, Y', '2']],
  ['VALIDATION_FAILED.ratioCodesUndeclared', V.ratioCodesUndeclared({ codes: ['X'], version: null }), ['X']],
  ['VALIDATION_FAILED.noDenominator', V.noDenominator({ code: 'REFERRAL_RATE' }), ['REFERRAL_RATE', '∞']],
  ['VALIDATION_FAILED.taxonomyEmpty', V.taxonomyEmpty, ['Log Activity']],
  ['VALIDATION_FAILED.pipelineNoStages', V.pipelineNoStages({ pipeline: 'sales' }), ['sales']],
  ['VALIDATION_FAILED.pipelineOneTerminal', V.pipelineOneTerminal({ pipeline: 'recruitment' }), ['recruitment']],
  ['VALIDATION_FAILED.inSection', V.inSection({ section: 'activityBinding', inner: V.noRatios }), []],
  ['VALIDATION_FAILED.flaggedBoth', V.flaggedBoth({ codes: ['CLOSED', 'WON'] }), ['CLOSED, WON']],
  ['VALIDATION_FAILED.terminalCount', V.terminalCount({ pipeline: 'sales', count: 2 }), ['sales', '2']],
  ['VALIDATION_FAILED.chooseTemplate', V.chooseTemplate, []],
  ['VALIDATION_FAILED.startFromArchived', V.startFromArchived({ name: 'Old template' }), ['Old template']],
  ['VALIDATION_FAILED.tileLabelled', V.tileLabelled({ code: 'CORE', labels: ['Core', 'Main'] }), ['CORE', 'Core', 'Main']],
  ['VALIDATION_FAILED.tileCodeTaken', V.tileCodeTaken({ code: 'CORE' }), ['CORE']],
  ['VALIDATION_FAILED.ratioNamesMissing', V.ratioNamesMissing({ code: 'R1', missing: ['A', 'B'] }), ['R1', 'A, B']],
  ['VALIDATION_FAILED.checklistLinks', V.checklistLinks({ codes: ['MOD_1'] }), ['MOD_1']],
  ['VALIDATION_FAILED.brokenOffice', V.brokenOffice({ source: { kind: 'template', name: 'Jakarta' }, problems: V.noRatios }),
    ['Jakarta']],
  ['VALIDATION_FAILED.brokenOffice', V.brokenOffice({ source: { kind: 'defaults' }, problems: V.noRatios }), ['AgencyBoost']],
  ['VALIDATION_FAILED.brokenOffice', V.brokenOffice({ source: { kind: 'office', code: '0417' }, problems: V.noRatios }),
    ['KPM 0417']],
  ['VALIDATION_FAILED.brokenOffice', V.brokenOffice({ source: { kind: 'source' }, problems: V.noRatios }), []],
  ['VALIDATION_FAILED.templateNeedsName', V.templateNeedsName, []],
  ['VALIDATION_FAILED.archivedCannotBeDefault', V.archivedCannotBeDefault, ['default']],
  ['VALIDATION_FAILED.alreadyThisCompanys', V.alreadyThisCompanys, []],
  ['VALIDATION_FAILED.fromShape', V.fromShape, ['from', '"empty"', '"defaults"', '{ templateId }']],
  ['VERSION_CONFLICT.defaultMoved', R.VERSION_CONFLICT.defaultMoved, ['default']],
  ['TEMPLATE_IS_DEFAULT.cannotStopBeingDefault', R.TEMPLATE_IS_DEFAULT.cannotStopBeingDefault({ name: 'Main' }), ['Main']],
  ['TEMPLATE_IS_DEFAULT.cannotArchive', R.TEMPLATE_IS_DEFAULT.cannotArchive({ name: 'Main' }), ['Main']],
  ['TEMPLATE_NAME_TAKEN.taken', R.TEMPLATE_NAME_TAKEN.taken({ name: 'Main' }), ['Main']],
  ['TEMPLATE_RUNG_UNKNOWN.notOnTheLadder', R.TEMPLATE_RUNG_UNKNOWN.notOnTheLadder({ codes: ['SM'] }), ['SM']],
  ['TEMPLATE_RUNG_UNKNOWN.notOnTheLadder', R.TEMPLATE_RUNG_UNKNOWN.notOnTheLadder({ codes: ['SM', 'UM'] }), ['SM, UM']],
  ['ASSET_NOT_CONFIRMED.neverUploaded', R.ASSET_NOT_CONFIRMED.neverUploaded({ label: 'Guide', moduleCode: 'MOD_1' }),
    ['“Guide”', 'MOD_1']],
];

const REASONS: [entry: keyof typeof M, sentence: Message, values: string[]][] = [
  ['bindingLeftOut', M.bindingLeftOut({ roles: ['Sales meeting'], gone: ['OLD_VISIT'] }), ['Sales meeting', 'OLD_VISIT']],
  ['bindingLeftOut', M.bindingLeftOut({ roles: ['Sales meeting', 'Submission polis'], gone: [] }),
    ['Sales meeting, Submission polis']],
  ['bindingNoLonger', M.bindingNoLonger({ gone: ['A', 'B'] }), ['A, B']],
  ['ratioLeftOut', M.ratioLeftOut({ code: 'R1', side: 'both', gone: ['A'] }), ['R1', 'A']],
  ['ratioLeftOut', M.ratioLeftOut({ code: 'R1', side: 'numerator', gone: ['A'] }), ['R1', 'A']],
  ['ratioLeftOut', M.ratioLeftOut({ code: 'R1', side: 'denominator', gone: ['A'] }), ['R1', 'A']],
  ['ratioNoLonger', M.ratioNoLonger({ code: 'R1', gone: ['A'] }), ['R1', 'A']],
  ['checklistManual', M.checklistManual({ item: 'B1', moduleCode: 'MOD_GONE' }), ['B1', 'MOD_GONE']],
  ['stageLeftOut', M.stageLeftOut({ code: 'S2', gone: ['M_OLD'] }), ['S2', '(M_OLD)']],
  ['stageNoLonger', M.stageNoLonger({ code: 'S1', gone: ['M_OLD'] }), ['S1', 'M_OLD']],
  ['stageNoLonger', M.stageNoLonger({ code: 'S1', gone: ['M_A', 'M_B'] }), ['S1', 'M_A, M_B']],
  ['gridLeftOut', M.gridLeftOut({ code: 'G_EMPTY' }), ['G_EMPTY']],
  ['ladderLeftOut', M.ladderLeftOut({ missing: 'stage' }), ['AgencyBoost']],
  ['ladderLeftOut', M.ladderLeftOut({ missing: 'milestone' }), ['milestone']],
];

describe('P18.98-T5 AC-2 the templates’ sentences', () => {
  it.each([...REFUSALS, ...REASONS])('%s is said in English and in Indonesian, its values kept as they are', (_entry, sentence, values) => {
    const [en, id] = [english(sentence), indonesian(sentence)];
    expect(en).toBeTruthy();
    expect(id).toBeTruthy();
    expect(id).not.toBe(en);
    for (const value of values) {
      expect(en).toContain(value);
      expect(id).toContain(value);
    }
  });

  it('has a case for every entry of both catalogues', () => {
    const filed = Object.entries(R).flatMap(([code, section]) => Object.keys(section).map((name) => `${code}.${name}`));
    expect([...new Set(REFUSALS.map(([entry]) => entry))].sort()).toEqual(filed.sort());
    expect([...new Set(REASONS.map(([entry]) => entry))].sort()).toEqual(Object.keys(M).sort());
  });

  it('names each section in each language: the settings’ own names kept, the binding said in Indonesian', () => {
    for (const section of Object.keys(TEMPLATE_SECTIONS) as (keyof typeof TEMPLATE_SECTIONS)[]) {
      const said = V.inSection({ section, inner: V.chooseTemplate });
      expect(english(said)).toBe(`${TEMPLATE_SECTIONS[section].en}: Choose the template the office starts from.`);
      expect(indonesian(said)).toBe(`${TEMPLATE_SECTIONS[section].id}: Pilih templat yang menjadi awal KPM ini.`);
    }
    expect(TEMPLATE_SECTIONS.activityBinding.id).toBe('Pengaitan aktivitas');
    expect(TEMPLATE_SECTIONS.leadStatuses.id).toBe('Lead statuses');
  });

  it('begins a broken office’s refusal with its source, and says every problem after it', () => {
    const problems = joinSentences([V.noRatios, V.chooseTemplate], ' ');
    expect(english(V.brokenOffice({ source: { kind: 'office', code: '0417' }, problems }))).toBe(
      'KPM 0417’s published settings would produce a broken office, so nothing was created. '
        + 'A ratio set with no ratios gives every new office nothing to measure. Choose the template the office starts from.',
    );
    expect(indonesian(V.brokenOffice({ source: { kind: 'defaults' }, problems }))).toBe(
      'Pengaturan default AgencyBoost akan menghasilkan KPM yang rusak, jadi tidak ada yang dibuat. '
        + 'Kumpulan ratio tanpa ratio membuat setiap KPM baru tidak memiliki apa pun untuk diukur. '
        + 'Pilih templat yang menjadi awal KPM ini.',
    );
    expect(english(V.brokenOffice({ source: { kind: 'source' }, problems: V.noRatios }))).toMatch(/^The source would produce/);
    expect(indonesian(V.brokenOffice({ source: { kind: 'source' }, problems: V.noRatios }))).toMatch(/^Sumber ini akan/);
  });

  it('says why a setting was left out, choosing by what is left, in each language', () => {
    expect(english(M.bindingLeftOut({ roles: ['Sales meeting'], gone: [] }))).toBe(
      'The activity binding was left out: Sales meeting would count nothing in this office. Offices made from the '
        + 'template count the default binding.',
    );
    expect(indonesian(M.bindingLeftOut({ roles: ['Sales meeting'], gone: ['OLD_VISIT'] }))).toBe(
      'Pengaitan aktivitas tidak disertakan: Sales meeting hanya akan menghitung OLD_VISIT, yang bukan jenis aktivitas '
        + 'aktif di KPM ini. KPM yang dibuat dari templat ini menghitung pengaitan default.',
    );
    expect(english(M.ratioLeftOut({ code: 'R', side: 'both', gone: ['A', 'B'] })))
      .toBe('Ratio R was left out: its numerator and its denominator count only A, B, which are not active activity types in this office.');
    expect(indonesian(M.ratioLeftOut({ code: 'R', side: 'denominator', gone: ['A'] })))
      .toBe('Ratio R tidak disertakan: penyebutnya hanya menghitung A, yang bukan jenis aktivitas aktif di KPM ini.');
    expect(indonesian(M.ladderLeftOut({ missing: 'milestone' }))).toMatch(/^Ladder capability tidak disertakan: tidak ada lagi milestone aktif/);
    expect(english(R.TEMPLATE_RUNG_UNKNOWN.notOnTheLadder({ codes: ['SM'] })))
      .toContain('to that role. Add it to the company’s ladder first');
    expect(english(R.TEMPLATE_RUNG_UNKNOWN.notOnTheLadder({ codes: ['SM', 'UM'] })))
      .toContain('to those roles. Add them to the company’s ladder first');
  });
});
