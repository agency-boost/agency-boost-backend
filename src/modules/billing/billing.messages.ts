import { refusals } from '@/common/i18n/sentence';

/**
 * **Langganan & akses' refusals** (P19.23-T5; ADR-0279): the calculator's inputs, as *Konfirmasi paket* and *Buat PDF*
 * send them. Each is said under the field it names (`details.field`), in the reader's language.
 */
export const BILLING_REFUSALS = refusals('modules/billing: refusals', {
  VALIDATION_FAILED: {
    leaders: {
      en: 'Enter the number of leaders: a whole number from 1 to 10.000.',
      id: 'Isi jumlah leader: bilangan bulat dari 1 sampai 10.000.',
    },
    agents: {
      en: 'Enter the number of agents as a whole number up to 10.000, or leave it empty.',
      id: 'Isi jumlah agent dengan bilangan bulat sampai 10.000, atau kosongkan.',
    },
    plan: {
      en: 'Choose Tahunan or 6 bulan.',
      id: 'Pilih Tahunan atau 6 bulan.',
    },
    priceMode: {
      en: 'Type the price per leader, or the total.',
      id: 'Isi harga per leader, atau totalnya.',
    },
    rate: {
      en: 'Enter a price per leader per month from Rp 0 to Rp 100.000.000, in whole rupiah.',
      id: 'Isi harga per leader per bulan dari Rp 0 sampai Rp 100.000.000, dalam rupiah penuh.',
    },
    total: {
      en: 'Enter a total in whole rupiah, at most Rp 100.000.000 per leader per month.',
      id: 'Isi total dalam rupiah penuh, paling banyak Rp 100.000.000 per leader per bulan.',
    },
    bulkType: {
      en: 'The bulk discount is a percent or an amount in rupiah.',
      id: 'Diskon bulk order berupa persen atau jumlah rupiah.',
    },
    percent: {
      en: 'Enter a whole percent from 0 to 100.',
      id: 'Isi persen bulat dari 0 sampai 100.',
    },
    amount: {
      en: 'Enter a discount from Rp 0 up to the total, in whole rupiah.',
      id: 'Isi diskon dari Rp 0 sampai sebesar totalnya, dalam rupiah penuh.',
    },
    date: {
      en: 'Enter a real date, YYYY-MM-DD.',
      id: 'Isi tanggal yang benar, YYYY-MM-DD.',
    },
    endBeforeStart: {
      en: 'Enter an end date on or after the start date.',
      id: 'Isi tanggal berakhir yang sama dengan atau setelah tanggal mulai.',
    },
    note: {
      en: 'Keep the note to 500 characters.',
      id: 'Catatan paling banyak 500 karakter.',
    },
    kpmName: {
      en: 'Choose a KPM or type the new KPM’s name, up to 120 characters.',
      id: 'Pilih KPM atau tulis nama KPM baru, paling banyak 120 karakter.',
    },
    filter: {
      en: 'filter must be all or needs_action.',
      id: 'filter harus all atau needs_action.',
    },
  },
});
