import { formatNumber, formatRupiah } from '@/common/format/format';
import { messages, refusals } from '@/common/i18n/sentence';
import type { OrgLevelReferenceKind } from './org-level-references.port';

/** A count in an Indonesian sentence: grouped the Indonesian way once it reaches a thousand (*1.250*). */
const idCount = (n: number) => formatNumber(n, undefined, 'id');

/** What a rung applies to, in each language: a ratio keeps its name (§A.6), a section is a *bagian*. */
const SUBJECT_ID = { ratio: 'Ratio', section: 'Bagian' } as const;

/** Each kind of record that can name a rung (ADR-0213 §2), as a refusal counts it — after its number. */
const REFERENCE_EN: Record<OrgLevelReferenceKind, string> = {
  memberships: 'membership(s)',
  membershipHistory: 'role history entr(ies)',
  leaderLimitRequests: 'leader-limit request(s)',
  activityCategories: 'KPM activity section(s)',
  ratioDefinitions: 'KPM ratio(s)',
  configSnapshots: 'published KPM setting(s)',
  campaigns: 'KPM campaign(s)',
  qualificationRules: 'carrier rule(s)',
  companyTemplates: 'template version(s) or draft(s)',
};
const REFERENCE_ID: Record<OrgLevelReferenceKind, string> = {
  memberships: 'keanggotaan',
  membershipHistory: 'riwayat peran',
  leaderLimitRequests: 'permintaan batas leader',
  activityCategories: 'bagian aktivitas KPM',
  ratioDefinitions: 'ratio KPM',
  configSnapshots: 'pengaturan KPM yang diterbitkan',
  campaigns: 'campaign KPM',
  qualificationRules: 'aturan campaign perusahaan',
  companyTemplates: 'versi atau draf template',
};

/**
 * **The tenants module's refusals, in both languages** (P18.10-T5 AC-2, AC-3): companies and offices, the company's
 * role ladder, KPM requests, an office's subscription, and the roster import — its refusal and its per-row issues,
 * which the preview shows and the commit refuses with. An office is a *KPM* (§B.9), a rung a *jenjang* and the ladder
 * the *susunan jenjang*; a field and a file's column are named as the API names them (`startDate`, `agentCode`), and a
 * file's own words (`full-time`, `male`) stay as the file writes them.
 */
