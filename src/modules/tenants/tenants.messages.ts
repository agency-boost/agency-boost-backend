import { formatNumber, formatRupiah } from '@/common/format/format';
import { messages, refusals } from '@/common/i18n/sentence';

/** A count in an Indonesian sentence: grouped the Indonesian way once it reaches a thousand (*1.250*). */
const idCount = (n: number) => formatNumber(n, undefined, 'id');

/** What a rung applies to, in each language: a ratio keeps its name (§A.6), a section is a *bagian*. */
const SUBJECT_ID = { ratio: 'Ratio', section: 'Bagian' } as const;

/**
 * **The tenants module's refusals, in both languages** (P18.98-T5 AC-2, AC-3): companies and offices, the company's
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
      id: `${name} adalah Template library: isinya templat yang disalin perusahaan dan KPM baru, dan tidak ada KPM `
        + 'di dalamnya. Pilih perusahaan asuransi tempat KPM ini bernaung.',
    }),
  },
  TENANT_CODE_TAKEN: {
    taken: ({ code, company }: { code: string; company: string }) => ({
      en: `KPM code ${code} is already used by ${company}.`,
      id: `Kode KPM ${code} sudah dipakai oleh ${company}.`,
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
  INTERNAL_ERROR: {
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
    ownerDeactivated: {
      en: 'That account is deactivated and cannot own an office.',
      id: 'Akun itu dinonaktifkan dan tidak dapat menjadi Owner KPM.',
    },
    startFromDefaults: {
      en: 'Start from a template — the Template’s Default template holds the AgencyBoost defaults — or Empty.',
      id: 'Mulai dari templat — Default template milik Template berisi pengaturan default AgencyBoost — atau Kosong.',
    },
    unknownTemplateKind: ({ kind, kinds }: { kind: string; kinds: readonly string[] }) => ({
      en: `Unknown template kind "${kind}". One of: ${kinds.join(', ')}.`,
      id: `Jenis templat "${kind}" tidak dikenal. Pilih salah satu: ${kinds.join(', ')}.`,
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

    /* The roster import's refusal, and each row's issue — the preview's list, the commit's details. */
    rowsWouldNotImport: ({ count }: { count: number }) => ({
      en: `${count} row${count === 1 ? '' : 's'} would not import. Nothing was created — `
        + 'fix the file and upload it again.',
      id: `${idCount(count)} baris tidak dapat diimpor. Tidak ada yang dibuat — perbaiki file, lalu unggah lagi.`,
    }),
    headerOnly: {
      en: 'That file has a header and no people in it.',
      id: 'File itu hanya berisi header, tanpa orang di dalamnya.',
    },
    fileEmpty: {
      en: 'The file is empty.',
      id: 'File ini kosong.',
    },
    headerExactly: ({ header }: { header: string }) => ({
      en: `The header must read exactly: ${header}. Download the template.`,
      id: `Header harus persis: ${header}. Unduh templat.`,
    }),
    columnCount: ({ expected, found }: { expected: number; found: number }) => ({
      en: `Expected ${expected} columns, found ${found}.`,
      id: `Seharusnya ${expected} kolom, ditemukan ${found}.`,
    }),
    nameRequired: {
      en: 'A name is required.',
      id: 'Nama wajib diisi.',
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
    notARung: ({ value }: { value: string }) => ({
      en: `"${value}" is not a rung. Use a rung of your company’s ladder by its code — AB, AAB or Agent, `
        + 'or one it added.',
      id: `"${value}" bukan jenjang. Gunakan kode jenjang dari susunan jenjang perusahaan Anda — AB, AAB, atau Agent, `
        + 'atau jenjang yang ditambahkannya.',
    }),
    birthDateRequired: {
      en: 'A date of birth is required.',
      id: 'Tanggal lahir wajib diisi.',
    },
    joinMonthRequired: {
      en: 'The month they joined the company is required.',
      id: 'Bulan bergabung dengan perusahaan wajib diisi.',
    },
    notAWorkStatus: ({ value }: { value: string }) => ({
      en: `"${value}" is not a work status. Use full-time or part-time.`,
      id: `"${value}" bukan status kerja. Gunakan full-time atau part-time.`,
    }),
    workStatusRequired: {
      en: 'A work status is required: full-time or part-time.',
      id: 'Status kerja wajib diisi: full-time atau part-time.',
    },
    notAGender: ({ value }: { value: string }) => ({
      en: `"${value}" is not a gender. Use male or female.`,
      id: `"${value}" bukan jenis kelamin. Gunakan male atau female.`,
    }),
    genderRequired: {
      en: 'A gender is required: male or female.',
      id: 'Jenis kelamin wajib diisi: male atau female.',
    },
    alreadyOnLine: ({ line }: { line: number }) => ({
      en: `Already on line ${line}.`,
      id: `Sudah ada di baris ${line}.`,
    }),
    notALadderRung: ({ role, rungs }: { role: string; rungs: readonly string[] }) => ({
      en: `"${role}" is not a rung of this company’s ladder. Use one of: ${rungs.join(', ')}.`,
      id: `"${role}" bukan jenjang di susunan jenjang perusahaan ini. Gunakan salah satu dari: ${rungs.join(', ')}.`,
    }),
    emailHasAccount: {
      en: 'Already has an account. Import creates people; this one exists already.',
      id: 'Sudah memiliki akun. Impor membuat orang baru; orang ini sudah ada.',
    },
    agentCodeHeld: ({ email }: { email: string }) => ({
      en: `Already registered at this insurer by ${email}.`,
      id: `Sudah didaftarkan di perusahaan asuransi ini oleh ${email}.`,
    }),
    leaderNotFound: ({ code }: { code: string }) => ({
      en: `No active member of this office has the code ${code}, and it is not in this file either.`,
      id: `Tidak ada anggota aktif KPM ini dengan kode ${code}, dan kode itu juga tidak ada di file ini.`,
    }),
    leaderLoop: {
      en: 'The leader columns form a loop, so nobody in it could be created first.',
      id: 'Kolom leader membentuk lingkaran, jadi tidak ada orang di dalamnya yang dapat dibuat lebih dulu.',
    },
    /** A row past the office's leader limit, as the Super Admin is told it: where to raise the limit. */
    pastLimitForSuperAdmin: ({ max, used }: { max: number; used: number }) => ({
      en: `This office’s leader limit is ${max} — ABs and AABs together — and `
        + `${used} ${used === 1 ? 'is' : 'are'} in use already, so this `
        + 'row would be one too many. Raise the limit with Edit subscription on the offices list '
        + 'first, or import them as an Agent.',
      id: `Batas leader KPM ini adalah ${idCount(max)} — AB dan AAB digabung — dan ${idCount(used)} sudah terpakai, `
        + 'jadi baris ini akan melebihi batas. Naikkan batasnya dengan Ubah langganan di daftar KPM terlebih dahulu, '
        + 'atau impor orang ini sebagai Agent.',
    }),
    /** The same, as the office is told it: the way through that asks AgencyBoost (ADR-0157 §5). */
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
 * **What the platform's overview composes, in both languages** (P18.98-T5 AC-4): the *Needs your attention* queue's
 * rows, written for the Super Admin reading them. *KPM Owner* stays the role's name (§A.5).
 */
export const TENANTS_MESSAGES = messages('modules/tenants', {
  unownedTag: { en: 'KPM owner', id: 'KPM Owner' },
  unownedTitle: ({ count }: { count: number }) => ({
    en: count === 1 ? '1 office has no Owner' : `${count} offices have no Owner`,
    id: `${idCount(count)} KPM belum memiliki Owner`,
  }),
  unownedDetail: {
    en: 'Nobody can administer an office until an Owner is assigned, and only the platform can assign one.',
    id: 'Tidak ada yang dapat mengelola KPM sampai Owner ditetapkan, dan hanya platform yang dapat menetapkannya.',
  },
  reviewAction: { en: 'Review', id: 'Tinjau' },
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
   * A row whose person or company has gone, on the console's lists (P18.98-T7): *Unknown* says the record is missing,
   * which is a different problem from none. Written for the Super Admin reading the list, in the words the org
   * module's *Unknown* uses (`org.messages.ts`, *Tidak diketahui*).
   */
  unknownPerson: { en: 'Unknown', id: 'Tidak diketahui' },
  unknownCompany: { en: 'Unknown company', id: 'Perusahaan tidak diketahui' },
  unknownOffice: { en: 'Unknown office', id: 'KPM tidak diketahui' },
});
