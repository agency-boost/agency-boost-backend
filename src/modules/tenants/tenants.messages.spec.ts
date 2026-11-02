import { readerIn } from '@/common/i18n/reader';
import { render, type Message } from '@/common/i18n/sentence';
import { english, indonesian } from '../../../test/i18n';
import { TENANTS_MESSAGES, TENANTS_REFUSALS } from './tenants.messages';

const R = TENANTS_REFUSALS;
const V = R.VALIDATION_FAILED;
const M = TENANTS_MESSAGES;

/**
 * **Every sentence the tenants module writes, in both languages** (P18.98-T5 AC-2, AC-4): each refusal, each row's
 * issue and each of the overview's words, said with its values — a code, a name, a count, a file's own word — kept as
 * they are, and every entry of both catalogues here, both arms of every choice a sentence makes included.
 */
const REFUSALS: [entry: string, sentence: Message, values: string[]][] = [
  ['PERM_DENIED.cannotDoThat', R.PERM_DENIED.cannotDoThat, []],
  ['PERM_DENIED.noPermissionForThat', R.PERM_DENIED.noPermissionForThat, []],
  ['PERM_DENIED.importRoster', R.PERM_DENIED.importRoster, ['roster']],
  ['COMPANY_SLUG_TAKEN.taken', R.COMPANY_SLUG_TAKEN.taken({ slug: 'prudential', existingName: 'Prudential' }),
    ['"prudential"', 'Prudential']],
  ['COMPANY_IS_TEMPLATE_LIBRARY.holdsNoOffice', R.COMPANY_IS_TEMPLATE_LIBRARY.holdsNoOffice({ name: 'Template' }),
    ['Template library']],
  ['TENANT_CODE_TAKEN.taken', R.TENANT_CODE_TAKEN.taken({ code: '0417', company: 'Prudential' }), ['0417', 'Prudential']],
  ['PERM_LAST_OWNER.alwaysAnOwner', R.PERM_LAST_OWNER.alwaysAnOwner, ['Owner']],
  ['ORG_AGENT_ALREADY_TAGGED.alreadyInOffice', R.ORG_AGENT_ALREADY_TAGGED.alreadyInOffice, []],
  ['TENANT_REQUEST_ALREADY_OPEN.alreadyAsked', R.TENANT_REQUEST_ALREADY_OPEN.alreadyAsked, []],
  ['TENANT_REQUEST_DECIDED.alreadyDecided', R.TENANT_REQUEST_DECIDED.alreadyDecided({ status: 'approved' }), []],
  ['TENANT_REQUEST_DECIDED.alreadyDecided', R.TENANT_REQUEST_DECIDED.alreadyDecided({ status: 'declined' }), []],
  ['CONFIG_RUNG_UNKNOWN.notOnTheLadder', R.CONFIG_RUNG_UNKNOWN.notOnTheLadder({ codes: ['DIRECTOR'], subject: 'ratio' }),
    ['DIRECTOR']],
  ['CONFIG_RUNG_UNKNOWN.notOnTheLadder', R.CONFIG_RUNG_UNKNOWN.notOnTheLadder({ codes: ['A', 'B'], subject: 'section' }),
    ['A, B']],
  ['ORG_LEVEL_NOT_ON_LADDER.noOwnerRung', R.ORG_LEVEL_NOT_ON_LADDER.noOwnerRung, ['Senior Leader']],
  ['ORG_LEVEL_NOT_ON_LADDER.noJoinerRung', R.ORG_LEVEL_NOT_ON_LADDER.noJoinerRung, []],
  ['ORG_LEVEL_NOT_ON_LADDER.noLevel', R.ORG_LEVEL_NOT_ON_LADDER.noLevel({ code: 'SM' }), ['SM']],
  ['ORG_LEVEL_CODE_TAKEN.taken', R.ORG_LEVEL_CODE_TAKEN.taken({ company: 'Prudential', code: 'SM', archived: false }),
    ['Prudential', 'SM']],
  ['ORG_LEVEL_CODE_TAKEN.taken', R.ORG_LEVEL_CODE_TAKEN.taken({ company: 'Prudential', code: 'SM', archived: true }),
    ['Prudential', 'SM']],
  ['ORG_LEVEL_TIER_IN_USE.held', R.ORG_LEVEL_TIER_IN_USE.held({ members: 1, label: 'Unit Manager' }), ['Unit Manager']],
  ['ORG_LEVEL_TIER_IN_USE.held', R.ORG_LEVEL_TIER_IN_USE.held({ members: 2, label: 'Unit Manager' }), ['Unit Manager']],
  ['INTERNAL_ERROR.ladderCannotCount', R.INTERNAL_ERROR.ladderCannotCount, []],
  ['VALIDATION_FAILED.nothingToChange', V.nothingToChange, []],
  ['VALIDATION_FAILED.nameTheOwner', V.nameTheOwner, ['email']],
  ['VALIDATION_FAILED.ownerDeactivated', V.ownerDeactivated, []],
  ['VALIDATION_FAILED.startFromDefaults', V.startFromDefaults, ['Default template', 'AgencyBoost']],
  ['VALIDATION_FAILED.unknownTemplateKind', V.unknownTemplateKind({ kind: 'nope', kinds: ['ratio_set', 'lead_pipeline'] }),
    ['"nope"', 'ratio_set, lead_pipeline']],
  ['VALIDATION_FAILED.slugShape', V.slugShape, ['slug']],
  ['VALIDATION_FAILED.rungCodeShape', V.rungCodeShape, ['code']],
  ['VALIDATION_FAILED.timezoneOnly', V.timezoneOnly({ zone: 'Asia/Jakarta' }), ['timezone', 'Asia/Jakarta', 'v1']],
  ['VALIDATION_FAILED.startDateShape', V.startDateShape, ['startDate', 'YYYY-MM-DD']],
  ['VALIDATION_FAILED.endDateShape', V.endDateShape, ['endDate', 'YYYY-MM-DD']],
  ['VALIDATION_FAILED.kpmCodeShape', V.kpmCodeShape, ['code']],
  ['VALIDATION_FAILED.startNotADay', V.startNotADay, []],
  ['VALIDATION_FAILED.endNotADay', V.endNotADay, []],
  ['VALIDATION_FAILED.datesBothOrNeither', V.datesBothOrNeither, []],
  ['VALIDATION_FAILED.endBeforeStart', V.endBeforeStart, []],
  ['VALIDATION_FAILED.priceRange', V.priceRange({ min: 0, max: 100_000_000_00 }), ['Rp 0', 'Rp 100.000.000']],
  ['VALIDATION_FAILED.priceWholeRupiah', V.priceWholeRupiah, ['sen']],
  ['VALIDATION_FAILED.leaderLimitRange', V.leaderLimitRange({ min: 1, max: 10_000 }), ['10.000']],
  ['VALIDATION_FAILED.keepActiveOnOrOff', V.keepActiveOnOrOff, []],
  ['VALIDATION_FAILED.rowsWouldNotImport', V.rowsWouldNotImport({ count: 1 }), ['1']],
  ['VALIDATION_FAILED.rowsWouldNotImport', V.rowsWouldNotImport({ count: 3 }), ['3']],
  // ADR-0184: the roster as a file.
  ['VALIDATION_FAILED.attachRosterFile', V.attachRosterFile, ['`file`', '.xlsx', '.csv']],
  ['VALIDATION_FAILED.rosterNotAForm', V.rosterNotAForm, ['`file`']],
  ['VALIDATION_FAILED.unknownTemplateFormat', V.unknownTemplateFormat, ['format=xlsx', 'format=csv']],
  ['ASSET_TOO_LARGE.rosterTooLarge', R.ASSET_TOO_LARGE.rosterTooLarge({ mb: 1 }), ['1 MB']],
  ['VALIDATION_FAILED.headerOnly', V.headerOnly, []],
  ['VALIDATION_FAILED.fileEmpty', V.fileEmpty, []],
  ['VALIDATION_FAILED.headerExactly', V.headerExactly({ header: 'fullName,email' }), ['fullName,email']],
  ['VALIDATION_FAILED.columnCount', V.columnCount({ expected: 9, found: 3 }), ['9', '3']],
  ['VALIDATION_FAILED.nameRequired', V.nameRequired, []],
  ['VALIDATION_FAILED.notAnEmail', V.notAnEmail({ value: 'not-an-email' }), ['"not-an-email"']],
  ['VALIDATION_FAILED.agentCodeRequired', V.agentCodeRequired, []],
  ['VALIDATION_FAILED.notAnAgentCode', V.notAnAgentCode({ value: 'PRU-1' }), ['"PRU-1"', '3', '32']],
  ['VALIDATION_FAILED.notARung', V.notARung({ value: 'senior manager' }), ['"senior manager"', 'AB, AAB']],
  ['VALIDATION_FAILED.birthDateRequired', V.birthDateRequired, []],
  ['VALIDATION_FAILED.joinMonthRequired', V.joinMonthRequired, []],
  ['VALIDATION_FAILED.notAWorkStatus', V.notAWorkStatus({ value: 'fulltime' }), ['"fulltime"', 'full-time', 'part-time']],
  ['VALIDATION_FAILED.workStatusRequired', V.workStatusRequired, ['full-time', 'part-time']],
  ['VALIDATION_FAILED.notAGender', V.notAGender({ value: 'f' }), ['"f"', 'male', 'female']],
  ['VALIDATION_FAILED.genderRequired', V.genderRequired, ['male', 'female']],
  ['VALIDATION_FAILED.alreadyOnLine', V.alreadyOnLine({ line: 2 }), ['2']],
  ['VALIDATION_FAILED.notALadderRung', V.notALadderRung({ role: 'SM', rungs: ['AAB', 'AB', 'AGENT'] }),
    ['"SM"', 'AAB, AB, AGENT']],
  ['VALIDATION_FAILED.emailHasAccount', V.emailHasAccount, []],
  ['VALIDATION_FAILED.agentCodeHeld', V.agentCodeHeld({ email: 'rina@kpm.test' }), ['rina@kpm.test']],
  ['VALIDATION_FAILED.agentCodeHeldElsewhere', V.agentCodeHeldElsewhere, []],
  ['VALIDATION_FAILED.leaderNotFound', V.leaderNotFound({ code: '88001' }), ['88001']],
  ['VALIDATION_FAILED.leaderLoop', V.leaderLoop, []],
  ['VALIDATION_FAILED.pastLimitForSuperAdmin', V.pastLimitForSuperAdmin({ max: 10, used: 1 }), ['10', 'Agent']],
  ['VALIDATION_FAILED.pastLimitForSuperAdmin', V.pastLimitForSuperAdmin({ max: 10, used: 9 }), ['10', '9']],
  ['VALIDATION_FAILED.pastLimitForOffice', V.pastLimitForOffice({ max: 10, used: 1 }), ['10', 'AgencyBoost']],
  ['VALIDATION_FAILED.pastLimitForOffice', V.pastLimitForOffice({ max: 10, used: 9 }), ['10', '9']],
];

