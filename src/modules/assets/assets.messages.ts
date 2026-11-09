import { formatNumber } from '@/common/format/format';
import { refusals } from '@/common/i18n/sentence';

/**
 * **What the file store refuses, in both languages** (P18.10-T5 AC-2): an upload by somebody in no office, one too
 * large or of a type not taken, one that never finished, and a server with no storage at all. A *file* stays *file*
 * and *upload* is *unggah* (the approved glossary's §B.0).
 */
export const ASSETS_REFUSALS = refusals('modules/assets', {
  TENANT_NO_MEMBERSHIP: {
    notJoined: {
      en: 'You have not joined a KPM yet.',
      id: 'Anda belum bergabung dengan KPM.',
    },
  },
  ASSET_NOT_UPLOADED: {
    neverFinished: {
      en: 'That file never finished uploading. Try again.',
      id: 'File itu tidak selesai diunggah. Coba lagi.',
    },
  },
  ASSET_NOT_CONFIRMED: {
    notYet: {
      en: 'This file has not finished uploading yet. Try again shortly.',
      id: 'File ini belum selesai diunggah. Coba lagi sebentar lagi.',
    },
  },
  ASSET_TOO_LARGE: {
    atMost: ({ mb }: { mb: number }) => ({
      en: `Files must be ${mb} MB or smaller.`,
      id: `Ukuran file paling besar ${formatNumber(mb, undefined, 'id')} MB.`,
    }),
  },
  ASSET_TYPE_NOT_ALLOWED: {
    notAccepted: {
      en: 'That file type is not accepted.',
      id: 'Jenis file itu tidak diterima.',
    },
  },
  STORAGE_NOT_CONFIGURED: {
    noStorage: {
      en: 'File storage is not configured on this server, so files cannot be uploaded or opened here.',
      id: 'Penyimpanan file belum dikonfigurasi di server ini, jadi file tidak dapat diunggah atau dibuka di sini.',
    },
  },
});
