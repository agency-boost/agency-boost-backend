import { refusals } from '@/common/i18n/sentence';

/**
 * **The proposal's refusals, in both languages** (P19.7-T2; ADR-0221, ADR-0225 §7). *Proposal*, *Lead* and *Sales* stay
 * English (glossary §A); *Premi* is the product's premium, *Tertanggung* the insured, *Cara bayar* the payment frequency.
 * A field is named as the API names it (`fieldValues.plan`, `insured.age`).
 */
export const PROPOSAL_REFUSALS = refusals('modules/proposals', {
  PROPOSAL_NOT_FOUND: {
    notYours: {
      en: 'No proposal of yours has that id. It may have been deleted.',
      id: 'Tidak ada proposal milik Anda dengan id ini. Mungkin sudah dihapus.',
    },
  },
  PROPOSAL_PRODUCT_WITHDRAWN: {
    notOffered: ({ reason }: { reason: string }) => ({
      en: {
        withdrawn: 'This product has been withdrawn, so it cannot be added to a proposal.',
        closed: 'This product is closed to new business, so it cannot be added to a proposal.',
        rider: 'A rider is added with its base product in the official illustration, not to a proposal on its own.',
        not_on_shelf: 'This product is not offered by your KPM.',
        channel: 'This product is not offered on this channel. Switch Konvensional / Syariah first.',
        age: 'This product is not offered at the client’s age.',
      }[reason] ?? 'This product cannot be added to a proposal.',
      id: {
        withdrawn: 'Produk ini sudah ditarik, jadi tidak bisa ditambahkan ke proposal.',
        closed: 'Produk ini sudah tidak menerima nasabah baru, jadi tidak bisa ditambahkan ke proposal.',
        rider: 'Rider ditambahkan bersama produk dasarnya di ilustrasi resmi, tidak sendiri ke proposal.',
        not_on_shelf: 'Produk ini tidak dijual oleh KPM Anda.',
        channel: 'Produk ini tidak tersedia untuk pilihan ini. Ganti Konvensional / Syariah dulu.',
        age: 'Produk ini tidak tersedia untuk umur klien.',
      }[reason] ?? 'Produk ini tidak bisa ditambahkan ke proposal.',
    }),
    noLongerOffered: ({ count }: { count: number }) => ({
      en: `${count} ${count === 1 ? 'product in this proposal is' : 'products in this proposal are'} no longer offered. `
        + 'Remove them before saving the PDF.',
      id: `${count} produk di proposal ini sudah tidak tersedia. Hapus dulu sebelum menyimpan PDF.`,
    }),
  },
  PROPOSAL_INCOMPLETE: {
    fillGaps: {
      en: 'Fill in what is still empty before saving the PDF.',
      id: 'Lengkapi dulu yang masih kosong sebelum menyimpan PDF.',
    },
    noProduct: {
      en: 'Add at least one product before saving the PDF.',
      id: 'Tambahkan minimal satu produk sebelum menyimpan PDF.',
    },
  },
  VALIDATION_FAILED: {
    notSalesLead: {
      en: 'A proposal is made for a Sales lead. Set this lead’s type to Sales first.',
      id: 'Proposal dibuat untuk lead Sales. Ubah jenis lead ini menjadi Sales dulu.',
    },
    leadNeedsAgeAndGender: {
      en: 'Save the client’s age and gender on the lead first.',
      id: 'Simpan umur dan jenis kelamin klien di lead dulu.',
    },
    alreadyAdded: {
      en: 'This product is already in the proposal.',
      id: 'Produk ini sudah ada di proposal.',
    },
    tooManyItems: ({ max }: { max: number }) => ({
      en: `A proposal holds at most ${max} products.`,
      id: `Satu proposal paling banyak ${max} produk.`,
    }),
    noSuchItem: {
      en: 'itemId names no product of this proposal.',
      id: 'itemId tidak menyebut produk mana pun di proposal ini.',
    },
    unknownField: ({ key }: { key: string }) => ({
      en: `fieldValues.${key} is not a field of this product.`,
      id: `fieldValues.${key} bukan kolom produk ini.`,
    }),
    fixedField: ({ key }: { key: string }) => ({
      en: `fieldValues.${key} is fixed by the product and takes no value.`,
      id: `fieldValues.${key} sudah ditetapkan oleh produk dan tidak bisa diisi.`,
    }),
    chipsValue: ({ key }: { key: string }) => ({
      en: `fieldValues.${key} must be one of the field’s options.`,
      id: `fieldValues.${key} harus salah satu pilihan kolom ini.`,
    }),
    moneyValue: ({ key, max }: { key: string; max: number }) => ({
      en: `fieldValues.${key} must be a whole amount from 0 to ${max} minor units, or null to clear it.`,
      id: `fieldValues.${key} harus berupa jumlah bulat dari 0 sampai ${max} (satuan terkecil), atau null untuk mengosongkannya.`,
    }),
    belowMinimum: ({ key, min }: { key: string; min: number }) => ({
      en: `fieldValues.${key} must be at least ${min} minor units for this product.`,
      id: `fieldValues.${key} minimal ${min} (satuan terkecil) untuk produk ini.`,
    }),
    premiumValue: ({ max }: { max: number }) => ({
      en: `premium.amountMinor must be a whole amount from 0 to ${max} minor units, or null to clear it.`,
      id: `premium.amountMinor harus berupa jumlah bulat dari 0 sampai ${max} (satuan terkecil), atau null untuk mengosongkannya.`,
    }),
    insuredName: ({ max }: { max: number }) => ({
      en: `insured.name must be text of 1 to ${max} characters, or null.`,
      id: `insured.name harus berupa teks 1 sampai ${max} karakter, atau null.`,
    }),
    insuredAgeShape: {
      en: 'insured.age must be a whole number of years, or null.',
      id: 'insured.age harus berupa bilangan bulat (tahun), atau null.',
    },
    clientTakesNoName: {
      en: 'The client is insured: insured.name and insured.age come from the client and are not sent.',
      id: 'Klien adalah tertanggung: insured.name dan insured.age diambil dari klien dan tidak dikirim.',
    },
  },
});