export const TENANTS_REFUSALS = refusals('modules/tenants', {
  PERM_DENIED: {
    cannotDoThat: {
      en: 'You cannot do that.',
      id: 'Anda tidak dapat melakukan itu.',
    },
    noPermissionForThat: {
      en: 'You do not have permission to do that.',
      id: 'Anda tidak memiliki izin untuk melakukan itu.',
    },
    importRoster: {
      en: 'You do not have permission to import a roster.',
      id: 'Anda tidak memiliki izin untuk mengimpor roster.',
    },
  },
  COMPANY_SLUG_TAKEN: {
    taken: ({ slug, existingName }: { slug: string; existingName: string }) => ({
      en: `The slug "${slug}" already belongs to ${existingName}. Edit the slug to something unique.`,
      id: `Slug "${slug}" sudah dipakai oleh ${existingName}. Ubah slug menjadi sesuatu yang unik.`,
    }),
  },
  COMPANY_IS_TEMPLATE_LIBRARY: {
    holdsNoOffice: ({ name }: { name: string }) => ({
      en: `${name} is the Template library: it holds the templates new companies and offices copy, and no `
        + 'office. Choose the insurer the office belongs to.',
      id: `${name} adalah Template library: isinya template yang disalin perusahaan dan KPM baru, dan tidak ada KPM `
        + 'di dalamnya. Pilih perusahaan asuransi tempat KPM ini bernaung.',
    }),
  },
  TENANT_CODE_TAKEN: {
    /**
     * **Names the office that holds the code** (ADR-0191 §4, P19-T3 AC-4; OD-246): the company alone read as if the
     * company were the clash — *"sudah dipakai oleh Prudential"* — and the Super Admin had to go and find which office.
     */
    taken: ({ code, kpm, company }: { code: string; kpm: string; company: string }) => ({
      // *Changed 2026-11-05 (P19.4-T3 AC-7; the setup spec's A5-2, ADR-0212 §1):* A5-2's sentence, *"Kode 0417 sudah
      // dipakai KPM lain di Prudential."*, then the office that holds it, which OD-246's default keeps naming.
      en: `Code ${code} is already used by another KPM at ${company}: ${kpm}.`,
      id: `Kode ${code} sudah dipakai KPM lain di ${company}: ${kpm}.`,
    }),
  },
  TENANT_REQUEST_IN_PROGRESS: {
    beingApproved: {
      en: 'This request is being approved right now. Wait a moment, then reload: pressing again answers the office it made.',
      id: 'Permintaan ini sedang disetujui. Tunggu sebentar, lalu muat ulang: menekan lagi akan menampilkan KPM yang dibuatnya.',
    },
  },
  TENANT_COMPANY_MISMATCH: {
    /** The applicant asked for an office of another company than the one they signed up with (P19-T2 AC-3). */
    askOwnCompany: ({ company }: { company: string }) => ({
      en: `You signed up with ${company}, so the office you ask for is ${company}'s.`,
      id: `Anda mendaftar di ${company}, jadi KPM yang Anda ajukan adalah milik ${company}.`,
    }),
    /** An Owner — by approval, *Ganti Owner* or a move — whose account belongs to another company (P19-T3). */
    ownerOtherCompany: ({ name, userCompany, kpmCompany }: { name: string; userCompany: string; kpmCompany: string }) => ({
      en: `${name} signed up with ${userCompany}, and this office is ${kpmCompany}'s. An office admits only its own `
        + `company's agents: choose ${userCompany} for it, or another person.`,
      id: `${name} mendaftar di ${userCompany}, sedangkan KPM ini milik ${kpmCompany}. KPM hanya menerima agen dari `
        + `perusahaannya sendiri: pilih ${userCompany} untuk KPM ini, atau orang lain.`,
    }),
    /** The same, for an account that never chose a company or holds no agent code — a Super Admin's, an old one. */
    ownerNoCompany: ({ name }: { name: string }) => ({
      en: `${name}'s account has no company or no agent code, so they cannot own an office. They complete their `
        + 'details first.',
      id: `Akun ${name} belum memiliki perusahaan atau kode agen, jadi belum dapat menjadi Owner KPM. Dia perlu `
        + 'melengkapi datanya terlebih dahulu.',
    }),
  },
  /** *Kirim ulang undangan* with nobody to send it to (ADR-0212 §2, §3; P19.4-T3 AC-6). */
  TENANT_OWNER_NOT_INVITABLE: {
    noOwner: {
      en: 'This KPM has no Owner to invite. Set one with "Ganti pemilik".',
      id: 'KPM ini belum punya Owner untuk diundang. Tetapkan lewat "Ganti pemilik".',
    },
    noEmail: ({ name }: { name: string }) => ({
      en: `${name} has no email yet, and an invitation goes by email. Give one with "Ganti pemilik".`,
      id: `${name} belum punya email, dan undangan dikirim lewat email. Isi emailnya lewat "Ganti pemilik".`,
    }),
    signedIn: ({ name }: { name: string }) => ({
      en: `${name} has already signed in, so there is nothing to invite them to.`,
      id: `${name} sudah pernah masuk, jadi tidak perlu diundang lagi.`,
    }),
  },
  /** A new Owner's account would take an agent code another account of the company holds (ADR-0212 §2). */
  AGENT_CODE_TAKEN: {
    ownerCode: ({ agentCode, company }: { agentCode: string; company: string }) => ({
      en: `Agent code ${agentCode} already belongs to another account at ${company}. Type that person's email to make `
        + 'them the Owner, or check the code.',
      id: `Kode agen ${agentCode} sudah dimiliki akun lain di ${company}. Ketik email orang itu untuk menjadikannya `
        + 'Owner, atau periksa kodenya.',
    }),
  },
  TENANT_NOT_EMPTY: {
    /** A move allows the Owner alone (ADR-0191 §5, P19-T3 AC-6). */
    cannotMove: ({ members }: { members: number }) => ({
      en: `This office has ${members} ${members === 1 ? 'member' : 'members'} besides its Owner, so it cannot move to `
        + 'another company: their agent codes are their insurer\'s. Move it only while it is empty.',
      id: `KPM ini memiliki ${idCount(members)} anggota selain Owner-nya, jadi tidak dapat dipindahkan ke perusahaan lain: `
        + 'kode agen mereka milik perusahaan asuransinya. Pindahkan hanya selama KPM masih kosong.',
    }),
    /** A delete allows nobody and nothing (ADR-0191 §5, P19-T3 AC-7). */
    cannotDelete: ({ members, records }: { members: number; records: number }) => ({
      en: `This office has ${members} ${members === 1 ? 'member' : 'members'} and ${records} `
        + `${records === 1 ? 'record' : 'records'}, so it cannot be deleted. Archive it instead.`,
      id: `KPM ini memiliki ${idCount(members)} anggota dan ${idCount(records)} data, jadi tidak dapat dihapus. `
        + 'Arsipkan saja.',
    }),
  },
  PERM_LAST_OWNER: {
    alwaysAnOwner: {
      en: 'A KPM must always have an Owner. Transfer ownership instead of removing it.',
      id: 'KPM harus selalu memiliki Owner. Pindahkan kepemilikan alih-alih menghapusnya.',
    },
  },
  ORG_AGENT_ALREADY_TAGGED: {
    alreadyInOffice: {
      en: 'You are already registered to an office.',
      id: 'Anda sudah terdaftar di sebuah KPM.',
    },
  },
  TENANT_REQUEST_ALREADY_OPEN: {
    alreadyAsked: {
      en: 'You have already asked for an office. Wait for that one to be decided.',
      id: 'Anda sudah mengajukan permintaan KPM. Tunggu sampai permintaan itu diputuskan.',
    },
  },
  TENANT_REQUEST_DECIDED: {
    alreadyDecided: ({ status }: { status: 'approved' | 'declined' }) => ({
      en: `That request was already ${status}.`,
      id: `Permintaan itu sudah ${status === 'approved' ? 'disetujui' : 'ditolak'}.`,
    }),
  },
  CONFIG_RUNG_UNKNOWN: {
    notOnTheLadder: ({ codes, subject }: { codes: readonly string[]; subject: 'ratio' | 'section' }) => ({
      en: `${codes.join(', ')} is not an active rung on your company’s ladder. A `
        + `${subject} applies to rungs the company promotes people along; the platform `
        + 'defines those, not the office.',
      id: `${codes.join(', ')} bukan jenjang aktif di susunan jenjang perusahaan Anda. ${SUBJECT_ID[subject]} berlaku `
        + 'untuk jenjang tempat perusahaan mempromosikan orang; platform yang menetapkannya, bukan KPM.',
    }),
  },
  ORG_LEVEL_NOT_ON_LADDER: {
    noOwnerRung: {
      en: "This company's ladder has no Senior Leader rung for an office's Owner.",
      id: 'Susunan jenjang perusahaan ini tidak memiliki jenjang Senior Leader untuk Owner KPM.',
    },
    noJoinerRung: {
      en: "This company's ladder has no rung that leads nobody, for somebody joining.",
      id: 'Susunan jenjang perusahaan ini tidak memiliki jenjang yang tidak memimpin siapa pun, untuk orang yang '
        + 'bergabung.',
    },
    noLevel: ({ code }: { code: string }) => ({
      en: `No active level with the code ${code} on this company's ladder.`,
      id: `Tidak ada jenjang aktif dengan kode ${code} di susunan jenjang perusahaan ini.`,
    }),
  },
  ORG_LEVEL_CODE_TAKEN: {
    taken: ({ company, code, archived }: { company: string; code: string; archived: boolean }) => ({
      en: `${company} already has a level with the code ${code}`
        + (archived ? ', archived. An archived code is never reused.' : '.'),
      id: `${company} sudah memiliki jenjang dengan kode ${code}`
        + (archived ? ', yang sudah diarsipkan. Kode yang diarsipkan tidak pernah dipakai ulang.' : '.'),
    }),
  },
  ORG_LEVEL_TIER_IN_USE: {
    held: ({ members, label }: { members: number; label: string }) => ({
      en: `${members} ${members === 1 ? 'person stands' : 'people stand'} on ${label}. Its leader tier `
        + 'decides what they may do, so it cannot change while anybody holds it. Move them to another '
        + 'rung first, or add a new rung.',
      id: `${idCount(members)} orang berada di ${label}. Tingkat leader-nya menentukan apa yang boleh mereka lakukan, `
        + 'jadi tidak dapat diubah selama masih ada yang menempatinya. Pindahkan mereka ke jenjang lain terlebih dahulu, '
        + 'atau tambahkan jenjang baru.',
    }),
  },
  /**
   * **A rung that cannot be deleted, and why** (ADR-0213 §2, P19.4-T5 AC-2): a live one is archived first; an archived one
   * something names is refused with what names it, each kind in the reader's words and counted.
   */
  ORG_LEVEL_IN_USE: {
    stillActive: ({ label }: { label: string }) => ({
      en: `${label} is still in use on the ladder. Archive it first; only an archived rung that nothing names can be `
        + 'deleted.',
      id: `${label} masih aktif di susunan jenjang. Arsipkan dulu; hanya jenjang yang sudah diarsipkan dan tidak dipakai `
        + 'apa pun yang dapat dihapus.',
    }),
    named: ({ label, references }: { label: string; references: readonly { kind: OrgLevelReferenceKind; count: number }[] }) => ({
      en: `${label} cannot be deleted: ${references.map((r) => `${r.count} ${REFERENCE_EN[r.kind]}`).join(', ')} still `
        + `name${references.length === 1 && references[0].count === 1 ? 's' : ''} it. It stays archived, so what stands `
        + 'on it keeps its meaning.',
      id: `${label} tidak dapat dihapus: masih dipakai oleh ${references.map((r) => `${idCount(r.count)} ${REFERENCE_ID[r.kind]}`)
        .join(', ')}. Jenjang ini tetap diarsipkan, agar apa yang memakainya tetap bermakna.`,
    }),
  },
  ASSET_TOO_LARGE: {
    /** The roster's file over `ROSTER_UPLOAD.MAX_BYTES` (ADR-0184). */
    rosterTooLarge: ({ mb }: { mb: number }) => ({
      en: `The file is larger than ${mb} MB. A filled roster template is a few kilobytes — check this is the right file.`,
      id: `File ini lebih besar dari ${idCount(mb)} MB. Template roster yang sudah diisi hanya beberapa kilobyte — periksa `
        + 'apakah ini file yang benar.',
    }),
  },
  INTERNAL_ERROR: {
    ladderCannotSearch: {
      en: 'The ladder cannot tell what names a rung, so it will not delete one.',
      id: 'Susunan jenjang tidak dapat memeriksa apa yang memakai sebuah jenjang, jadi jenjang tidak akan dihapus.',
    },
    ladderCannotCount: {
      en: 'The ladder cannot tell who stands on a rung, so it will not change a leader tier.',
      id: 'Susunan jenjang tidak dapat mengetahui siapa yang berada di suatu jenjang, jadi tingkat leader tidak akan '
        + 'diubah.',
    },
  },
  VALIDATION_FAILED: {
    nothingToChange: {
      en: 'Nothing to change.',
      id: 'Tidak ada yang diubah.',
    },
    nameTheOwner: {
      en: 'Name the new owner by email or by user id.',
      id: 'Sebutkan Owner baru dengan email atau ID pengguna.',
    },
    /** A KPM request from an account with no company, naming none (ADR-0191 §1, P19-T2 AC-2). */
    chooseCompany: {
      en: 'Choose the company you work for.',
      id: 'Pilih perusahaan tempat Anda bekerja.',
    },
    /** *Pindahkan ke perusahaan lain* naming the company the office already belongs to. */
    sameCompany: {
      en: 'This office already belongs to that company.',
      id: 'KPM ini sudah milik perusahaan itu.',
    },
    /** `GET /admin/accounts?q=`: at least two characters, so the list is a search and not the platform's users. */
    searchTwoCharacters: {
      en: 'Type at least two characters of a name or an email address.',
      id: 'Ketik minimal dua karakter nama atau alamat email.',
    },
    ownerDeactivated: {
      en: 'That account is deactivated and cannot own an office.',
      id: 'Akun itu dinonaktifkan dan tidak dapat menjadi Owner KPM.',
    },
    /** *Pemilik KPM* (ADR-0212 §1; P19.4-T3 AC-6): the form's own refusals, each naming the field under `owner`. */
    ownerNameShort: {
      en: 'owner.fullName: type the owner\u2019s name, at least 2 characters.',
      id: 'owner.fullName: isi nama pemilik, minimal 2 karakter.',
    },
    ownerPhoneShape: {
      en: 'owner.phone must be an Indonesian WhatsApp number: 9 to 13 digits after +62, e.g. 0812 3456 7890.',
      id: 'owner.phone harus nomor WhatsApp Indonesia: 9 sampai 13 digit setelah +62, mis. 0812 3456 7890.',
    },
    ownerAgentCodeShape: {
      en: 'owner.agentCode: an agent code is digits only, 3 to 32 of them.',
      id: 'owner.agentCode: kode agen hanya angka, 3 sampai 32 digit.',
    },
    /** A new account is made for the Owner's email: they are the KPM's root AB, under their insurer's code. */
    ownerAgentCodeNeeded: {
      en: 'There is no account with that email yet, so one will be made: type the owner\u2019s agent code '
        + '(Kode agen pemilik).',
      id: 'Belum ada akun dengan email itu, jadi akun baru akan dibuat: isi kode agen pemilik.',
    },
    /** *Ganti pemilik* to a named person: the invitation goes by email, so an email is needed (ADR-0212 §3). */
    ownerEmailNeeded: {
      en: 'owner.email: type the new owner\u2019s email. The invitation goes there.',
      id: 'owner.email: isi email pemilik baru. Undangan dikirim ke sana.',
    },
    startFromDefaults: {
      en: 'Start from a template — the Template’s Default template holds the AgencyBoost defaults — or Empty.',
      id: 'Mulai dari template — Default template milik Template berisi pengaturan default AgencyBoost — atau Kosong.',
    },
    unknownTemplateKind: ({ kind, kinds }: { kind: string; kinds: readonly string[] }) => ({
      en: `Unknown template kind "${kind}". One of: ${kinds.join(', ')}.`,
      id: `Jenis template "${kind}" tidak dikenal. Pilih salah satu: ${kinds.join(', ')}.`,
    }),

    /* The DTOs' own sentences (`field`), each naming its field as the API names it. */
    slugShape: {
      en: 'slug must be lower-case letters and digits, separated by single hyphens',
      id: 'slug harus berupa huruf kecil dan angka, dipisahkan oleh satu tanda hubung',
    },
    rungCodeShape: {
      en: 'code must be letters, digits and underscores, starting with a letter',
      id: 'code harus berupa huruf, angka, dan garis bawah, diawali huruf',
    },
    timezoneOnly: ({ zone }: { zone: string }) => ({
      en: `timezone must be ${zone} — v1 runs on a single time zone`,
      id: `timezone harus ${zone} — v1 berjalan di satu zona waktu`,
    }),
    startDateShape: {
      en: 'startDate must be a date written YYYY-MM-DD',
      id: 'startDate harus berupa tanggal dengan format YYYY-MM-DD',
    },
    endDateShape: {
      en: 'endDate must be a date written YYYY-MM-DD',
      id: 'endDate harus berupa tanggal dengan format YYYY-MM-DD',
    },
    kpmCodeShape: {
      en: 'code must be four digits',
      id: 'code harus empat angka',
    },

    /* An office's subscription (`subscription.ts`): said under the field the Super Admin typed into. */
    startNotADay: {
      en: 'The start date is not a real day.',
      id: 'Tanggal mulai bukan tanggal yang benar.',
    },
    endNotADay: {
      en: 'The end date is not a real day.',
      id: 'Tanggal berakhir bukan tanggal yang benar.',
    },
    datesBothOrNeither: {
      en: 'Enter a start date and an end date, or neither.',
      id: 'Isi tanggal mulai dan tanggal berakhir, atau kosongkan keduanya.',
    },
    endBeforeStart: {
      en: 'The end date must be on or after the start date.',
      id: 'Tanggal berakhir harus sama dengan atau setelah tanggal mulai.',
    },
    /** Bounds in rupiah, in full — the digits the Super Admin types — in the reader's figures. */
    priceRange: ({ min, max }: { min: number; max: number }) => ({
      en: (figures) => `The price per leader must be from ${formatRupiah(min, figures)} to `
        + `${formatRupiah(max, figures)} a month.`,
      id: `Harga per leader harus dari ${formatRupiah(min, 'id')} sampai ${formatRupiah(max, 'id')} per bulan.`,
    }),
    priceWholeRupiah: {
      en: 'The price per leader must be whole rupiah, with no sen.',
      id: 'Harga per leader harus dalam rupiah bulat, tanpa sen.',
    },
    leaderLimitRange: ({ min, max }: { min: number; max: number }) => ({
      en: (figures) => `The leader limit must be a whole number from ${formatNumber(min, undefined, figures)} to `
        + `${formatNumber(max, undefined, figures)}, or empty for no limit.`,
      id: `Batas leader harus bilangan bulat dari ${formatNumber(min, undefined, 'id')} sampai `
        + `${formatNumber(max, undefined, 'id')}, atau kosong jika tanpa batas.`,
    }),
    keepActiveOnOrOff: {
      en: 'Keep active after the end date must be on or off.',
      id: 'Tetap aktif setelah tanggal berakhir harus aktif atau nonaktif.',
    },
    // P19.4-T3 (ADR-0211 §1): *Paket*, under its field.
    planOneOf: {
      en: 'Choose a plan: 6 months or annual, or none.',
      id: 'Pilih paket: 6 bulan atau Tahunan, atau tanpa paket.',
    },

    /*
     * The member import (P19.3-T4; ADR-0205): what refuses a whole file — it cannot be read, or nothing in it can be
     * imported — and each cell's own problem, which skips its row. What a row comes to otherwise is
     * `roster-import.messages.ts`'s (`ROSTER_ROW_WORDS`): rows are skipped with their reasons, not refused.
     */
    fileUnreadable: {
      en: 'The file could not be read, so nothing was imported. Fix it and upload it again.',
      id: 'File tidak dapat dibaca, jadi tidak ada yang diimpor. Perbaiki, lalu unggah lagi.',
    },
    nothingToImport: {
      en: 'No row of this file can be imported. Download the skipped rows, fix them and upload them again.',
      id: 'Tidak ada baris di file ini yang bisa diimpor. Unduh baris yang dilewati, perbaiki, lalu unggah lagi.',
    },
    /* The roster as a file (ADR-0184): the form it is sent in. */
    attachRosterFile: {
      en: 'Attach the roster as the `file` field: the filled template, as .xlsx or .csv.',
      id: 'Lampirkan roster sebagai kolom `file`: template yang sudah diisi, sebagai .xlsx atau .csv.',
    },
    rosterNotAForm: {
      en: 'The upload could not be read as a form. Send the filled template as the `file` field.',
      id: 'Unggahan tidak dapat dibaca sebagai formulir. Kirim template yang sudah diisi sebagai kolom `file`.',
    },
    /**
     * `GET /admin/tenants/roster-template?format=` naming no format it comes in (S4): the query DTO's own sentence. It
     * does not repeat the value, which arrives from a URL and could be anything, an operator object included.
     */
    unknownTemplateFormat: {
      en: 'That is not a format the roster template comes in. Ask for format=xlsx or format=csv.',
      id: 'Itu bukan format template roster. Minta format=xlsx atau format=csv.',
    },
    headerOnly: {
      en: 'That file has a header and no people in it.',
      id: 'File itu hanya berisi header, tanpa orang di dalamnya.',
    },
    fileEmpty: {
      en: 'The file is empty.',
      id: 'File ini kosong.',
    },
    /** The A3 mockup's own check: the three a row cannot be read without. `columns` the header names, joined. */
    missingColumns: ({ columns }: { columns: string }) => ({
      en: `The file has no ${columns} column. Download the template and use its header.`,
      id: `Kolom ${columns} tidak ditemukan. Unduh template dan pakai header-nya.`,
    }),
    /** A heading the import does not know: a typo would otherwise drop a column without a word. */
    unknownColumns: ({ columns, accepted }: { columns: readonly string[]; accepted: readonly string[] }) => ({
      en: `${columns.map((c) => `"${c}"`).join(', ')}: not a column of the template. Its columns are ${accepted.join(', ')}.`,
      id: `${columns.map((c) => `"${c}"`).join(', ')}: bukan kolom template. Kolom template: ${accepted.join(', ')}.`,
    }),
    columnTwice: ({ column }: { column: string }) => ({
      en: `The column ${column} appears twice.`,
      id: `Kolom ${column} muncul dua kali.`,
    }),
    columnCount: ({ expected, found }: { expected: number; found: number }) => ({
      en: `Expected ${expected} columns, found ${found}.`,
      id: `Seharusnya ${expected} kolom, ditemukan ${found}.`,
    }),
    nameRequired: {
      en: 'A name is required.',
      id: 'Nama wajib diisi.',
    },
    roleRequired: {
      en: 'A role is required.',
      id: 'Peran wajib diisi.',
    },
    notAnEmail: ({ value }: { value: string }) => ({
      en: `"${value}" is not an email address.`,
      id: `"${value}" bukan alamat email.`,
    }),
    agentCodeRequired: {
      en: 'An agent code is required.',
      id: 'Kode agen wajib diisi.',
    },
    notAnAgentCode: ({ value }: { value: string }) => ({
      en: `"${value}" is not an agent code. Use digits only, 3 to 32 of them.`,
      id: `"${value}" bukan kode agen. Gunakan angka saja, 3 sampai 32 digit.`,
    }),
    /* P19.5-T1 AC-11 (ADR-0214 §7): a code against the template's own format, once the template publishes one. */
    notTemplateCode: ({ value, example }: { value: string; example: string }) => ({
      en: `"${value}" does not match this company's agent code format, for example ${example}.`,
      id: `"${value}" tidak cocok dengan format kode agen perusahaan ini, contohnya ${example}.`,
    }),
    notAWorkStatus: ({ value }: { value: string }) => ({
      en: `"${value}" is not a work status. Use Full-time or Part-time.`,
      id: `"${value}" bukan status kerja. Gunakan Full-time atau Part-time.`,
    }),
    /* P19.12-T7 AC-1 (ADR-0250 §1): every word the import reads, `L` and `P` among them. */
    notAGender: ({ value }: { value: string }) => ({
      en: `"${value}" is not a gender. Use L or P, Laki-laki or Perempuan, or male or female.`,
      id: `"${value}" bukan jenis kelamin. Gunakan L atau P, Laki-laki atau Perempuan, atau male atau female.`,
    }),
    alreadyOnLine: ({ line }: { line: number }) => ({
      en: `Already on line ${line}.`,
      id: `Sudah ada di baris ${line}.`,
    }),
    emailHasAccount: {
      en: 'Already has an account. Import creates people; this one exists already.',
      id: 'Sudah memiliki akun. Impor membuat orang baru; orang ini sudah ada.',
    },
    /** The holder named: told to a Super Admin, or about somebody of this same office (B1). */
    agentCodeHeld: ({ email }: { email: string }) => ({
      en: `Already registered at this insurer by ${email}.`,
      id: `Sudah didaftarkan di perusahaan asuransi ini oleh ${email}.`,
    }),
    /**
     * The same, about a holder the importer may not be told of — somebody of another office (B1; A-R3, OD-257's
     * default): no identity and no office. A3's *"Sudah anggota KPM 0417. …"* waits for OD-257's answer (ADR-0205 §6).
     */
    agentCodeHeldElsewhere: {
      en: 'This agent code is already registered at this insurer.',
      id: 'Kode agen ini sudah terdaftar di perusahaan asuransi ini.',
    },
    /**
     * A row past the office's leader limit, as the office is told it: the way through that asks AgencyBoost (ADR-0157
     * §5). The Super Admin's own wording went with their import grant (P19.4-T2, ADR-0206 §2).
     */
    pastLimitForOffice: ({ max, used }: { max: number; used: number }) => ({
      en: `Your office’s leader limit is ${max} — ABs and AABs together — and `
        + `${used} ${used === 1 ? 'is' : 'are'} in use already, so this `
        + 'row would be one too many. Import them as an Agent, then promote them on their page: past the '
        + 'limit, that asks AgencyBoost to approve it.',
      id: `Batas leader KPM Anda adalah ${idCount(max)} — AB dan AAB digabung — dan ${idCount(used)} sudah terpakai, `
        + 'jadi baris ini akan melebihi batas. Impor orang ini sebagai Agent, lalu promosikan di halamannya: jika '
        + 'melewati batas, AgencyBoost akan diminta menyetujuinya.',
    }),
  },
});

