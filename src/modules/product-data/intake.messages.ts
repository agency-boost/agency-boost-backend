import { refusals } from '@/common/i18n/sentence';

/**
 * ***Unggah file*'s and the illustration's refusals, in both languages** (P19.15-T2, T3; ADR-0259). *Unggah file*,
 * *Yang kami pahami*, *Ilustrasi* and *Tabel premi* are the screen's own names and stay Indonesian in both (glossary).
 */
export const INTAKE_REFUSALS = refusals('modules/product-data/intake', {
  AI_READING_OFF: {
    notSwitchedOn: {
      en: 'Reading files is not switched on yet: the Anthropic API key is not set. Upload a premium table as Excel or CSV in Tabel premi instead.',
      id: 'Pembacaan file belum dinyalakan: kunci API Anthropic belum diisi. Unggah tabel premi sebagai Excel atau CSV di Tabel premi.',
    },
  },
  INTAKE_QUESTIONS_OPEN: {
    answerFirst: ({ count }: { count: number }) => ({
      en: `Answer ${count === 1 ? 'the open question' : `the ${count} open questions`} on this card before confirming it.`,
      id: `Jawab dulu ${count === 1 ? 'pertanyaan' : `${count} pertanyaan`} di kartu ini sebelum mengonfirmasi.`,
    }),
  },
  INTAKE_ITEM_DECIDED: {
    already: ({ status }: { status: string }) => ({
      en: status === 'applied' ? 'This card has already been applied.' : status === 'rejected' ? 'This card has already been rejected.' : 'This upload is still being read.',
      id: status === 'applied' ? 'Kartu ini sudah diterapkan.' : status === 'rejected' ? 'Kartu ini sudah ditolak.' : 'Unggahan ini masih dibaca.',
    }),
  },
  INTAKE_APPLY_REFUSED: {
    noRows: {
      en: 'No price in this table could be read exactly. Upload the table as Excel or CSV in Tabel premi.',
      id: 'Tidak ada tarif di tabel ini yang terbaca persis. Unggah tabelnya sebagai Excel atau CSV di Tabel premi.',
    },
    noTableInForce: {
      en: 'This product has no premium table in force to apply the percentage to. Upload the new table instead.',
      id: 'Produk ini belum punya tabel premi yang berlaku untuk dikalikan. Unggah tabel barunya.',
    },
    notApproved: {
      en: 'The percentage was not approved, so nothing is calculated. Reject this card and upload the new table.',
      id: 'Persentase tidak disetujui, jadi tidak ada yang dihitung. Tolak kartu ini dan unggah tabel barunya.',
    },
    nothingToApply: {
      en: 'Nothing on this card can be applied automatically. Change it in Isian, then reject this card.',
      id: 'Tidak ada isi kartu ini yang bisa diterapkan otomatis. Ubah di Isian, lalu tolak kartu ini.',
    },
    noProduct: {
      en: 'Choose the product this card is for first.',
      id: 'Pilih dulu produk untuk kartu ini.',
    },
    noFile: {
      en: 'The illustration’s file was not kept, so it cannot be read again. Upload it in Ilustrasi.',
      id: 'File ilustrasinya tidak tersimpan, jadi tidak bisa dibaca lagi. Unggah di tab Ilustrasi.',
    },
  },
  ILLUSTRATION_FORMULA_MISMATCH: {
    fixFirst: ({ count }: { count: number }) => ({
      en: `${count === 1 ? 'A formula does' : `${count} formulas do`} not match the illustration. Correct or remove ${count === 1 ? 'it' : 'them'} before publishing.`,
      id: `${count} rumus tidak cocok dengan ilustrasi. Perbaiki atau hapus dulu sebelum menerbitkan.`,
    }),
  },
  ILLUSTRATION_NOT_DRAFT: {
    notDraft: ({ status }: { status: string }) => ({
      en: status === 'reading' ? 'This illustration is still being read.' : status === 'failed' ? 'This illustration could not be read. Upload it again.' : 'This illustration has been published. Upload a new one to change it.',
      id: status === 'reading' ? 'Ilustrasi ini masih dibaca.' : status === 'failed' ? 'Ilustrasi ini gagal dibaca. Unggah lagi.' : 'Ilustrasi ini sudah terbit. Unggah yang baru untuk mengubahnya.',
    }),
  },
  ASSET_TYPE_NOT_ALLOWED: {
    notAccepted: ({ name }: { name: string }) => ({
      en: `“${name}” is not a file we can read. Upload Excel, CSV, PDF, a picture (PNG, JPEG, WebP), Word or ZIP.`,
      id: `“${name}” bukan file yang bisa dibaca. Unggah Excel, CSV, PDF, gambar (PNG, JPEG, WebP), Word atau ZIP.`,
    }),
    zipInZip: ({ name }: { name: string }) => ({
      en: `“${name}” is a ZIP inside a ZIP. Unpack it and upload its files.`,
      id: `“${name}” adalah ZIP di dalam ZIP. Buka dulu dan unggah file di dalamnya.`,
    }),
    illustrationIsPdf: {
      en: 'An official illustration is uploaded as a PDF.',
      id: 'Ilustrasi resmi diunggah sebagai PDF.',
    },
  },
  ASSET_TOO_LARGE: {
    uploadTooLarge: ({ mb }: { mb: number }) => ({
      en: `These files are over ${mb} MB together. Upload fewer at once.`,
      id: `Total file lebih dari ${mb} MB. Unggah lebih sedikit sekaligus.`,
    }),
    fileTooLarge: ({ name, mb }: { name: string; mb: number }) => ({
      en: `“${name}” is over ${mb} MB.`,
      id: `“${name}” lebih dari ${mb} MB.`,
    }),
    zipTooManyFiles: ({ name, max }: { name: string; max: number }) => ({
      en: `“${name}” holds more than ${max} files.`,
      id: `“${name}” berisi lebih dari ${max} file.`,
    }),
    zipUnpacksTooLarge: ({ name, mb }: { name: string; mb: number }) => ({
      en: `“${name}” unpacks to more than ${mb} MB.`,
      id: `Isi “${name}” lebih dari ${mb} MB.`,
    }),
  },
  VALIDATION_FAILED: {
    noFiles: {
      en: 'Choose at least one file.',
      id: 'Pilih minimal satu file.',
    },
    tooManyFiles: ({ max }: { max: number }) => ({
      en: `Upload at most ${max} files at once.`,
      id: `Unggah paling banyak ${max} file sekaligus.`,
    }),
    unknownQuestion: {
      en: 'This card has no such question.',
      id: 'Kartu ini tidak punya pertanyaan itu.',
    },
    notAChoice: {
      en: 'Choose one of the answers offered.',
      id: 'Pilih salah satu jawaban yang tersedia.',
    },
    notADay: {
      en: 'Give the date as a day of the calendar.',
      id: 'Isi tanggal yang benar.',
    },
    notANumber: {
      en: 'Type the number exactly as the file shows it, digits only.',
      id: 'Ketik angkanya persis seperti di file, hanya angka.',
    },
    emptyAnswer: {
      en: 'Type an answer.',
      id: 'Ketik jawabannya.',
    },
    illustrationDate: {
      en: 'Give the illustration’s date, today or earlier.',
      id: 'Isi tanggal ilustrasi, hari ini atau sebelumnya.',
    },
    blocksShape: ({ field }: { field: string }) => ({
      en: `${field} has a value it cannot take.`,
      id: `${field} berisi nilai yang tidak bisa diterima.`,
    }),
  },
});
