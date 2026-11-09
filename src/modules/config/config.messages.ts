import { readerIn } from '@/common/i18n/reader';
import { refusals, render, type Sentence } from '@/common/i18n/sentence';

/** A ratio's side, in Indonesian: *pembilang* and *penyebut*, the words a fraction's two halves have. */
const SIDE_ID = { numerator: 'pembilang', denominator: 'penyebut' } as const;

/** A list of labels an office typed, each in curly quotes as the English writes them, as typed in both languages. */
const quoted = (labels: readonly string[]) => labels.map((l) => `“${l}”`);

/**
 * **The office's configuration, refused in both languages** (P18.10-T5 AC-2, AC-3): the activity taxonomy and its
 * summary tiles, the ratios, the two lead pipelines, the activity binding, and the staged batch that writes them all.
 * The Super Admin's templates and provisioning have their own (`template.messages.ts`).
 *
 * An office is a *KPM* (§B.9), a section a *bagian*, a summary tile a *kotak ringkasan*, a rung a *jenjang* and the
 * ladder the *susunan jenjang*; a stage of a pipeline is a *tahap*, the one that closes it the *tahap penutup*. *Ratio*,
 * *benchmark*, *Pipeline*, *Goal*, *Closing* and the cascade's three activities stay English (§A.6). A field, a code
 * and an op are named as the API names them (`summaryGroupCode`, `type.create`); a label an office typed stays as typed.
 */
