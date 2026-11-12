import { formatNumber } from '@/common/format/format';
import { refusals } from '@/common/i18n/sentence';
import { PHONE_COUNTRY_PREFIX, PHONE_NATIONAL_DIGITS } from '@/domain/constants';

/** A count in an Indonesian sentence: *1.250*. English keeps the number as the API always wrote it. */
const idCount = (n: number) => formatNumber(n, undefined, 'id');

/**
 * **The leads module's refusals, in both languages** (P18.10-T5 AC-2, AC-3): a lead's own fields, a write to
 * somebody else's lead, a move along a pipeline, a close, a stage the office retired, and the reorder. *Lead*,
 * *Pipeline* and *Recruitment* stay English (glossary §A.6), and a kept-English noun keeps its English plural —
 * *1 lead*, *3 leads* (§B.0 rule 8); a stage is a *tahap*, a lead won *berhasil* and one lost *tidak berhasil*, as the
 * leads screen marks them. A field is named as the API names it (`nextActionDate`, `contact.email`).
 */
export const LEAD_REFUSALS = refusals('modules/leads', {
  VALIDATION_FAILED: {
    /* A lead's own fields (`lead-input.ts`), beside the shared ones `Fields` writes. */
    nextActionDateShape: {
      en: 'nextActionDate must be a day, written YYYY-MM-DD.',
      id: 'nextActionDate harus berupa tanggal, dengan format YYYY-MM-DD.',
    },
    thisMonthShape: {
      en: 'thisMonth must be true or false.',
      id: 'thisMonth harus true atau false.',
    },
    versionShape: {
      en: 'version must be the whole number the record was read at.',
      id: 'version harus berupa bilangan bulat, yaitu versi data saat dibaca.',
    },
    contactShape: {
      en: 'contact must be an object of phone and email.',
      id: 'contact harus berupa objek berisi phone dan email.',
    },
    contactUnknownField: ({ key }: { key: string }) => ({
      en: `property contact.${key} should not exist`,
      id: `properti contact.${key} tidak dikenal`,
    }),
    contactNotText: ({ key }: { key: string }) => ({
      en: `contact.${key} must be text.`,
      id: `contact.${key} harus berupa teks.`,
    }),
    contactTooLong: ({ key, max }: { key: string; max: number }) => ({
      en: `contact.${key} must be at most ${max} characters.`,
      id: `contact.${key} paling banyak ${max} karakter.`,
    }),
    contactEmail: {
      en: 'contact.email must be an email address.',
      id: 'contact.email harus berupa alamat email.',
    },
    /* P19.11-T3 AC-6 (UX-10): a changed number that `normalisePhone` cannot read, in the words a person's number gets. */
    contactPhone: {
      en: `contact.phone must be an Indonesian number: ${PHONE_NATIONAL_DIGITS.min} to ${PHONE_NATIONAL_DIGITS.max} digits after ${PHONE_COUNTRY_PREFIX}.`,
      id: `contact.phone harus nomor Indonesia: ${PHONE_NATIONAL_DIGITS.min} sampai ${PHONE_NATIONAL_DIGITS.max} digit setelah ${PHONE_COUNTRY_PREFIX}.`,
    },
    /* The client's age and gender (P19.7-T1 AC-1; ADR-0224 §3): the shape here, the bounds `LEAD_AGE_OUT_OF_RANGE`'s. */
    ageShape: {
      en: 'age must be a whole number of years, or null to clear it.',
      id: 'age harus berupa bilangan bulat (tahun), atau null untuk mengosongkannya.',
    },
    genderShape: {
      en: 'gender must be male, female or null.',
      id: 'gender harus male, female, atau null.',
    },

    /* The service's (`lead.service.ts`): a message, and the field sentence its `details.violations` carries. */
    pinVersion: {
      en: 'Send the version you read this lead at. A change to somebody else’s lead has to say which '
        + 'version it was written against.',
      id: 'Kirim versi lead ini saat Anda membacanya. Perubahan pada lead milik orang lain harus menyebut versi '
        + 'yang menjadi dasarnya.',
    },
    versionRequired: {
      en: 'version is required when the lead is not yours',
      id: 'version wajib diisi jika lead ini bukan milik Anda',
    },
    paidAndIssuedDate: {
      en: 'The day it was paid and issued is a date, written YYYY-MM-DD, and no later than today.',
      id: 'Tanggal polis dibayar dan terbit ditulis dengan format YYYY-MM-DD, dan tidak boleh setelah hari ini.',
    },
    dateNotAfterToday: {
      en: 'date must be a day no later than today',
      id: 'date harus berupa tanggal yang tidak setelah hari ini',
    },
    typeFirst: {
      en: 'Choose whether this is a sales or a recruitment lead before setting a stage.',
      id: 'Pilih apakah ini lead sales atau recruitment sebelum menetapkan tahap.',
    },
    typeRequired: {
      en: 'type is required before a stage',
      id: 'type wajib diisi sebelum tahap',
    },

    /* The reorder (`LeadService.reorder`): its message, and each thing wrong with the list sent. */
    reorderEveryLead: {
      en: 'Send every one of your open leads, once each, in the order you want them. Your list may have '
        + 'changed since you opened it: reload it and try again.',
      id: 'Kirim semua lead Anda yang masih terbuka, masing-masing sekali, dalam urutan yang Anda inginkan. Daftar '
        + 'Anda mungkin sudah berubah sejak Anda membukanya: muat ulang, lalu coba lagi.',
    },
    reorderStrangers: ({ count }: { count: number }) => ({
      en: `${count} of the ids sent ${count === 1 ? 'is' : 'are'} not one of your open leads`,
      id: `${idCount(count)} dari id yang dikirim bukan lead Anda yang masih terbuka`,
    }),
    reorderRepeat: {
      en: 'ids names a lead more than once',
      id: 'ids menyebut satu lead lebih dari sekali',
    },
    reorderMissing: ({ count }: { count: number }) => ({
      en: `${count} of your open leads ${count === 1 ? 'is' : 'are'} missing from ids`,
      id: `${idCount(count)} ${count === 1 ? 'lead' : 'leads'} Anda yang masih terbuka tidak ada di ids`,
    }),
  },
  LEAD_AGE_OUT_OF_RANGE: {
    /* ADR-0224 §3: the screen's own sentence in Indonesian, *"Umur harus 1–100."* */
    between: ({ min, max }: { min: number; max: number }) => ({
      en: `Age must be ${min}–${max}.`,
      id: `Umur harus ${min}–${max}.`,
    }),
  },
  LEAD_ALREADY_CLOSED: {
    reopenToMove: {
      en: 'This lead is closed. Reopen it before moving it again.',
      id: 'Lead ini sudah ditutup. Buka kembali sebelum memindahkannya lagi.',
    },
    reopenToClose: ({ outcome }: { outcome: 'won' | 'lost' }) => ({
      en: `This lead is already ${outcome}. Reopen it before closing it again.`,
      id: `Lead ini sudah ditandai ${outcome === 'won' ? 'berhasil' : 'tidak berhasil'}. Buka kembali sebelum `
        + 'menutupnya lagi.',
    }),
  },
  LEAD_STATUS_WRONG_PIPELINE: {
    otherLadder: ({ code, pipeline, type }: { code: string; pipeline: string; type: string }) => ({
      en: `${code} belongs to the ${pipeline} ladder; this is a ${type} lead.`,
      id: `${code} termasuk pipeline ${pipeline}; ini lead ${type}.`,
    }),
  },
  LEAD_STATUS_NOT_FINAL: {
    moveFirst: {
      en: 'A lead is won at the stage that closes its pipeline. Move it there first.',
      id: 'Lead ditandai berhasil di tahap yang menutup pipeline-nya. Pindahkan ke tahap itu dulu.',
    },
  },
  LEAD_STATUS_FINAL: {
    moveBackFirst: {
      en: 'This lead is at the stage that closes its pipeline, so it can only be marked won. If it fell through, move '
        + 'it back to an earlier stage first, then mark it not won.',
      id: 'Lead ini sudah di tahap yang menutup pipeline-nya, jadi hanya bisa ditandai berhasil. Jika batal, pindahkan '
        + 'dulu ke tahap sebelumnya, lalu tandai tidak berhasil.',
    },
  },
  CONFIG_ARCHIVED: {
    retiredStage: ({ code }: { code: string }) => ({
      en: `${code} has been retired. Leads already on it keep it; new ones cannot be moved to it.`,
      id: `${code} sudah diarsipkan. Leads yang sudah berada di tahap ini tetap di sana; lead lain tidak dapat `
        + 'dipindahkan ke tahap ini.',
    }),
  },
});
