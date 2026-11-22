import { messages, refusals } from '@/common/i18n/sentence';

/**
 * **The forum's refusals, in both languages** (P18.10-T5 AC-2, AC-3; P19.22-T8): making, moving and removing a forum,
 * and writing its agenda and action items field by field. A forum is a ***forum*** and an action item an ***action
 * item*** in both, as the 19 November screens say them (ADR-0276); the reader is *Anda* (§B.0). A field is named as the
 * API names it — `date`, `done`, `picMembershipId` — in both.
 */
export const LEADER_MEETINGS_REFUSALS = refusals('modules/leader-meetings', {
  VALIDATION_FAILED: {
    /* ---- the DTOs' own sentences (`field`) ---- */
    dateShape: {
      en: 'date must be a real day, YYYY-MM-DD',
      id: 'date harus berupa tanggal yang benar, dengan format YYYY-MM-DD',
    },
    timeShape: {
      en: 'time must be a real time of day, HH:MM',
      id: 'time harus berupa jam yang benar, dengan format HH:MM',
    },
    textNotEmpty: {
      en: 'text must not be empty',
      id: 'text tidak boleh kosong',
    },
    /* ---- the services' ---- */
    dateOrTime: {
      en: 'Send a date, a time, or both.',
      id: 'Kirim tanggal, jam, atau keduanya.',
    },
    picBothWays: {
      en: 'Send picMembershipId or picAll, not both.',
      id: 'Kirim picMembershipId atau picAll, jangan keduanya.',
    },
    picNotEditor: {
      en: 'The PIC must be one of the forum’s core leaders, its Owner or an Admin.',
      id: 'PIC harus salah satu core leader forum ini, Owner, atau Admin.',
    },
    exactlyOne: ({ fields }: { fields: readonly string[] }) => ({
      en: `Send exactly one of ${fields.join(', ')}, with the version you read.`,
      id: `Kirim tepat satu dari ${fields.join(', ')}, beserta versi yang Anda baca.`,
    }),
  },
  VERSION_CONFLICT: {
    madeAtSameMoment: {
      en: 'Another forum was made at the same moment. Try again.',
      id: 'Forum lain dibuat pada saat yang sama. Coba lagi.',
    },
    itemGone: {
      en: 'This item is no longer in the forum. Reload to see what is there now.',
      id: 'Item ini sudah tidak ada di forum. Muat ulang untuk melihat isinya sekarang.',
    },
  },
  LEADER_MEETING_COMPLETED: {
    dateStays: {
      en: 'This forum has already taken place, so its date and time stay.',
      id: 'Forum ini sudah berlangsung, jadi tanggal dan jamnya tetap.',
    },
  },
  LEADER_MEETING_HAS_MINUTES: {
    writtenIn: {
      en: 'Something has been written in this forum, so it can’t be deleted.',
      id: 'Sudah ada yang ditulis di forum ini, jadi forum ini tidak dapat dihapus.',
    },
  },
});

/**
 * **The texts the forum stores for a new forum, in both languages** (P19.22-T8 AC-3; ADR-0276, ADR-0179 §7): an
 * office's first agenda, the SLF mockup's three lines (`slf-tablet` frame 6). **Written once, in the language of whoever
 * makes the forum, and stored as text**: from then it is the office's, shown as stored and edited as typed.
 */
export const LEADER_MEETINGS_MESSAGES = messages('modules/leader-meetings', {
  reviewNumbers: {
    en: 'Review the MAPA driver and informal group figures',
    id: 'Review angka MAPA driver dan informal group',
  },
  updateActionItems: {
    en: 'Update action items',
    id: 'Update action items',
  },
  agreeNewItems: {
    en: 'Agreements and new action items',
    id: 'Kesepakatan dan action items baru',
  },
});
