import { refusals } from '@/common/i18n/sentence';
import type { AnswerProblem } from './survey-rules';

/**
 * **The surveys, refused in both languages** (P19.5-T4; ADR-0216 §2, §3, §5). The Indonesian is the reminder mockup's
 * and the coaching mockup's register; the codes are the error catalog's. A sentence never names a person, and never
 * says whether a run of another KPM exists.
 */
export const SURVEY_REFUSALS = refusals('modules/surveys', {
  SURVEY_NOT_INVITED: {
    notInvited: {
      en: 'This survey is not one you were invited to.',
      id: 'Survei ini bukan survei yang Anda diundang mengisinya.',
    },
  },
  SURVEY_CLOSED: {
    closed: {
      en: 'This survey has closed. Your saved answers are kept, and no more can be given.',
      id: 'Survei ini sudah ditutup. Jawaban yang tersimpan tetap ada, dan tidak bisa ditambah lagi.',
    },
    submitted: {
      en: 'You have already sent this survey. Thank you.',
      id: 'Anda sudah mengirim survei ini. Terima kasih.',
    },
    opened: {
      en: 'This survey has already opened, so its settings can no longer change and it cannot be cancelled.',
      id: 'Survei ini sudah dibuka, jadi pengaturannya tidak bisa diubah lagi dan survei tidak bisa dibatalkan.',
    },
  },
  SURVEY_RUN_CONFLICT: {
    periodTaken: {
      en: 'A survey of this kind already runs in this period. Change that one, or pick dates in another period.',
      id: 'Sudah ada survei jenis ini di periode ini. Ubah survei itu, atau pilih tanggal di periode lain.',
    },
    outsideCadenceNpsQuarter: {
      en: 'An NPS survey opens and closes within one quarter.',
      id: 'Survei NPS dibuka dan ditutup di dalam satu kuartal.',
    },
    outsideCadenceNpsHalf: {
      en: 'An NPS survey opens and closes within one half-year.',
      id: 'Survei NPS dibuka dan ditutup di dalam satu semester.',
    },
    outsideCadenceQual: {
      en: 'A qualitative survey opens and closes in June or in December.',
      id: 'Survei kualitatif dibuka dan ditutup di bulan Juni atau Desember.',
    },
    sectionOff: {
      en: 'This survey is turned off in the KPM template, so no new run can start.',
      id: 'Survei ini dimatikan di template KPM, jadi periode baru tidak bisa dimulai.',
    },
  },
  // ADR-0216 §3 (amended 2026-11-06): a reader outside the person's line is `404`, so a session is the one raiser.
  SURVEY_ANSWERS_HIDDEN: {
    session: {
      en: 'A person’s survey answers are not shown in a view-as session.',
      id: 'Jawaban survei seseorang tidak ditampilkan dalam sesi lihat sebagai.',
    },
  },
  VALIDATION_FAILED: {
    dateShape: {
      en: 'A date is a calendar day, YYYY-MM-DD.',
      id: 'Tanggal berupa hari kalender, YYYY-MM-DD.',
    },
    opensInPast: {
      en: 'A survey cannot open before today.',
      id: 'Survei tidak bisa dibuka sebelum hari ini.',
    },
    closesBeforeOpen: {
      en: 'The end date is on or after the start date.',
      id: 'Tanggal berakhir sama dengan atau setelah tanggal mulai.',
    },
    noRoles: {
      en: 'Invite at least one role: Agent, AAB or AB.',
      id: 'Undang paling sedikit satu peran: Agent, AAB atau AB.',
    },
    unknownQuestion: ({ kode }: { kode: string }) => ({
      en: `${kode} is not a question of this survey.`,
      id: `${kode} bukan pertanyaan survei ini.`,
    }),
    answer: ({ kode, problem }: { kode: string; problem: AnswerProblem }) => ({
      en: `${kode}: ${PROBLEM_EN[problem] ?? PROBLEM_EN.shape}`,
      id: `${kode}: ${PROBLEM_ID[problem] ?? PROBLEM_ID.shape}`,
    }),
    missing: ({ kode }: { kode: string }) => ({
      en: `Answer ${kode} before sending.`,
      id: `Jawab ${kode} sebelum mengirim.`,
    }),
  },
});

const PROBLEM_EN: Record<AnswerProblem, string> = {
  score: 'choose a score from 0 to 10.',
  text: 'the text is too long, or not asked here.',
  choices: 'choose at least one of the options, each once.',
  exclusive: 'this option is chosen on its own.',
  rating: 'each item takes 1 to 5.',
  state: 'each item takes Konsisten, Tidak konsisten or Tidak dilakukan.',
  yes_no: 'answer Ya or Tidak.',
  leader: 'name only your own downline leaders, each once.',
  area: 'choose areas from the list, each once.',
  shape: 'this answer does not fit the question.',
};

const PROBLEM_ID: Record<AnswerProblem, string> = {
  score: 'pilih nilai 0 sampai 10.',
  text: 'teksnya terlalu panjang, atau tidak ditanyakan di sini.',
  choices: 'pilih paling sedikit satu pilihan, masing-masing sekali.',
  exclusive: 'pilihan ini hanya bisa dipilih sendiri.',
  rating: 'setiap butir bernilai 1 sampai 5.',
  state: 'setiap butir: Konsisten, Tidak konsisten atau Tidak dilakukan.',
  yes_no: 'jawab Ya atau Tidak.',
  leader: 'sebutkan hanya leader downline Anda sendiri, masing-masing sekali.',
  area: 'pilih area dari daftar, masing-masing sekali.',
  shape: 'jawaban ini tidak sesuai pertanyaannya.',
};