export const CONFIG_REFUSALS = refusals('modules/config', {
  ACTIVITY_TYPE_BOUND: {
    typeBound: ({ label, role }: { label: string; role: string }) => ({
      en: `“${label}” cannot be archived: the summary and the goal plan count it as ${role}. A Super Admin `
        + 'can bind another activity in its place first. You can rename it, describe it, reorder it or move it to '
        + 'another section.',
      id: `“${label}” tidak dapat diarsipkan: ringkasan dan rencana goal menghitungnya sebagai ${role}. Super `
        + 'Admin dapat mengaitkan aktivitas lain sebagai penggantinya terlebih dahulu. Anda dapat mengganti nama, '
        + 'deskripsi, atau urutannya, atau memindahkannya ke bagian lain.',
    }),
    sectionBound: ({ section, labels }: { section: string; labels: readonly string[] }) => ({
      en: `${section} cannot be archived while it holds ${quoted(labels).join(', ')}, `
        + 'which the summary and the goal plan count. Move them to another section first.',
      id: `${section} tidak dapat diarsipkan selama masih berisi ${quoted(labels).join(', ')}, yang dihitung oleh `
        + 'ringkasan dan rencana goal. Pindahkan semuanya ke bagian lain terlebih dahulu.',
    }),
  },
  CONFIG_RATIO_UNREACHABLE_INPUT: {
    narrowFirst: ({ ratios }: { ratios: readonly string[] }) => ({
      en: `${ratios.join(', ')} counts activity in this section, and applies to rungs the `
        + 'section would no longer be shown to. Those agents would be measured on '
        + 'something they cannot log. Narrow the ratio first, or widen the section.',
      id: `${ratios.join(', ')} menghitung aktivitas di bagian ini, dan berlaku untuk jenjang yang tidak akan lagi `
        + 'melihat bagian ini. Agent di jenjang itu akan dinilai atas sesuatu yang tidak dapat mereka catat. Persempit '
        + 'ratio-nya terlebih dahulu, atau perluas bagian ini.',
    }),
  },
  CONFIG_SUMMARY_GROUP_LABEL_MISMATCH: {
    twoLabels: ({ code, labels }: { code: string; labels: readonly string[] }) => ({
      en: `The sections in the summary tile ${code} would be labelled `
        + `${labels.map((l) => `“${l}”`).join(' and ')}. One tile has one label: give `
        + 'every section in it the same one.',
      id: `Bagian di kotak ringkasan ${code} akan berlabel ${labels.map((l) => `“${l}”`).join(' dan ')}. Satu kotak `
        + 'memiliki satu label: beri setiap bagian di dalamnya label yang sama.',
    }),
  },
  CONFIG_SUMMARY_GROUP_CODE_TAKEN: {
    codeOfATile: ({ code, label }: { code: string; label: string }) => ({
      en: `${code} is the code of the summary tile “${label}”, so a section `
        + 'outside that tile cannot carry it as well. Give the section another code.',
      id: `${code} adalah kode kotak ringkasan “${label}”, jadi bagian di luar kotak itu tidak dapat memakainya juga. `
        + 'Beri bagian itu kode lain.',
    }),
  },
  CONFIG_RUNG_UNKNOWN: {
    notActiveRungs: ({ codes }: { codes: readonly string[] }) => ({
      en: `${codes.join(', ')} is not an active rung on your company’s ladder.`,
      id: `${codes.join(', ')} bukan jenjang aktif di susunan jenjang perusahaan Anda.`,
    }),
  },
  VERSION_CONFLICT: {
    rowChanged: ({ code, version, read }: { code: string; version: number; read: number }) => ({
      en: `${code} changed while you were editing — it is now version `
        + `${version} and you read version ${read}. Reload to see `
        + 'what somebody else did, then make your change again.',
      id: `${code} berubah saat Anda sedang mengedit — sekarang versi ${version}, sedangkan Anda membaca versi ${read}. `
        + 'Muat ulang untuk melihat perubahan orang lain, lalu lakukan perubahan Anda lagi.',
    }),
    bindingChanged: ({ version, read }: { version: number; read: number }) => ({
      en: `The activity binding changed while you were editing — it is now version ${version} and you read `
        + `version ${read}. Reload to see what changed, then make your change again.`,
      id: `Pengaitan aktivitas berubah saat Anda sedang mengedit — sekarang versi ${version}, sedangkan Anda membaca `
        + `versi ${read}. Muat ulang untuk melihat perubahannya, lalu lakukan perubahan Anda lagi.`,
    }),
  },
  VALIDATION_FAILED: {
    nothingToChange: {
      en: 'Nothing to change.',
      id: 'Tidak ada yang diubah.',
    },

    /* What a write may contain (`config-input.ts`): read by a route and by the staged batch alike. */
    summaryGroupPair: {
      en: 'summaryGroupCode and summaryGroupLabel are set together, or cleared together with null.',
      id: 'summaryGroupCode dan summaryGroupLabel diisi bersamaan, atau dikosongkan bersamaan dengan null.',
    },
    ratioSideEmpty: ({ side }: { side: 'numerator' | 'denominator' }) => ({
      en: `A ratio needs at least one activity type in its ${side}.`,
      id: `Ratio memerlukan paling sedikit satu jenis aktivitas di ${SIDE_ID[side]}nya.`,
    }),
    ratioSideTooMany: ({ side, max }: { side: 'numerator' | 'denominator'; max: number }) => ({
      en: `A ratio counts at most ${max} activity types in its ${side}.`,
      id: `Ratio menghitung paling banyak ${max} jenis aktivitas di ${SIDE_ID[side]}nya.`,
    }),

    /* The activity taxonomy (`ActivityConfigService`). */
    sendEverySection: {
      en: 'Send every section, once each, in the order you want them.',
      id: 'Kirim setiap bagian, masing-masing sekali, dalam urutan yang Anda inginkan.',
    },
    sendEveryType: {
      en: 'Send every activity type, once each, in the order you want them.',
      id: 'Kirim setiap jenis aktivitas, masing-masing sekali, dalam urutan yang Anda inginkan.',
    },
    categoryTaken: ({ code }: { code: string }) => ({
      en: `This office already has a category called ${code}.`,
      id: `KPM ini sudah memiliki kategori bernama ${code}.`,
    }),
    typeTaken: ({ code }: { code: string }) => ({
      en: `This office already has an activity type called ${code}.`,
      id: `KPM ini sudah memiliki jenis aktivitas bernama ${code}.`,
    }),
    noActiveCategory: ({ code }: { code: string }) => ({
      en: `No active category called ${code} in this office.`,
      id: `Tidak ada kategori aktif bernama ${code} di KPM ini.`,
    }),

    /* The two lead pipelines (`LeadStatusService`). */
    leadStatusTaken: ({ code }: { code: string }) => ({
      en: `This office already has a lead status called ${code}.`,
      id: `KPM ini sudah memiliki status lead bernama ${code}.`,
    }),
    archivedCannotClose: {
      en: 'An archived status cannot be the one that closes a pipeline.',
      id: 'Status yang diarsipkan tidak dapat menjadi status yang menutup pipeline.',
    },
    terminalIsClosed: {
      en: 'This is the stage that closes the pipeline, so a lead sitting on it has already '
        + 'closed. Flag a stage before it instead.',
      id: 'Ini adalah tahap yang menutup pipeline, jadi lead yang berada di tahap ini sudah closing. Tandai tahap '
        + 'sebelumnya saja.',
    },
    archivedHoldsNoLeads: {
      en: 'An archived stage holds no leads, so it counts nothing.',
      id: 'Tahap yang diarsipkan tidak berisi lead, jadi tidak menghitung apa pun.',
    },
    sendEveryStatus: ({ pipeline }: { pipeline: string }) => ({
      en: `Send every ${pipeline} status, once each, in the order you want them.`,
      id: `Kirim setiap status ${pipeline}, masing-masing sekali, dalam urutan yang Anda inginkan.`,
    }),
    terminalCannotArchive: {
      en: 'This is the stage that closes the pipeline. Make another one terminal first.',
      id: 'Ini adalah tahap yang menutup pipeline. Jadikan tahap lain sebagai tahap penutup terlebih dahulu.',
    },

    /* The ratios (`RatioService`). */
    ratioTaken: ({ code }: { code: string }) => ({
      en: `This office already has a ratio called ${code}.`,
      id: `KPM ini sudah memiliki ratio bernama ${code}.`,
    }),
    codeTwiceInSide: ({ code, side }: { code: string; side: 'numerator' | 'denominator' }) => ({
      en: `${code} appears twice in the ${side}. Each activity type counts once.`,
      id: `${code} muncul dua kali di ${SIDE_ID[side]}. Setiap jenis aktivitas dihitung sekali.`,
    }),
    unknownTypesInSide: ({ side, codes }: { side: 'numerator' | 'denominator'; codes: readonly string[] }) => ({
      en: `The ${side} names ${codes.join(', ')}, which this office has no active activity `
        + 'type for. Check the code, or add the type first.',
      id: `${SIDE_ID[side] === 'pembilang' ? 'Pembilang' : 'Penyebut'} menyebut ${codes.join(', ')}, yang tidak memiliki `
        + 'jenis aktivitas aktif di KPM ini. Periksa kodenya, atau tambahkan jenis aktivitasnya terlebih dahulu.',
    }),

    /* The staged batch (`ConfigChangeService`): each op checked before any is written. */
    unknownChange: ({ op }: { op: string }) => ({
      en: `Unknown change ${op}.`,
      id: `Perubahan ${op} tidak dikenal.`,
    }),
    codeInUse: ({ code }: { code: string }) => ({
      en: `${code} is already in use in this office. A code is never reused.`,
      id: `${code} sudah dipakai di KPM ini. Kode tidak pernah dipakai ulang.`,
    }),
    noActiveSection: ({ code }: { code: string }) => ({
      en: `No active section called ${code}. Add the section first, or check the code.`,
      id: `Tidak ada bagian aktif bernama ${code}. Tambahkan bagian itu terlebih dahulu, atau periksa kodenya.`,
    }),
    sayTheVersion: {
      en: 'Every change to an existing row must say which version it was read at.',
      id: 'Setiap perubahan pada baris yang sudah ada harus menyebutkan versi saat baris itu dibaca.',
    },
    noTrainingCategory: ({ code }: { code: string }) => ({
      en: `No active training category called ${code}. Add it first, or check the code.`,
      id: `Tidak ada kategori training aktif bernama ${code}. Tambahkan terlebih dahulu, atau periksa kodenya.`,
    }),
    noTrainingSkill: ({ code }: { code: string }) => ({
      en: `No active training skill called ${code}. Add it first, or check the code.`,
      id: `Tidak ada skill training aktif bernama ${code}. Tambahkan terlebih dahulu, atau periksa kodenya.`,
    }),
    noCategoryToMoveInto: ({ category, row }: { category: string; row: string }) => ({
      en: `No active training category called ${category} to move ${row} into.`,
      id: `Tidak ada kategori training aktif bernama ${category} sebagai tujuan pemindahan ${row}.`,
    }),
    noSkillToMoveUnder: ({ skill, row }: { skill: string; row: string }) => ({
      en: `No active training skill called ${skill} to move ${row} under.`,
      id: `Tidak ada skill training aktif bernama ${skill} sebagai tujuan pemindahan ${row}.`,
    }),
    categoryArchived: ({ row, parent }: { row: string; parent: string }) => ({
      en: `${row} is in ${parent}, which is archived. Restore the category first.`,
      id: `${row} berada di ${parent}, yang sudah diarsipkan. Pulihkan kategorinya terlebih dahulu.`,
    }),
    skillArchived: ({ row, parent }: { row: string; parent: string }) => ({
      en: `${row} teaches ${parent}, which is archived. Restore the skill first.`,
      id: `${row} mengajarkan ${parent}, yang sudah diarsipkan. Pulihkan skill-nya terlebih dahulu.`,
    }),
    /**
     * **A refusal, said for the op it came from** — *Change 3 (type.create): …* — the inner refusal's own words in
     * each language. Raised under the inner refusal's code (`refiled`), its details carried as given.
     */
    atChange: ({ n, op, inner }: { n: number; op: string; inner: Sentence }) => ({
      en: (figures) => `Change ${n} (${op}): ${render(inner, { language: 'en', figures })}`,
      id: `Perubahan ${n} (${op}): ${render(inner, readerIn('id'))}`,
    }),
    /** An op that failed with no refusal of ours — an error's own English, which no catalogue holds. */
    atChangeUnexpected: ({ n, op, detail }: { n: number; op: string; detail: string }) => ({
      en: `Change ${n} (${op}): ${detail}`,
      id: `Perubahan ${n} (${op}): ${detail}`,
    }),

    /* The activity binding (`bindingProblems`): the office's write, a template's publish, provisioning. */
    bindingNotAnObject: {
      en: 'The activity binding must name the codes for Set appointment, Sales meeting and Submission polis.',
      id: 'Pengaitan aktivitas harus menyebutkan kode untuk Set appointment, Sales meeting, dan Submission polis.',
    },
    bindingNotAList: ({ label }: { label: string }) => ({
      en: `${label} must be a list of activity type codes.`,
      id: `${label} harus berupa daftar kode jenis aktivitas.`,
    }),
    bindingCountsNone: ({ label }: { label: string }) => ({
      en: `${label} counts no activity type. Bind at least one, or the summary counts nothing for it.`,
      id: `${label} tidak menghitung jenis aktivitas apa pun. Kaitkan paling sedikit satu, atau ringkasan tidak akan `
        + 'menghitung apa pun untuknya.',
    }),
    bindingTooMany: ({ label, count, max }: { label: string; count: number; max: number }) => ({
      en: `${label} names ${count} activity types; at most ${max}.`,
      id: `${label} menyebut ${count} jenis aktivitas; paling banyak ${max}.`,
    }),
    bindingTwice: ({ label, code }: { label: string; code: string }) => ({
      en: `${label} names ${code} twice.`,
      id: `${label} menyebut ${code} dua kali.`,
    }),
    bindingInTwoRoles: ({ code, other, label }: { code: string; other: string; label: string }) => ({
      en: `${code} is bound to both ${other} and ${label}. One activity counts in one place.`,
      id: `${code} dikaitkan ke ${other} sekaligus ${label}. Satu aktivitas dihitung di satu tempat saja.`,
    }),
    bindingUnknownCodes: ({ label, codes }: { label: string; codes: readonly string[] }) => ({
      en: `${label} names ${codes.join(', ')}, which ${codes.length === 1 ? 'is' : 'are'} not `
        + `${codes.length === 1 ? 'an activity type' : 'activity types'} here.`,
      id: `${label} menyebut ${codes.join(', ')}, yang bukan jenis aktivitas di sini.`,
    }),
  },
});