/**
 * **What the platform's overview composes, in both languages** (P18.10-T5 AC-4): the *Needs your attention* queue's
 * rows, written for the Super Admin reading them. *KPM Owner* stays the role's name (§A.5).
 */
export const TENANTS_MESSAGES = messages('modules/tenants', {
  unownedTag: { en: 'KPM owner', id: 'KPM Owner' },
  /*
   * ***Perlu perhatian Anda***, one row per KPM (SA R5, SA UI-014; P19.4-T3 AC-8): *"KPM {code} belum punya Owner"* and
   * *"KPM {code} belum punya anggota"*, each gone once it is true. They replace the one row that counted offices with
   * no Owner, which named none of them.
   */
  noOwnerTitle: ({ code }: { code: string }) => ({
    en: `KPM ${code} has no Owner`,
    id: `KPM ${code} belum punya Owner`,
  }),
  noOwnerDetail: {
    en: 'Nobody can run a KPM until it has an Owner, and only the platform can set one.',
    id: 'Tidak ada yang bisa menjalankan KPM sampai ada Owner, dan hanya platform yang bisa menetapkannya.',
  },
  pendingOwnerDetail: ({ name }: { name: string }) => ({
    en: `${name} is named as Owner but has no email yet, so cannot be invited. Give one with "Ganti pemilik".`,
    id: `${name} tercatat sebagai pemilik tetapi belum punya email, jadi belum bisa diundang. Isi lewat "Ganti pemilik".`,
  }),
  noMembersTag: { en: 'Members', id: 'Anggota' },
  noMembersTitle: ({ code }: { code: string }) => ({
    en: `KPM ${code} has no members yet`,
    id: `KPM ${code} belum punya anggota`,
  }),
  noMembersDetail: {
    en: 'Nobody but the Owner is in it. The Owner or an Admin imports the members on People.',
    id: 'Belum ada siapa pun selain Owner. Owner atau Admin KPM mengimpor anggota di menu People.',
  },
  openOfficeAction: { en: 'Open KPM', id: 'Buka KPM' },
  requestTag: { en: 'KPM request', id: 'Permintaan KPM' },
  requestTitle: ({ count }: { count: number }) => ({
    en: count === 1 ? '1 office is waiting for a decision' : `${count} offices are waiting for a decision`,
    id: `${idCount(count)} KPM menunggu keputusan`,
  }),
  requestDetail: {
    en: 'Somebody has asked for an office and nobody has approved or declined it yet. Until one of those happens they '
      + 'have no way in.',
    id: 'Seseorang telah mengajukan permintaan KPM, dan belum ada yang menyetujui atau menolaknya. Sampai salah satunya '
      + 'terjadi, orang itu tidak dapat masuk.',
  },
  decideAction: { en: 'Decide', id: 'Putuskan' },
  /*
   * A row whose person or company has gone, on the console's lists (P18.10-T7): *Unknown* says the record is missing,
   * which is a different problem from none. Written for the Super Admin reading the list, in the words the org
   * module's *Unknown* uses (`org.messages.ts`, *Tidak diketahui*).
   */
  unknownPerson: { en: 'Unknown', id: 'Tidak diketahui' },
  unknownCompany: { en: 'Unknown company', id: 'Perusahaan tidak diketahui' },
  unknownOffice: { en: 'Unknown office', id: 'KPM tidak diketahui' },
});
