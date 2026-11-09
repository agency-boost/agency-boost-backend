import { refusals } from '@/common/i18n/sentence';

/**
 * **The calendar's refusals, in both languages** (P18.10-T5 AC-2, AC-3): an entry's timing, field by field, the
 * invitation list's own rules, a block its member cannot answer, and the people picker's cursor. A calendar is a
 * *kalender*, an entry an *entri*, time placed on somebody's calendar a *blok waktu* (the API's vocabulary); a field is
 * named as the API names it (`startsOn`, `inviteeIds`), and so is a format (`YYYY-MM-DD`, `HH:mm`).
 *
 * `field` is the field's name — or, in a DTO's own sentence, class-validator's `$property`, which it writes in both
 * languages when it refuses the field.
 */
export const CALENDAR_REFUSALS = refusals('modules/calendar', {
  VALIDATION_FAILED: {
    /* An entry's timing (`calendar-time.ts`) and the period read's day (`calendar.service.ts`). */
    notPartOf: ({ field, travel }: { field: string; travel: boolean }) => ({
      en: `${field} is not part of ${travel ? 'a travel entry' : 'a timed entry'}.`,
      id: `${field} bukan bagian dari ${travel ? 'entri perjalanan' : 'entri dengan jam mulai dan selesai'}.`,
    }),
    dayShape: ({ field }: { field: string }) => ({
      en: `${field} must be a day, written YYYY-MM-DD.`,
      id: `${field} harus berupa tanggal, dengan format YYYY-MM-DD.`,
    }),
    timeShape: ({ field }: { field: string }) => ({
      en: `${field} must be a time, written HH:mm.`,
      id: `${field} harus berupa jam, dengan format HH:mm.`,
    }),
    endsBeforeStarts: {
      en: 'endsOn must be on or after startsOn.',
      id: 'endsOn harus sama dengan atau setelah startsOn.',
    },
    tripTooLong: ({ max }: { max: number }) => ({
      en: `endsOn must be at most ${max} days from startsOn, inclusive.`,
      id: `endsOn paling lambat ${max} hari dari startsOn, termasuk kedua tanggalnya.`,
    }),
    endBeforeStart: {
      en: 'end must be after start on the same date.',
      id: 'end harus setelah start pada tanggal yang sama.',
    },
    /* A trip with times (UI V1, UI-104 point 8): its end, on endsOn, after its start, on startsOn. */
    tripEndBeforeStart: {
      en: 'endsOn and end must come after startsOn and start.',
      id: 'endsOn dan end harus setelah startsOn dan start.',
    },

    /* The DTO's own sentence for a time (`field`, `calendar.dto.ts`); its day is `dayShape`. */
    clockShape: ({ field }: { field: string }) => ({
      en: `${field} must be a time, written HH:mm, 00:00 to 23:59.`,
      id: `${field} harus berupa jam, dengan format HH:mm, dari 00:00 sampai 23:59.`,
    }),

    /* An invitation list's own rules (`calendar.service.ts`). */
    inviteeSelf: {
      en: 'inviteeIds must not include you: you are on your own entry already.',
      id: 'inviteeIds tidak boleh berisi Anda: Anda sudah ada di entri Anda sendiri.',
    },
    inviteePlaced: {
      en: 'inviteeIds must not include the member the time is placed on: they are on it already.',
      id: 'inviteeIds tidak boleh berisi anggota yang diberi blok waktu ini: dia sudah ada di entri ini.',
    },

    /* The people picker (`calendar-people.service.ts`). */
    cursorNotOurs: {
      en: 'cursor is not one this list wrote: start again without it.',
      id: 'cursor ini bukan dari daftar ini: mulai lagi tanpa cursor.',
    },
  },
  CALENDAR_BLOCK_NOT_ANSWERABLE: {
    placedByLeader: {
      en: 'This time was placed on your calendar by a leader above you. There is nothing to accept or decline.',
      id: 'Waktu ini diblok di kalender Anda oleh leader di atas Anda. Tidak ada yang perlu diterima atau ditolak.',
    },
  },
});
