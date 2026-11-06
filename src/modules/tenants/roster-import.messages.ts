import { formatNumber } from '@/common/format/format';
import { messages } from '@/common/i18n/sentence';

/** A count in an Indonesian sentence: grouped the Indonesian way once it reaches a thousand (*1.250*). */
const idCount = (n: number) => formatNumber(n, undefined, 'id');

/**
 * **What each row of a member import comes to, in both languages** (P19.3-T4; ADR-0205 §5 to §8; the setup spec's §A3,
 * moved to the Owner and the Admin by the 3 November handover's §B2 note).
 *
 * **The Indonesian is A3's, verbatim**, where A3 gives a line: *Kode muncul dua kali di file.*, *Peran "Agen Senior"
 * tidak ada. Pakai: Agent, AAB, AB.*, *Kode upline 70049999 tidak ada di file atau di KPM ini.*, *Upline harus leader
 * (AAB atau AB), bukan Agent.*, *Upline (AAB) lebih rendah dari AB.*, *Agent dan AAB perlu kode upline.*, *Sudah ada;
 * data diperbarui.* **Two of A3's lines are adapted to what is true here** (ADR-0205 §7): a row with no WhatsApp number
 * is imported and *belum bisa diingatkan lewat WhatsApp* — invitations go by email (ADR-0010) — and a new person's row
 * with no email is skipped, since an account signs in by it. The English is the source the API writes, as everywhere.
 *
 * Not refusals: a row is skipped, updated or imported, and its words say which and why. A file the import cannot read
 * at all is refused with `TENANTS_REFUSALS.VALIDATION_FAILED`'s sentences instead.
 */
export const ROSTER_ROW_WORDS = messages('modules/tenants roster rows', {
  /** A code a row earlier in the file already has: this row is skipped, the first one stands. */
  codeTwice: {
    en: 'This code appears twice in the file.',
    id: 'Kode muncul dua kali di file.',
  },
  /** `rungs`: the company ladder's own rungs, junior first, by the name a role is called (`shortOfRung`). */
  roleNotOnLadder: ({ role, rungs }: { role: string; rungs: readonly string[] }) => ({
    en: `Role "${role}" does not exist. Use: ${rungs.join(', ')}.`,
    id: `Peran "${role}" tidak ada. Pakai: ${rungs.join(', ')}.`,
  }),
  uplineNotFound: ({ code }: { code: string }) => ({
    en: `Upline code ${code} is in neither the file nor this KPM.`,
    id: `Kode upline ${code} tidak ada di file atau di KPM ini.`,
  }),
  /** `leaders`: the ladder's leader rungs, junior first; `rung` the upline's own. */
  uplineNotALeader: ({ leaders, rung }: { leaders: readonly string[]; rung: string }) => ({
    en: `The upline must be a leader (${leaders.join(' or ')}), not ${rung}.`,
    id: `Upline harus leader (${leaders.join(' atau ')}), bukan ${rung}.`,
  }),
  uplineRanksLower: ({ upline, rung }: { upline: string; rung: string }) => ({
    en: `The upline (${upline}) ranks below ${rung}.`,
    id: `Upline (${upline}) lebih rendah dari ${rung}.`,
  }),
  /** `rungs`: every rung but the top leader tier's, junior first. */
  needsUpline: ({ rungs }: { rungs: readonly string[] }) => ({
    en: `${rungs.join(' and ')} need an upline code.`,
    id: `${rungs.join(' dan ')} perlu kode upline.`,
  }),
  /** `chain`: the codes round the loop, the row's own first and last. */
  uplineLoop: ({ chain }: { chain: readonly string[] }) => ({
    en: `The uplines go round in a loop: ${chain.join(' → ')}.`,
    id: `Upline membentuk lingkaran: ${chain.join(' → ')}.`,
  }),
  /** A row whose upline's own row is skipped: it would have nobody to report to (ADR-0205 §5). */
  uplineSkipped: ({ code }: { code: string }) => ({
    en: `The upline's row (${code}) is skipped, so this one is too.`,
    id: `Baris upline ${code} dilewati, jadi baris ini juga dilewati.`,
  }),
  /** A new person's row with no email (ADR-0205 §7): an account signs in by it, and the invitation goes there. */
  noEmail: {
    en: 'No email: they cannot be invited, so the row is skipped.',
    id: 'Tanpa email: belum bisa diundang, jadi baris ini dilewati.',
  },
  /** The update of the office's Owner that would change their rung (`RoleChangeService`'s refusal, as a row's reason). */
  ownerRole: {
    en: 'They own this KPM, so an import does not change their role.',
    id: 'Dia pemilik KPM ini, jadi perannya tidak diubah lewat impor.',
  },
  /** A row moving somebody who still leads people onto a rung that leads nobody. */
  stillLeads: ({ count }: { count: number }) => ({
    en: `${count} ${count === 1 ? 'person reports' : 'people report'} to them. Move them to another leader first.`,
    id: `${idCount(count)} orang melapor kepadanya. Pindahkan mereka ke leader lain terlebih dahulu.`,
  }),
  /** A cell given in a shape the column does not take: `column` its header, `problem` what is wrong. */
  cell: ({ column, problem }: { column: string; problem: string }) => ({
    en: `${column}: ${problem}`,
    id: `${column}: ${problem}`,
  }),
  notAPhone: ({ value }: { value: string }) => ({
    en: `"${value}" is not a WhatsApp number.`,
    id: `"${value}" bukan nomor WhatsApp.`,
  }),
  notAJoinDate: ({ value }: { value: string }) => ({
    en: `"${value}" is not a date. Write it DD/MM/YYYY or YYYY-MM-DD.`,
    id: `"${value}" bukan tanggal. Tulis dengan format DD/MM/YYYY atau YYYY-MM-DD.`,
  }),
  joinDateAfterToday: {
    en: 'The join date cannot be after today.',
    id: 'Tanggal bergabung tidak boleh setelah hari ini.',
  },
  joinDateBeforeEarliest: ({ year }: { year: string }) => ({
    en: `The join date cannot be before ${year}.`,
    id: `Tanggal bergabung tidak boleh sebelum tahun ${year}.`,
  }),

  /** **Updated** (A3): a code already in this KPM. Blank cells keep what is stored. */
  updated: {
    en: 'Already here; details updated.',
    id: 'Sudah ada; data diperbarui.',
  },
  /** **An update never changes an email** (ADR-0181; ADR-0205 §5): a different one on the row is not applied. */
  emailKept: {
    en: 'The email is not changed by an import: the person changes it themselves, through a link sent to the new address.',
    id: 'Email tidak diubah lewat impor: orangnya sendiri yang menggantinya, lewat tautan ke alamat baru.',
  },
  /** A number already on file stays (D-22, M1): changing it is the person's own act, on their profile. */
  phoneKept: {
    en: 'The WhatsApp number on file is kept: the person changes it on their profile.',
    id: 'Nomor WhatsApp yang sudah tercatat tetap dipakai: orangnya sendiri yang menggantinya di profil.',
  },
  /** **Imported with no number** — A3's line, adapted: invitations go by email, so the number is for reminders. */
  noWhatsApp: {
    en: 'No WhatsApp number: imported, but cannot be reminded on WhatsApp yet.',
    id: 'Tanpa nomor WhatsApp: masuk, tapi belum bisa diingatkan lewat WhatsApp.',
  },
});

