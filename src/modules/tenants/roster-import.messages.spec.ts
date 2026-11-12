import type { Message } from '@/common/i18n/sentence';
import { MEMBER_INVITATION_WORDS } from '@/modules/notifications/member-invitation.messages';
import { english, indonesian } from '../../../test/i18n';
import { ROSTER_ROW_WORDS } from './roster-import.messages';

const W = ROSTER_ROW_WORDS;

/**
 * **What each row of a member import comes to, in both languages** (P19.3-T4 AC-8; the setup spec's §A3). Where A3 gives
 * a line, the Indonesian is A3's, verbatim; the two lines ADR-0205 §7 adapts to email say what is true here.
 */
const CASES: [entry: keyof typeof W, sentence: Message, id: string][] = [
  ['codeTwice', W.codeTwice, 'Kode muncul dua kali di file.'],
  ['roleNotOnLadder', W.roleNotOnLadder({ role: 'Agen Senior', rungs: ['Agent', 'AAB', 'AB'] }),
    'Peran "Agen Senior" tidak ada. Pakai: Agent, AAB, AB.'],
  ['uplineNotFound', W.uplineNotFound({ code: '70049999' }), 'Kode upline 70049999 tidak ada di file atau di KPM ini.'],
  ['uplineNotALeader', W.uplineNotALeader({ leaders: ['AAB', 'AB'], rung: 'Agent' }), 'Upline harus leader (AAB atau AB), bukan Agent.'],
  ['uplineRanksLower', W.uplineRanksLower({ upline: 'AAB', rung: 'AB' }), 'Upline (AAB) lebih rendah dari AB.'],
  ['needsUpline', W.needsUpline({ rungs: ['Agent', 'AAB'] }), 'Agent dan AAB perlu kode upline.'],
  ['uplineLoop', W.uplineLoop({ chain: ['7001', '7002', '7001'] }), 'Upline membentuk lingkaran: 7001 → 7002 → 7001.'],
  ['uplineSkipped', W.uplineSkipped({ code: '7001' }), 'Baris upline 7001 dilewati, jadi baris ini juga dilewati.'],
  ['noEmail', W.noEmail, 'Tanpa email: belum bisa diundang, jadi baris ini dilewati.'],
  ['ownerRole', W.ownerRole, 'Dia pemilik KPM ini, jadi perannya tidak diubah lewat impor.'],
  ['stillLeads', W.stillLeads({ count: 3 }), '3 orang melapor kepadanya. Pindahkan mereka ke leader lain terlebih dahulu.'],
  ['cell', W.cell({ column: 'Tanggal lahir', problem: 'x' }), 'Tanggal lahir: x'],
  ['notAPhone', W.notAPhone({ value: '12ab' }), '"12ab" bukan nomor WhatsApp.'],
  ['notAJoinDate', W.notAJoinDate({ value: '31/02/2020' }), '"31/02/2020" bukan tanggal. Tulis dengan format DD/MM/YYYY atau YYYY-MM-DD.'],
  ['joinDateAfterToday', W.joinDateAfterToday, 'Tanggal bergabung tidak boleh setelah hari ini.'],
  ['joinDateBeforeEarliest', W.joinDateBeforeEarliest({ year: '1980' }), 'Tanggal bergabung tidak boleh sebelum tahun 1980.'],
  ['updated', W.updated, 'Sudah ada; data diperbarui.'],
  ['emailKept', W.emailKept, 'Email tidak diubah lewat impor: orangnya sendiri yang menggantinya, lewat tautan ke alamat baru.'],
  ['phoneKept', W.phoneKept, 'Nomor WhatsApp yang sudah tercatat tetap dipakai: orangnya sendiri yang menggantinya di profil.'],
  ['noWhatsApp', W.noWhatsApp, 'Tanpa nomor WhatsApp: masuk, tapi belum bisa diingatkan lewat WhatsApp.'],
  // P19.12-T7 (ADR-0250): a bad optional cell left empty, what a row leaves out, and the invitation on WhatsApp.
  ['cellBlanked', W.cellBlanked({ column: 'No. WhatsApp', problem: '"nomor saya" bukan nomor WhatsApp.' }),
    'No. WhatsApp: "nomor saya" bukan nomor WhatsApp. Dikosongkan; sisa barisnya tetap masuk.'],
  ['missingDetails', W.missingDetails({ fields: 'Tanggal lahir, Jenis kelamin' }),
    'Data belum lengkap: Tanggal lahir, Jenis kelamin kosong. Impor ulang barisnya untuk melengkapi.'],
  ['noEmailNotEntry', W.noEmailNotEntry({ entry: 'Agent' }),
    'Tanpa email: hanya Agent yang bisa diundang lewat WhatsApp, jadi baris ini dilewati. Isi email-nya.'],
  ['noEmailNoWhatsApp', W.noEmailNoWhatsApp,
    'Tanpa email dan nomor WhatsApp: belum bisa diundang, jadi baris ini dilewati. Isi email-nya, atau nomor WhatsApp-nya '
    + 'untuk mengundangnya lewat WhatsApp.'],
  ['invitedByWhatsApp', W.invitedByWhatsApp,
    'Tanpa email: diundang lewat WhatsApp. Dia mendaftar lewat tautannya dengan email dan kata sandinya sendiri.'],
  ['detailsAtRegistration', W.detailsAtRegistration({ fields: 'Tanggal lahir' }),
    'Tanggal lahir tidak disimpan: dia mengisinya sendiri saat mendaftar.'],
  ['inviteNotMade', W.inviteNotMade, 'Undangan WhatsApp tidak dapat dibuat. Undang lewat + Tambah agent di New Hires.'],
];

