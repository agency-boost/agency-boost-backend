import { refusals } from '@/common/i18n/sentence';

/**
 * **Billing's refusals** (P19.4-T3; ADR-0211): a quote with nobody to receive it, and the quote's inputs. The quote as
 * the Owner reads it — the email and the inbox row — is `notifications/billing-quote.messages.ts`.
 */
export const BILLING_REFUSALS = refusals('modules/billing: refusals', {
  BILLING_QUOTE_NO_OWNER: {
    noOwner: {
      en: 'This KPM has no Owner yet, so there is nobody to send the quote to. Print it or save it as a PDF instead.',
      id: 'KPM ini belum punya Owner, jadi tidak ada yang bisa dikirimi penawaran. Cetak atau simpan sebagai PDF saja.',
    },
    unverified: {
      en: 'The Owner has not verified their email address, so the quote cannot be sent to it. Print it or save it as a '
        + 'PDF instead.',
      id: 'Owner belum memverifikasi alamat emailnya, jadi penawaran tidak dapat dikirim ke sana. Cetak atau simpan '
        + 'sebagai PDF saja.',
    },
  },
  VALIDATION_FAILED: {
    leaders: {
      en: 'leaders must be a whole number from 1.',
      id: 'leaders harus berupa bilangan bulat mulai dari 1.',
    },
    plan: {
      en: 'plan must be six_months or annual.',
      id: 'plan harus six_months atau annual.',
    },
    percent: {
      en: 'Enter a percent from 0 to 100.',
      id: 'Masukkan persentase dari 0 sampai 100.',
    },
    amount: {
      en: 'Enter an amount from Rp 0 to the plan’s rate, in whole rupiah.',
      id: 'Masukkan jumlah dari Rp 0 sampai tarif paket, dalam rupiah penuh.',
    },
    discountType: {
      en: 'discount.type must be percent or flat.',
      id: 'discount.type harus percent atau flat.',
    },
    date: {
      en: 'Dates must be written YYYY-MM-DD.',
      id: 'Tanggal harus ditulis dengan format YYYY-MM-DD.',
    },
    endBeforeStart: {
      en: 'Enter an end date on or after the start date.',
      id: 'Masukkan tanggal berakhir yang sama dengan atau setelah tanggal mulai.',
    },
    name: {
      en: 'Enter the PIC and who is sending the quote.',
      id: 'Isi PIC dan siapa yang mengirim penawaran.',
    },
  },
});