const WORDS: [entry: keyof typeof M, sentence: Message, values: string[]][] = [
  ['unownedTag', M.unownedTag, ['KPM']],
  ['unownedTitle', M.unownedTitle({ count: 1 }), ['1']],
  ['unownedTitle', M.unownedTitle({ count: 4 }), ['4']],
  ['unownedDetail', M.unownedDetail, ['Owner']],
  ['reviewAction', M.reviewAction, []],
  ['requestTag', M.requestTag, ['KPM']],
  ['requestTitle', M.requestTitle({ count: 1 }), ['1']],
  ['requestTitle', M.requestTitle({ count: 2 }), ['2']],
  ['requestDetail', M.requestDetail, []],
  ['decideAction', M.decideAction, []],
  ['unknownPerson', M.unknownPerson, []],
  ['unknownCompany', M.unknownCompany, []],
  ['unknownOffice', M.unknownOffice, []],
];

describe('P18.98-T5 AC-2 the tenants module’s sentences', () => {
  it.each([...REFUSALS, ...WORDS])('%s is said in English and in Indonesian, its values kept as they are', (_entry, sentence, values) => {
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
    expect([...new Set(WORDS.map(([entry]) => entry))].sort()).toEqual(Object.keys(M).sort());
  });

  it('chooses its words by the value, in each language', () => {
    expect(english(R.ORG_LEVEL_TIER_IN_USE.held({ members: 1, label: 'UM' }))).toMatch(/^1 person stands on UM\./);
    expect(english(R.ORG_LEVEL_TIER_IN_USE.held({ members: 2, label: 'UM' }))).toMatch(/^2 people stand on UM\./);
    expect(indonesian(R.ORG_LEVEL_TIER_IN_USE.held({ members: 1250, label: 'UM' }))).toMatch(/^1\.250 orang berada di UM\./);
    expect(indonesian(R.TENANT_REQUEST_DECIDED.alreadyDecided({ status: 'approved' }))).toBe('Permintaan itu sudah disetujui.');
    expect(indonesian(R.TENANT_REQUEST_DECIDED.alreadyDecided({ status: 'declined' }))).toBe('Permintaan itu sudah ditolak.');
    expect(english(R.ORG_LEVEL_CODE_TAKEN.taken({ company: 'P', code: 'SM', archived: true })))
      .toBe('P already has a level with the code SM, archived. An archived code is never reused.');
    expect(indonesian(R.ORG_LEVEL_CODE_TAKEN.taken({ company: 'P', code: 'SM', archived: false })))
      .toBe('P sudah memiliki jenjang dengan kode SM.');
    expect(indonesian(R.CONFIG_RUNG_UNKNOWN.notOnTheLadder({ codes: ['X'], subject: 'section' })))
      .toMatch(/^X bukan jenjang aktif di susunan jenjang perusahaan Anda\. Bagian berlaku /);
    expect(english(V.rowsWouldNotImport({ count: 1 }))).toMatch(/^1 row would not import\./);
    expect(english(V.rowsWouldNotImport({ count: 2 }))).toMatch(/^2 rows would not import\./);
    expect(english(V.pastLimitForOffice({ max: 3, used: 1 }))).toContain('and 1 is in use already');
    expect(english(V.pastLimitForSuperAdmin({ max: 3, used: 2 }))).toContain('and 2 are in use already');
    expect(english(M.unownedTitle({ count: 1 }))).toBe('1 office has no Owner');
    expect(english(M.requestTitle({ count: 3 }))).toBe('3 offices are waiting for a decision');
    expect(indonesian(M.requestTitle({ count: 3 }))).toBe('3 KPM menunggu keputusan');
  });

  it('writes a bound’s figures in the reader’s figures: English for an English reader who chose them', () => {
    const price = V.priceRange({ min: 0, max: 100_000_000_00 });
    expect(english(price)).toBe('The price per leader must be from Rp 0 to Rp 100.000.000 a month.');
    expect(render(price, readerIn('en'))).toBe('The price per leader must be from IDR 0 to IDR 100,000,000 a month.');
    expect(indonesian(price)).toBe('Harga per leader harus dari Rp 0 sampai Rp 100.000.000 per bulan.');
    const limit = V.leaderLimitRange({ min: 1, max: 10_000 });
    expect(render(limit, readerIn('en'))).toBe('The leader limit must be a whole number from 1 to 10,000, or empty for no limit.');
    expect(indonesian(limit)).toBe('Batas leader harus bilangan bulat dari 1 sampai 10.000, atau kosong jika tanpa batas.');
  });
});
