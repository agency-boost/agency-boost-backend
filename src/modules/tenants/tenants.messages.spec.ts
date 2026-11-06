import { readerIn } from '@/common/i18n/reader';
import { render, type Message } from '@/common/i18n/sentence';
import { english, indonesian } from '../../../test/i18n';
import { TENANTS_MESSAGES, TENANTS_REFUSALS } from './tenants.messages';

const R = TENANTS_REFUSALS;
const V = R.VALIDATION_FAILED;
const M = TENANTS_MESSAGES;

/**
 * **Every sentence the tenants module writes, in both languages** (P18.10-T5 AC-2, AC-4): each refusal, each row's
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
  // P19-T3 AC-4 (ADR-0191 §4): the office holding the code is named, then its company.
  ['TENANT_CODE_TAKEN.taken', R.TENANT_CODE_TAKEN.taken({ code: '1001', kpm: 'KPM 1001 · stellar', company: 'Prudential' }),
    ['1001', 'KPM 1001 · stellar', 'Prudential']],
  ['TENANT_REQUEST_IN_PROGRESS.beingApproved', R.TENANT_REQUEST_IN_PROGRESS.beingApproved, []],
  // P19.4-T3 (ADR-0212): the Owner's invitation and a new Owner's agent code.
  ['TENANT_OWNER_NOT_INVITABLE.noOwner', R.TENANT_OWNER_NOT_INVITABLE.noOwner, ['Ganti pemilik']],
  ['TENANT_OWNER_NOT_INVITABLE.noEmail', R.TENANT_OWNER_NOT_INVITABLE.noEmail({ name: 'Wulan Kartika' }), ['Wulan Kartika']],
  ['TENANT_OWNER_NOT_INVITABLE.signedIn', R.TENANT_OWNER_NOT_INVITABLE.signedIn({ name: 'Wulan Kartika' }), ['Wulan Kartika']],
  ['AGENT_CODE_TAKEN.ownerCode', R.AGENT_CODE_TAKEN.ownerCode({ agentCode: '70045001', company: 'Prudential' }),
    ['70045001', 'Prudential']],
  ['TENANT_COMPANY_MISMATCH.askOwnCompany', R.TENANT_COMPANY_MISMATCH.askOwnCompany({ company: 'Manulife' }),
    ['Manulife']],
  ['TENANT_COMPANY_MISMATCH.ownerOtherCompany',
    R.TENANT_COMPANY_MISMATCH.ownerOtherCompany({ name: 'Victor Gunawan', userCompany: 'Manulife', kpmCompany: 'Prudential' }),
    ['Victor Gunawan', 'Manulife', 'Prudential']],
  ['TENANT_COMPANY_MISMATCH.ownerNoCompany', R.TENANT_COMPANY_MISMATCH.ownerNoCompany({ name: 'Victor Gunawan' }),
    ['Victor Gunawan']],
  ['TENANT_NOT_EMPTY.cannotMove', R.TENANT_NOT_EMPTY.cannotMove({ members: 1 }), ['1']],
  ['TENANT_NOT_EMPTY.cannotMove', R.TENANT_NOT_EMPTY.cannotMove({ members: 3 }), ['3']],
  ['TENANT_NOT_EMPTY.cannotDelete', R.TENANT_NOT_EMPTY.cannotDelete({ members: 1, records: 1 }), ['1']],
  ['TENANT_NOT_EMPTY.cannotDelete', R.TENANT_NOT_EMPTY.cannotDelete({ members: 0, records: 12 }), ['0', '12']],
  ['VALIDATION_FAILED.chooseCompany', V.chooseCompany, []],
  ['VALIDATION_FAILED.sameCompany', V.sameCompany, []],
  ['VALIDATION_FAILED.searchTwoCharacters', V.searchTwoCharacters, []],
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
  // P19.4-T5 (ADR-0213 §2): a rung's delete refused — live, or named by records of each kind, counted.
  ['INTERNAL_ERROR.ladderCannotSearch', R.INTERNAL_ERROR.ladderCannotSearch, []],
  ['ORG_LEVEL_IN_USE.stillActive', R.ORG_LEVEL_IN_USE.stillActive({ label: 'Agency Builder' }), ['Agency Builder']],
  ['ORG_LEVEL_IN_USE.named', R.ORG_LEVEL_IN_USE.named({
    label: 'AB', references: [{ kind: 'memberships', count: 1 }],
  }), ['AB', '1']],
  ['ORG_LEVEL_IN_USE.named', R.ORG_LEVEL_IN_USE.named({
    label: 'AB', references: [{ kind: 'memberships', count: 1250 }, { kind: 'companyTemplates', count: 2 }],
  }), ['AB', '2']],
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
  // P19.3-T4 (ADR-0205): the member import's refusals of a whole file, and each cell's problem, which skips its row.
  ['VALIDATION_FAILED.fileUnreadable', V.fileUnreadable, []],
  ['VALIDATION_FAILED.nothingToImport', V.nothingToImport, []],
  // ADR-0184: the roster as a file.
  ['VALIDATION_FAILED.attachRosterFile', V.attachRosterFile, ['`file`', '.xlsx', '.csv']],
  ['VALIDATION_FAILED.rosterNotAForm', V.rosterNotAForm, ['`file`']],
  ['VALIDATION_FAILED.unknownTemplateFormat', V.unknownTemplateFormat, ['format=xlsx', 'format=csv']],
  ['ASSET_TOO_LARGE.rosterTooLarge', R.ASSET_TOO_LARGE.rosterTooLarge({ mb: 1 }), ['1 MB']],
  ['VALIDATION_FAILED.headerOnly', V.headerOnly, []],
  ['VALIDATION_FAILED.fileEmpty', V.fileEmpty, []],
  ['VALIDATION_FAILED.missingColumns', V.missingColumns({ columns: 'Kode agen, Peran' }), ['Kode agen, Peran']],
  ['VALIDATION_FAILED.unknownColumns', V.unknownColumns({ columns: ['Tangal lahir'], accepted: ['Kode agen', 'Nama'] }),
    ['"Tangal lahir"', 'Kode agen, Nama']],
  ['VALIDATION_FAILED.columnTwice', V.columnTwice({ column: 'Nama' }), ['Nama']],
  ['VALIDATION_FAILED.columnCount', V.columnCount({ expected: 11, found: 3 }), ['11', '3']],
  ['VALIDATION_FAILED.nameRequired', V.nameRequired, []],
  ['VALIDATION_FAILED.roleRequired', V.roleRequired, []],
  ['VALIDATION_FAILED.notAnEmail', V.notAnEmail({ value: 'not-an-email' }), ['"not-an-email"']],
  ['VALIDATION_FAILED.agentCodeRequired', V.agentCodeRequired, []],
  ['VALIDATION_FAILED.notAnAgentCode', V.notAnAgentCode({ value: 'PRU-1' }), ['"PRU-1"', '3', '32']],
  ['VALIDATION_FAILED.notTemplateCode', V.notTemplateCode({ value: '7004510', example: '70012345' }), ['"7004510"', '70012345']],
  ['VALIDATION_FAILED.ownerNameShort', V.ownerNameShort, ['owner.fullName']],
  ['VALIDATION_FAILED.ownerPhoneShape', V.ownerPhoneShape, ['owner.phone', '+62']],
  ['VALIDATION_FAILED.ownerAgentCodeShape', V.ownerAgentCodeShape, ['owner.agentCode']],
  ['VALIDATION_FAILED.ownerAgentCodeNeeded', V.ownerAgentCodeNeeded, []],
  ['VALIDATION_FAILED.ownerEmailNeeded', V.ownerEmailNeeded, ['owner.email']],
  ['VALIDATION_FAILED.notAWorkStatus', V.notAWorkStatus({ value: 'fulltime' }), ['"fulltime"', 'Full-time', 'Part-time']],
  ['VALIDATION_FAILED.notAGender', V.notAGender({ value: 'f' }), ['"f"', 'male', 'female']],
  ['VALIDATION_FAILED.alreadyOnLine', V.alreadyOnLine({ line: 2 }), ['2']],
  ['VALIDATION_FAILED.emailHasAccount', V.emailHasAccount, []],
  ['VALIDATION_FAILED.agentCodeHeld', V.agentCodeHeld({ email: 'rina@kpm.test' }), ['rina@kpm.test']],
  ['VALIDATION_FAILED.agentCodeHeldElsewhere', V.agentCodeHeldElsewhere, []],
  ['VALIDATION_FAILED.pastLimitForOffice', V.pastLimitForOffice({ max: 10, used: 1 }), ['10', 'AgencyBoost']],
  ['VALIDATION_FAILED.pastLimitForOffice', V.pastLimitForOffice({ max: 10, used: 9 }), ['10', '9']],
  // ADR-0211 §1 (P19.4-T3 AC-10): *Paket*'s refusal.
  ['VALIDATION_FAILED.planOneOf', V.planOneOf, ['6']],
];

const WORDS: [entry: keyof typeof M, sentence: Message, values: string[]][] = [
  ['unownedTag', M.unownedTag, ['KPM']],
  ['noOwnerTitle', M.noOwnerTitle({ code: '0602' }), ['0602', 'Owner']],
  ['noOwnerDetail', M.noOwnerDetail, ['Owner']],
  ['pendingOwnerDetail', M.pendingOwnerDetail({ name: 'Wulan Kartika' }), ['Wulan Kartika', 'Ganti pemilik']],
  ['noMembersTag', M.noMembersTag, []],
  ['noMembersTitle', M.noMembersTitle({ code: '0602' }), ['0602']],
  ['noMembersDetail', M.noMembersDetail, ['People']],
  ['openOfficeAction', M.openOfficeAction, ['KPM']],
  ['requestTag', M.requestTag, ['KPM']],
  ['requestTitle', M.requestTitle({ count: 1 }), ['1']],
  ['requestTitle', M.requestTitle({ count: 2 }), ['2']],
  ['requestDetail', M.requestDetail, []],
  ['decideAction', M.decideAction, []],
  ['unknownPerson', M.unknownPerson, []],
  ['unknownCompany', M.unknownCompany, []],
  ['unknownOffice', M.unknownOffice, []],
];

describe('P18.10-T5 AC-2 the tenants module’s sentences', () => {
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
    expect(english(V.unknownColumns({ columns: ['A', 'B'], accepted: ['Nama'] }))).toBe('"A", "B": not a column of the template. Its columns are Nama.');
    expect(english(V.pastLimitForOffice({ max: 3, used: 1 }))).toContain('and 1 is in use already');
    expect(english(V.pastLimitForOffice({ max: 3, used: 2 }))).toContain('and 2 are in use already');
    // P19.4-T3 AC-8 (SA R5): one row per KPM, in the report's words.
    expect(indonesian(M.noOwnerTitle({ code: '0602' }))).toBe('KPM 0602 belum punya Owner');
    expect(indonesian(M.noMembersTitle({ code: '0602' }))).toBe('KPM 0602 belum punya anggota');
    // P19.4-T3 AC-7 (A5-2): the setup spec's sentence, then the KPM holding the code (OD-246).
    expect(indonesian(R.TENANT_CODE_TAKEN.taken({ code: '0417', kpm: 'KPM 0417 · Gading Serpong', company: 'Prudential' })))
      .toBe('Kode 0417 sudah dipakai KPM lain di Prudential: KPM 0417 · Gading Serpong.');
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
