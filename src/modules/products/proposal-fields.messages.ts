import { refusals } from '@/common/i18n/sentence';

/**
 * **A product's proposal fields, refused in both languages** (P19.7-T1 AC-2, AC-3; ADR-0225 §2, §4, §5): what the Super
 * Admin's *Proposal* section and an office's FAQ and plan highlights are held to. Each names the path it refuses
 * (`proposalFields[2].options`) as the API names it, and `details.field` carries the same path. The shared sentences —
 * a required field, text too long, one of a list — are `common/validation`'s; these are the rules of a proposal field.
 * *Proposal*, *chips* and *money* stay as the API names them; *Tanya-jawab* is the FAQ.
 */
export const PROPOSAL_FIELDS_REFUSALS = refusals('modules/products/proposal-fields', {
  VALIDATION_FAILED: {
    notAnObject: ({ field }: { field: string }) => ({
      en: `${field} must be an object.`,
      id: `${field} harus berupa objek.`,
    }),
    notAList: ({ field }: { field: string }) => ({
      en: `${field} must be a list.`,
      id: `${field} harus berupa daftar.`,
    }),
    listAtMost: ({ field, max }: { field: string; max: number }) => ({
      en: `${field} holds at most ${max}.`,
      id: `${field} paling banyak berisi ${max}.`,
    }),
    listBetween: ({ field, min, max }: { field: string; min: number; max: number }) => ({
      en: `${field} holds ${min} to ${max}.`,
      id: `${field} berisi ${min} sampai ${max}.`,
    }),
    notBoolean: ({ field }: { field: string }) => ({
      en: `${field} must be true or false.`,
      id: `${field} harus true atau false.`,
    }),
    keyShape: ({ field }: { field: string }) => ({
      en: `${field} is lower-case letters, digits and underscores, a letter first, at most 40 characters.`,
      id: `${field} berisi huruf kecil, angka, dan garis bawah, diawali huruf, paling banyak 40 karakter.`,
    }),
    keyReserved: ({ field, key }: { field: string; key: string }) => ({
      en: `${field}: "${key}" is reserved — every proposal has Tertanggung and the premium already.`,
      id: `${field}: "${key}" sudah dipakai — setiap proposal sudah memiliki Tertanggung dan premi.`,
    }),
    keyTwice: ({ field, key }: { field: string; key: string }) => ({
      en: `${field}: "${key}" is already the key of another field of this product.`,
      id: `${field}: "${key}" sudah menjadi kunci kolom lain di produk ini.`,
    }),
    tooManyOnSummary: ({ field, max }: { field: string; max: number }) => ({
      en: `${field}: at most ${max} fields of a product show on page 1 (showOnSummary).`,
      id: `${field}: paling banyak ${max} kolom satu produk tampil di halaman 1 (showOnSummary).`,
    }),
    onlyOneFlag: ({ field, flag }: { field: string; flag: string }) => ({
      en: `${field}: only one field of a product may be marked ${flag}.`,
      id: `${field}: hanya satu kolom satu produk yang boleh ditandai ${flag}.`,
    }),
    flagOnType: ({ field, flag, types }: { field: string; flag: string; types: string }) => ({
      en: `${field}: ${flag} is for a ${types} field.`,
      id: `${field}: ${flag} hanya untuk kolom ${types}.`,
    }),
    notForType: ({ field, type }: { field: string; type: string }) => ({
      en: `${field} has no place on a ${type} field.`,
      id: `${field} tidak berlaku untuk kolom ${type}.`,
    }),
    labelsTwice: ({ field, label }: { field: string; label: string }) => ({
      en: `${field}: "${label}" is there twice. Each option has its own label.`,
      id: `${field}: "${label}" ada dua kali. Setiap pilihan memiliki label sendiri.`,
    }),
    defaultNotAnOption: ({ field }: { field: string }) => ({
      en: `${field} must be one of the field's options: every chips field is preselected.`,
      id: `${field} harus salah satu pilihan kolom ini: setiap kolom chips sudah terpilih sejak awal.`,
    }),
    fixedOneOption: ({ field }: { field: string }) => ({
      en: `${field}: a fixed field has exactly one option, the sentence it shows.`,
      id: `${field}: kolom fixed memiliki tepat satu pilihan, yaitu kalimat yang ditampilkan.`,
    }),
    yearsShape: ({ field, max }: { field: string; max: number }) => ({
      en: `${field} is a whole number of years from 1 to ${max}, or null where the term is not a number of years.`,
      id: `${field} berupa jumlah tahun bulat dari 1 sampai ${max}, atau null jika masanya bukan hitungan tahun.`,
    }),
    amountsAscending: ({ field }: { field: string }) => ({
      en: `${field}: quick amounts are positive whole sums in minor units, smallest first, none twice.`,
      id: `${field}: nominal cepat berupa jumlah bulat positif dalam satuan terkecil, dari yang terkecil, tanpa ganda.`,
    }),
    wholeAmount: ({ field }: { field: string }) => ({
      en: `${field} is a whole sum in minor units, zero or more, or null.`,
      id: `${field} berupa jumlah bulat dalam satuan terkecil, nol atau lebih, atau null.`,
    }),
    currencyNotSold: ({ field, currencies }: { field: string; currencies: string }) => ({
      en: `${field}: each option names a currency this product is sold in (${currencies}).`,
      id: `${field}: setiap pilihan menyebut mata uang yang dijual untuk produk ini (${currencies}).`,
    }),
    planNeedsField: ({ field }: { field: string }) => ({
      en: `${field}: plan cards need a chips field marked plan, whose options name the plans.`,
      id: `${field}: kartu plan memerlukan kolom chips bertanda plan, yang pilihannya menyebut nama plan.`,
    }),
    planNotAnOption: ({ field, name }: { field: string; name: string }) => ({
      en: `${field}: "${name}" is not an option of the plan field.`,
      id: `${field}: "${name}" bukan pilihan pada kolom plan.`,
    }),
    planTwice: ({ field, name }: { field: string; name: string }) => ({
      en: `${field}: "${name}" already has a plan card.`,
      id: `${field}: "${name}" sudah memiliki kartu plan.`,
    }),
    onePopular: ({ field }: { field: string }) => ({
      en: `${field}: at most one plan is marked Paling banyak dipilih.`,
      id: `${field}: paling banyak satu plan yang ditandai Paling banyak dipilih.`,
    }),
    blockTwice: ({ field, block }: { field: string; block: string }) => ({
      en: `${field}: the ${block} block is there already. Each block appears once.`,
      id: `${field}: blok ${block} sudah ada. Setiap blok hanya muncul sekali.`,
    }),
    notGuaranteedOnCashValue: ({ field }: { field: string }) => ({
      en: `${field}: only the nilai_tunai block is marked not guaranteed.`,
      id: `${field}: hanya blok nilai_tunai yang dapat ditandai tidak dijamin.`,
    }),
    formulaOrText: ({ field }: { field: string }) => ({
      en: `${field}: a row has a formula or a text, one of the two.`,
      id: `${field}: setiap baris berisi rumus atau teks, salah satu saja.`,
    }),
    pageShape: ({ field }: { field: string }) => ({
      en: `${field} is a page number, a whole number from 1.`,
      id: `${field} berupa nomor halaman, bilangan bulat mulai 1.`,
    }),
    pastDay: ({ field }: { field: string }) => ({
      en: `${field} is a day written YYYY-MM-DD, no later than today.`,
      id: `${field} berupa tanggal dengan format YYYY-MM-DD, tidak setelah hari ini.`,
    }),
    formulaGrammar: ({ field, at }: { field: string; at: string }) => ({
      en: `${field}: the formula cannot be read at "${at}". It holds numbers, %, ×, /, +, −, brackets and the `
        + 'keys of this product\'s money fields.',
      id: `${field}: rumus tidak dapat dibaca pada "${at}". Rumus berisi angka, %, ×, /, +, −, kurung, dan kunci `
        + 'kolom uang produk ini.',
    }),
    /** ADR-0225 §4's own sentence, in Indonesian: *"`{name}` bukan kolom uang produk ini."* */
    formulaName: ({ name }: { name: string }) => ({
      en: `\`${name}\` is not a money field of this product.`,
      id: `\`${name}\` bukan kolom uang produk ini.`,
    }),
    syariahNameOnSyariah: {
      en: 'syariahName is for a conventional product whose syariah version is not a product of its own.',
      id: 'syariahName hanya untuk produk konvensional yang versi syariahnya tidak ada sebagai produk tersendiri.',
    },
    planNotOnProduct: ({ field, name }: { field: string; name: string }) => ({
      en: `${field}: "${name}" is not a plan of this product.`,
      id: `${field}: "${name}" bukan plan produk ini.`,
    }),
    // ---- P19.14-T2 (ADR-0255 §2–§5): the catalogue's calculation fields ----
    ageShape: ({ field, max }: { field: string; max: number }) => ({
      en: `${field} is an age at the next birthday, a whole number from 1 to ${max}, or null.`,
      id: `${field} berupa usia ulang tahun berikutnya, bilangan bulat 1 sampai ${max}, atau null.`,
    }),
    entryAgeOrder: ({ field }: { field: string }) => ({
      en: `${field}: the youngest entry age is no older than the oldest.`,
      id: `${field}: usia masuk termuda tidak boleh lebih tua dari yang tertua.`,
    }),
    payTermKeyTwice: ({ field, key }: { field: string; key: string }) => ({
      en: `${field}: "${key}" is already the key of another pay term of this product.`,
      id: `${field}: "${key}" sudah menjadi kunci masa bayar lain di produk ini.`,
    }),
    payTermShape: ({ field }: { field: string }) => ({
      en: `${field}: a pay term is a number of years, up to an age, or single — one of the three at most.`,
      id: `${field}: masa bayar berupa jumlah tahun, sampai usia tertentu, atau sekali bayar — paling banyak salah satu.`,
    }),
    frequencyTwice: ({ field, frequency }: { field: string; frequency: string }) => ({
      en: `${field}: "${frequency}" is there twice.`,
      id: `${field}: "${frequency}" ada dua kali.`,
    }),
    limitOrder: ({ field }: { field: string }) => ({
      en: `${field}: the minimum is no larger than the maximum.`,
      id: `${field}: batas minimum tidak boleh lebih besar dari batas maksimum.`,
    }),
    positiveAmount: ({ field }: { field: string }) => ({
      en: `${field} is a whole sum in minor units above zero, or null.`,
      id: `${field} berupa jumlah bulat dalam satuan terkecil di atas nol, atau null.`,
    }),
    derivedNeedsRule: ({ field }: { field: string }) => ({
      en: `${field}: a derived field is worked out by the product's planRule, which names it. One per product.`,
      id: `${field}: kolom derived dihitung dari planRule produk, yang menyebut kolom ini. Satu per produk.`,
    }),
    ruleField: ({ field }: { field: string }) => ({
      en: `${field} names this product's derived field.`,
      id: `${field} harus menyebut kolom derived produk ini.`,
    }),
    ruleWhen: ({ field }: { field: string }) => ({
      en: `${field}: each condition names a chips field of this product and one of its options.`,
      id: `${field}: setiap syarat menyebut kolom chips produk ini dan salah satu pilihannya.`,
    }),
    ruleValue: ({ field }: { field: string }) => ({
      en: `${field} is one of the derived field's options.`,
      id: `${field} harus salah satu pilihan kolom derived.`,
    }),
  },
});
