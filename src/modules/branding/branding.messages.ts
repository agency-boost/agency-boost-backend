import { refusals } from '@/common/i18n/sentence';

/**
 * **The branding's refusals, in both languages** (P19.6-T1; ADR-0218 §2). No colour is refused since P19.12-T3
 * (ADR-0246): `BRANDING_COLOUR_UNREADABLE` is retired, and its words went with it.
 */
export const BRANDING_REFUSALS = refusals('modules/branding', {
  BRANDING_IMAGE_REFUSED: {
    refused: ({ reason }: { reason: string }) => ({
      en: {
        dimensions: 'The picture is too small, or not the shape this field needs.',
        no_alpha: 'The mascot needs a transparent background (a PNG with transparency).',
        svg_unsafe: 'This SVG holds a script or a link to another file, so it cannot be used. Export it as a PNG.',
        unreadable: 'This file could not be opened as a picture.',
      }[reason] ?? 'This picture cannot be used.',
      id: {
        dimensions: 'Gambar terlalu kecil, atau bentuknya tidak sesuai untuk kolom ini.',
        no_alpha: 'Maskot perlu latar transparan (PNG dengan transparansi).',
        svg_unsafe: 'SVG ini berisi skrip atau tautan ke file lain, jadi tidak bisa dipakai. Ekspor sebagai PNG.',
        unreadable: 'File ini tidak bisa dibuka sebagai gambar.',
      }[reason] ?? 'Gambar ini tidak bisa dipakai.',
    }),
  },
  ASSET_TOO_LARGE: {
    atMost: {
      en: 'Pictures must be 1 MB or smaller.',
      id: 'Ukuran gambar paling besar 1 MB.',
    },
  },
  ASSET_TYPE_NOT_ALLOWED: {
    notAccepted: {
      en: 'That picture type is not accepted here.',
      id: 'Jenis gambar itu tidak diterima di sini.',
    },
  },
  ASSET_NOT_UPLOADED: {
    neverFinished: {
      en: 'The picture did not finish uploading. Choose it again.',
      id: 'Gambar belum selesai diunggah. Pilih lagi.',
    },
  },
  VALIDATION_FAILED: {
    notYours: {
      en: 'That picture was not uploaded for this KPM. Upload it again.',
      id: 'Gambar itu tidak diunggah untuk KPM ini. Unggah lagi.',
    },
    colourPair: {
      en: 'Set both colours, or neither.',
      id: 'Isi kedua warna, atau kosongkan keduanya.',
    },
    squareNeedsLogo: {
      en: 'A square logo goes with a wide logo.',
      id: 'Logo persegi dipasang bersama logo lebar.',
    },
    poseNeedsDefault: {
      en: 'A pose’s picture goes with the default mascot.',
      id: 'Gambar per pose dipasang bersama maskot utama.',
    },
  },
  AUTH_RATE_LIMITED: {
    tooMany: {
      en: 'Too many requests. Try again in a minute.',
      id: 'Terlalu banyak permintaan. Coba lagi dalam satu menit.',
    },
  },
});