describe('P19.3-T4 AC-8 what each row comes to, in A3’s words', () => {
  it.each(CASES)('P19.3-T4 AC-8 / P19.12-T7 %s says A3’s line in Indonesian, and its source in English', (_entry, sentence, id) => {
    expect(indonesian(sentence)).toBe(id);
    expect(english(sentence)).toBeTruthy();
    if (_entry !== 'cell') expect(english(sentence)).not.toBe(id);
  });

  it('has a case for every entry', () => {
    expect([...new Set(CASES.map(([entry]) => entry))].sort()).toEqual(Object.keys(W).sort());
  });

  it('chooses its words by the count, in English', () => {
    expect(english(W.stillLeads({ count: 1 }))).toBe('1 person reports to them. Move them to another leader first.');
    expect(english(W.stillLeads({ count: 2 }))).toBe('2 people report to them. Move them to another leader first.');
    expect(english(W.uplineNotALeader({ leaders: ['AAB', 'AB'], rung: 'Agent' }))).toBe('The upline must be a leader (AAB or AB), not Agent.');
  });

  it('P19.12-T7 AC-2 AC-3 names the cell and the fields in English as well', () => {
    expect(english(W.cellBlanked({ column: 'Tanggal lahir', problem: 'A date of birth must be at least 18 years ago.' })))
      .toBe('Tanggal lahir: A date of birth must be at least 18 years ago. Left empty; the rest of the row is imported.');
    expect(english(W.missingDetails({ fields: 'Waktu, Jenis kelamin' })))
      .toBe('Incomplete: no Waktu, Jenis kelamin. Import the row again with them to fill them in.');
  });
});

describe('P19.3-T4 AC-11 the invitation, in both languages', () => {
  it('P19.3-T4 AC-11 names the office and how long the link works', () => {
    expect(indonesian(MEMBER_INVITATION_WORDS.subject({ office: 'BSD City Branch' }))).toBe('Anda diundang ke BSD City Branch di AgencyBoost');
    expect(english(MEMBER_INVITATION_WORDS.subject({ office: '' }))).toBe('You are invited to AgencyBoost');
    expect(english(MEMBER_INVITATION_WORDS.open({ office: '' }))).toContain('Your KPM has added you');
    expect(indonesian(MEMBER_INVITATION_WORDS.open({ office: '' }))).toContain('KPM Anda telah menambahkan Anda');
    expect(indonesian(MEMBER_INVITATION_WORDS.expires({ days: 7 }))).toContain('selama 7 hari');
    expect(english(MEMBER_INVITATION_WORDS.expires({ days: 7 }))).toContain('for 7 days');
  });
});
