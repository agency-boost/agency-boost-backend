import { refusals } from '@/common/i18n/sentence';

/**
 * **The premium tables' and the Proposal tab's refusals, in both languages** (P19.15-T1, T4 AC-1; ADR-0258). *Tabel
 * premi*, *Ketentuan*, *Berlaku mulai*, *Uji 3 contoh* and *Isian* are the screen's own words (glossary, *Proposal data*);
 * a field is named as the API names it.
 */
export const PRODUCT_DATA_REFUSALS = refusals('modules/product-data', {
  PERM_DENIED: {
    readOnly: {
      en: 'You can see this insurer’s proposal data but not change it. Ask the Super Admin for Kelola data produk.',
      id: 'Anda bisa melihat data proposal perusahaan ini tetapi tidak bisa mengubahnya. Minta Kelola data produk ke Super Admin.',
    },
  },
  RATE_TABLE_NOT_EDITABLE: {
    notDraft: ({ status }: { status: string }) => ({
      en: `This premium table version is ${status}, not a draft: it is never edited. Upload a new version instead.`,
      id: `Versi tabel premi ini sudah ${{ scheduled: 'terjadwal', active: 'berlaku', old: 'lama', off: 'mati' }[status] ?? status}, `
        + 'bukan draf: versi ini tidak diubah lagi. Unggah versi baru.',
    }),
    alreadyOff: {
      en: 'This premium table version is already turned off.',
      id: 'Versi tabel premi ini sudah dimatikan.',
    },
    notActivated: {
      en: 'A draft is deleted, not turned off.',
      id: 'Draf dihapus, bukan dimatikan.',
    },
  },
  RATE_TABLE_NOT_READY: {
    unmapped: {
      en: 'Confirm the columns first (Cocokkan kolom).',
      id: 'Cocokkan kolom dulu.',
    },
    noRows: {
      en: 'This premium table has no rows to calculate from.',
      id: 'Tabel premi ini tidak punya baris untuk menghitung.',
    },
    rules: {
      en: 'Check and save the rules read from the Ketentuan sheet first.',
      id: 'Periksa dan simpan dulu ketentuan dari sheet Ketentuan.',
    },
    tests: ({ max }: { max: number }) => ({
      en: `All ${max} test profiles must match the official illustration within Rp1, or write the reason for activating anyway.`,
      id: `Ketiga contoh (${max}) harus sama dengan ilustrasi resmi (selisih paling banyak Rp1), atau tulis alasan tetap mengaktifkan.`,
    }),
  },
  RATE_TABLE_IN_USE: {
    used: {
      en: 'A proposal was calculated with this version, so it cannot be deleted. Turn it off instead: proposals keep their numbers.',
      id: 'Versi ini sudah dipakai menghitung proposal, jadi tidak bisa dihapus. Matikan saja: proposal tetap memakai angkanya.',
    },
  },
  RATE_TABLE_ROWS_INVALID: {
    problems: ({ count }: { count: number }) => ({
      en: `${count} ${count === 1 ? 'cell' : 'cells'} of the table cannot be read with these columns. Fix the file or the columns.`,
      id: `${count} sel tabel tidak bisa dibaca dengan kolom ini. Perbaiki file atau pilihan kolomnya.`,
    }),
  },
  ASSET_TOO_LARGE: {
    tableTooLarge: ({ mb }: { mb: number }) => ({
      en: `A premium table file can be at most ${mb} MB.`,
      id: `File tabel premi paling besar ${mb} MB.`,
    }),
  },
  UPLOAD_MALFORMED_CSV: {
    noHeader: {
      en: 'The file has no header row with column names.',
      id: 'File tidak punya baris judul kolom.',
    },
    tooManyRows: ({ max }: { max: number }) => ({
      en: `A premium table can have at most ${max} rows.`,
      id: `Tabel premi paling banyak ${max} baris.`,
    }),
    notATable: {
      en: 'Upload the premium table as Excel (.xlsx) or CSV. A PDF goes through Unggah file.',
      id: 'Unggah tabel premi sebagai Excel (.xlsx) atau CSV. PDF diunggah lewat Unggah file.',
    },
  },
  VALIDATION_FAILED: {
    notAForm: {
      en: 'Send the premium table as a multipart form with one field called file.',
      id: 'Kirim tabel premi sebagai form multipart dengan satu kolom bernama file.',
    },
    noFile: {
      en: 'Choose the premium table file.',
      id: 'Pilih file tabel premi.',
    },
    dateShape: ({ field }: { field: string }) => ({
      en: `${field} must be a day written YYYY-MM-DD.`,
      id: `${field} harus berupa tanggal YYYY-MM-DD.`,
    }),
    dateOrder: {
      en: 'Berlaku sampai cannot be before Berlaku mulai.',
      id: 'Berlaku sampai tidak boleh sebelum Berlaku mulai.',
    },
    columnUnknown: ({ column }: { column: string }) => ({
      en: `The file has no column called ${column}.`,
      id: `File tidak punya kolom ${column}.`,
    }),
    roleTwice: ({ role }: { role: string }) => ({
      en: `Only one column can be ${role}.`,
      id: `Hanya satu kolom yang boleh menjadi ${role}.`,
    }),
    rateColumn: {
      en: 'Choose the column with the rate per Rp1.000 UP or the annual premium.',
      id: 'Pilih kolom tarif per Rp1.000 UP atau premi tahunan.',
    },
    bandColumns: {
      en: 'A premium per UP band needs both band columns.',
      id: 'Premi per rentang UP memerlukan kedua kolom rentang.',
    },
    rule: ({ field }: { field: string }) => ({
      en: `${field} has a value it cannot take.`,
      id: `${field} berisi nilai yang tidak bisa diterima.`,
    }),
    ruleOrder: ({ field }: { field: string }) => ({
      en: `${field}: the minimum cannot be larger than the maximum.`,
      id: `${field}: minimum tidak boleh lebih besar dari maksimum.`,
    }),
    tests: ({ max }: { max: number }) => ({
      en: `Enter exactly ${max} test profiles.`,
      id: `Isi tepat ${max} contoh.`,
    }),
    testShape: ({ field }: { field: string }) => ({
      en: `${field} has a value it cannot take.`,
      id: `${field} berisi nilai yang tidak bisa diterima.`,
    }),
    reason: ({ max }: { max: number }) => ({
      en: `Write the reason in at most ${max} characters.`,
      id: `Tulis alasannya paling banyak ${max} karakter.`,
    }),
    noTableToTry: {
      en: 'That premium table version is not this product’s.',
      id: 'Versi tabel premi itu bukan milik produk ini.',
    },
  },
});
