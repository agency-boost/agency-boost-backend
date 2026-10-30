import { messages, refusals } from '@/common/i18n/sentence';
import type { Language } from '@/domain/constants';

/**
 * **A month's name in full, in each language** — *October*, *Oktober* — as *"Prepare {month} performance data"* writes
 * it: a word in a sentence the forum stores, not a figure (`common/format` writes a month's short name, *Okt*).
 */
export const MONTH_NAMES: Readonly<Record<Language, readonly string[]>> = {
  en: [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ],
  id: [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
  ],
};

/**
 * **The forum's refusals, in both languages** (P18.98-T5 AC-2, AC-3): making, moving and removing a meeting, and
 * writing its minutes field by field. A meeting is a ***rapat***, an action item a ***tindakan*** and the tracker the
 * ***Pelacak tindakan***, as the forum's screens say them (the glossary for approval's §B.10, P18.98-T4); *Monthly
 * Target* stays (§A.4), and the reader is *Anda* (§B.0). A field is named as the API names it — `title`, `done`,
 * `rate` — in both.
 */
export const LEADER_MEETINGS_REFUSALS = refusals('modules/leader-meetings', {
  VALIDATION_FAILED: {
    /* ---- the DTOs' own sentences (`field`) ---- */
    dateShape: {
      en: 'date must be a real day, YYYY-MM-DD',
      id: 'date harus berupa tanggal yang benar, dengan format YYYY-MM-DD',
    },
    titleNotEmpty: {
      en: 'title must not be empty',
      id: 'title tidak boleh kosong',
    },
    rateNumber: {
      en: 'rate must be a number, or null to clear it',
      id: 'rate harus berupa angka, atau null untuk mengosongkannya',
    },
    /* ---- the services' ---- */
    titleOrDate: {
      en: 'Send a title, a date, or both.',
      id: 'Kirim judul, tanggal, atau keduanya.',
    },
    exactlyOne: ({ fields }: { fields: readonly string[] }) => ({
      en: `Send exactly one of ${fields.join(', ')}, with the version you read.`,
      id: `Kirim tepat satu dari ${fields.join(', ')}, beserta versi yang Anda baca.`,
    }),
    targetRow: ({ rows }: { rows: readonly string[] }) => ({
      en: `row must be one of ${rows.join(', ')}: the others take no Monthly Target.`,
      id: `row harus salah satu dari ${rows.join(', ')}: baris lain tidak memiliki Monthly Target.`,
    }),
    apeWholeSen: {
      en: 'rate must be whole IDR minor units for ape.',
      id: 'rate untuk ape harus berupa sen IDR yang bulat.',
    },
  },
  VERSION_CONFLICT: {
    madeAtSameMoment: {
      en: 'Another meeting was made at the same moment. Try again.',
      id: 'Rapat lain dibuat pada saat yang sama. Coba lagi.',
    },
    trackerRowsChanged: {
      en: 'The tracker’s rows changed since you loaded them. Reload and try again.',
      id: 'Baris di Pelacak tindakan berubah sejak Anda membukanya. Muat ulang, lalu coba lagi.',
    },
    itemGone: {
      en: 'This item is no longer in the meeting. Reload to see what is there now.',
      id: 'Item ini sudah tidak ada di rapat. Muat ulang untuk melihat isinya sekarang.',
    },
  },
  LEADER_MEETING_COMPLETED: {
    dateStays: {
      en: 'This meeting has already taken place, so its date stays.',
      id: 'Rapat ini sudah berlangsung, jadi tanggalnya tetap.',
    },
  },
  LEADER_MEETING_HAS_MINUTES: {
    writtenIn: {
      en: 'Something has been written in this meeting, so it can’t be deleted.',
      id: 'Sudah ada yang ditulis di rapat ini, jadi rapat ini tidak dapat dihapus.',
    },
  },
});

/**
 * **The texts the forum stores for a new meeting, in both languages** (P18.98-T5 AC-6; ADR-0179 §7): the first
 * agenda (ADR-0130 §3, the prototype's ten, `KPM_Owner.html:2500-2513`) and the rows *+ Add item* and *+ Add action
 * item* make (`:2863`, `:2869`). **Each is written once, in the language of whoever makes it, and stored as text**:
 * from then it is the office's, shown as stored in both languages and edited as typed (ADR-0179 §5). *RBDO/BDO* are
 * the insurer's titles, kept (the glossary's §C9); *Follow-up* stays (§A.6); *TBD* is kept, as the screens keep it.
 */
export const LEADER_MEETINGS_MESSAGES = messages('modules/leader-meetings', {
  /* ---- *Preparation* ---- */
  compileFollowUps: {
    en: 'Compile follow-ups & commitments from prior session',
    id: 'Kumpulkan follow-up & komitmen dari sesi sebelumnya',
  },
  /** The meeting's own month (ADR-0176 §11), its name in full in the text's language. */
  preparePerformanceData: ({ month }: { month: number }) => ({
    en: `Prepare ${MONTH_NAMES.en[month - 1]} performance data`,
    id: `Siapkan data kinerja ${MONTH_NAMES.id[month - 1]}`,
  }),
  reviewScorecard: {
    en: 'Review scorecard, draft talking points',
    id: 'Tinjau scorecard, susun poin pembahasan',
  },
  /* ---- *During* ---- */
  processUpdate: {
    en: 'Process update — review prior follow-ups',
    id: 'Pembaruan proses — tinjau follow-up sebelumnya',
  },
  performanceReview: {
    en: 'Performance review vs. key thresholds',
    id: 'Tinjauan kinerja terhadap ambang batas utama',
  },
  prioritiesCorporate: {
    en: 'Strategic priorities (Corporate)',
    id: 'Prioritas strategis (Korporat)',
  },
  prioritiesAgency: {
    en: 'Strategic priorities (Agency)',
    id: 'Prioritas strategis (Agency)',
  },
  summarizeNextSteps: {
    en: 'Summarize next steps & assign owners',
    id: 'Rangkum langkah berikutnya & tetapkan penanggung jawab',
  },
  /* ---- *Post* ---- */
  documentOutcomes: {
    en: 'Document outcomes into template',
    id: 'Catat hasil ke dalam templat',
  },
  /** The glossary's §C9, approved: the titles kept, the sentence around them translated. */
  noteFeedback: {
    en: 'Note feedback for RBDO/BDO',
    id: 'Catat masukan untuk RBDO/BDO',
  },
  /* ---- the rows a button adds ---- */
  newAgendaItem: {
    en: 'New agenda item',
    id: 'Item agenda baru',
  },
  newInitiative: {
    en: 'New initiative',
    id: 'Inisiatif baru',
  },
  successMetric: {
    en: 'Success metric',
    id: 'Ukuran keberhasilan',
  },
  newActionItem: {
    en: 'New action item',
    id: 'Tindakan baru',
  },
  tbd: {
    en: 'TBD',
    id: 'TBD',
  },
});
