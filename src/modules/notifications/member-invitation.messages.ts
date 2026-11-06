import { formatNumber } from '@/common/format/format';
import { messages } from '@/common/i18n/sentence';

/**
 * **The invitation a member import sends a new person** (P19.3-T4; ADR-0205 §10): a one-time link to choose their
 * password, through the reset link's mechanism (P4-T14) and the app's `/reset-password/<token>` page, worded as an
 * invitation. Email only (ADR-0010): nothing is sent by WhatsApp. `office` is the KPM's branch name; `days` the link's
 * lifetime (`ROSTER_INVITATION.TTL_DAYS`).
 *
 * Kept beside the renderer that writes it, apart from `notification.messages.ts`, so the import's mail is one file.
 */
export const MEMBER_INVITATION_WORDS = messages('modules/notifications: member invitation', {
  subject: ({ office }: { office: string }) => ({
    en: office ? `You are invited to ${office} on AgencyBoost` : 'You are invited to AgencyBoost',
    id: office ? `Anda diundang ke ${office} di AgencyBoost` : 'Anda diundang ke AgencyBoost',
  }),
  open: ({ office }: { office: string }) => ({
    en: `${office || 'Your KPM'} has added you to AgencyBoost. Open this link to choose your password and sign in.`,
    id: `${office || 'KPM Anda'} telah menambahkan Anda ke AgencyBoost. Buka tautan ini untuk membuat kata sandi dan masuk.`,
  }),
  expires: ({ days }: { days: number }) => ({
    en: `The link works once, for ${days} days. After that, use "Forgot your password?" on the sign-in page with this `
      + 'address.',
    id: `Tautan ini hanya bisa dipakai sekali, selama ${formatNumber(days, undefined, 'id')} hari. Setelah itu, pakai `
      + '"Lupa kata sandi?" di halaman masuk dengan alamat ini.',
  }),
});

/**
 * **The invitation a new KPM's Owner is sent** (ADR-0212 §2; P19.4-T3 AC-6): the same one-time link, worded for the
 * person who will run the office — `office` the KPM's code and branch (*"KPM 0602 · Bandung Dago"*), `days` the link's
 * lifetime. Email only (ADR-0010).
 */
export const OWNER_INVITATION_WORDS = messages('modules/notifications: owner invitation', {
  subject: ({ office }: { office: string }) => ({
    en: `You are the Owner of ${office} on AgencyBoost`,
    id: `Anda pemilik ${office} di AgencyBoost`,
  }),
  open: ({ office }: { office: string }) => ({
    en: `AgencyBoost has made you the Owner of ${office}. Open this link to choose your password and sign in, then `
      + 'add your members on People.',
    id: `AgencyBoost telah menjadikan Anda pemilik ${office}. Buka tautan ini untuk membuat kata sandi dan masuk, `
      + 'lalu tambahkan anggota Anda di menu People.',
  }),
});
