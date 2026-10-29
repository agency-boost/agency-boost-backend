import { formatNumber } from '@/common/format/format';
import { refusals } from '@/common/i18n/sentence';

/** A bound or a count in Indonesian: *1.000* from a thousand up, as the glossary's §E writes a number. */
const idNumber = (n: number): string => formatNumber(n, undefined, 'id');

/** Where an event type sits in a template's list: *Event type 2* — *Jenis event 2*. */
const typeAt = (n: number) => ({ en: `Event type ${n}`, id: `Jenis event ${n}` });

/**
 * **The events module's refusals, in both languages** (P18.98-T5 AC-2, AC-3): an event type and an event as the Owner
 * writes them, a template's list of types, the member's RSVP, claim and answer, and the roll call. *Event* and *RSVP*
 * stay as the glossary keeps them (§A.6); the reader is *Anda* (§B.0), attendance *kehadiran* and feedback *masukan*
 * (§B.1). A field is named as the API names it — `endsAt`, `audience.scope` — in both languages.
 */
export const EVENTS_REFUSALS = refusals('modules/events', {
  VALIDATION_FAILED: {
    /* ---- an event type and an event (`event-input.ts`) ---- */
    colorHex: {
      en: 'color must be a hex value such as #2D9CDB.',
      id: 'color harus berupa nilai hex, misalnya #2D9CDB.',
    },
    locationUrlWeb: {
      en: 'locationUrl must be a web address starting with http:// or https://.',
      id: 'locationUrl harus berupa alamat web yang diawali http:// atau https://.',
    },
    endsAfterStarts: {
      en: 'endsAt must be after startsAt.',
      id: 'endsAt harus setelah startsAt.',
    },
    textAtMost: ({ field, max }: { field: string; max: number }) => ({
      en: `${field} is at most ${max} characters.`,
      id: `${field} paling banyak ${idNumber(max)} karakter.`,
    }),
    notADateTime: ({ field }: { field: string }) => ({
      en: `${field} is not a date and time.`,
      id: `${field} bukan tanggal dan waktu yang valid.`,
    }),
    audienceNotObject: {
      en: 'audience must be an object of fields.',
      id: 'audience harus berupa objek berisi kolom.',
    },
    issuerOneOf: ({ values }: { values: readonly string[] }) => ({
      en: `audience.issuer is one of: ${values.join(', ')}.`,
      id: `audience.issuer harus salah satu dari: ${values.join(', ')}.`,
    }),
    scopeOneOf: ({ values }: { values: readonly string[] }) => ({
      en: `audience.scope is one of: ${values.join(', ')}.`,
      id: `audience.scope harus salah satu dari: ${values.join(', ')}.`,
    }),
    inviteesNotList: {
      en: 'audience.inviteeMembershipIds must be a list.',
      id: 'audience.inviteeMembershipIds harus berupa daftar.',
    },
    inviteesMalformed: ({ count }: { count: number }) => ({
      en: `audience.inviteeMembershipIds holds ${count} value(s) that are not membership ids.`,
      id: `audience.inviteeMembershipIds berisi ${idNumber(count)} nilai yang bukan ID anggota.`,
    }),
    scopeTakesNoList: ({ scope }: { scope: string }) => ({
      en: `audience.scope "${scope}" invites everybody it describes, so it takes no invitee list.`,
      id: `audience.scope "${scope}" mengundang semua orang yang dicakupnya, jadi tidak menerima daftar undangan.`,
    }),

    /* ---- the Owner's writes (`event.service.ts`) ---- */
    typeCodeTaken: ({ code }: { code: string }) => ({
      en: `This office already has an event type with the code ${code}.`,
      id: `KPM ini sudah memiliki jenis event dengan kode ${code}.`,
    }),
    eventCodeTaken: ({ code }: { code: string }) => ({
      en: `This office already has an event with the code ${code}.`,
      id: `KPM ini sudah memiliki event dengan kode ${code}.`,
    }),
    notAType: ({ code }: { code: string }) => ({
      en: `${code} is not an event type in this office.`,
      id: `${code} bukan jenis event di KPM ini.`,
    }),
    typeArchived: ({ code }: { code: string }) => ({
      en: `${code} is archived, so no new event may be filed under it. Restore it first.`,
      id: `${code} diarsipkan, jadi tidak ada event baru yang dapat dicatat dengan jenis ini. Pulihkan dulu.`,
    }),
    selectNeedsSomebody: {
      en: 'A "select" audience needs at least one person. Choose everybody instead if that is what you mean.',
      id: 'Audiens "select" memerlukan paling sedikit satu orang. Pilih semua orang jika itu yang Anda maksud.',
    },
    notLeaders: ({ count }: { count: number }) => ({
      en: `${count} of the people you chose lead nobody, so they are not leaders for this purpose. `
        + 'Being an AB or an AAB is a rung; leading is having somebody under you.',
      id: `${idNumber(count)} orang yang Anda pilih tidak memimpin siapa pun, jadi mereka bukan leader untuk keperluan `
        + 'ini. AB atau AAB adalah jenjang; memimpin berarti memiliki seseorang di bawahnya.',
    }),

    /* ---- the member's answer (`event-guest.service.ts`) ---- */
    scoreWhole: ({ min, max }: { min: number; max: number }) => ({
      en: `score must be a whole number from ${min} to ${max}.`,
      id: `score harus berupa bilangan bulat dari ${idNumber(min)} sampai ${idNumber(max)}.`,
    }),

    /* ---- the roll call (`event-roll-call.service.ts`) ---- */
    entriesNotList: {
      en: 'entries must be a list.',
      id: 'entries harus berupa daftar.',
    },
    entriesCount: ({ max }: { max: number }) => ({
      en: `entries must hold 1–${max} people.`,
      id: `entries harus berisi 1–${idNumber(max)} orang.`,
    }),
    entryNotObject: ({ i }: { i: number }) => ({
      en: `entries[${i}] must be an object.`,
      id: `entries[${i}] harus berupa objek.`,
    }),
    entryUnknownField: ({ i, key }: { i: number; key: string }) => ({
      en: `entries[${i}].${key} should not exist`,
      id: `properti entries[${i}].${key} tidak dikenal`,
    }),
    entryAttended: ({ i }: { i: number }) => ({
      en: `entries[${i}].attended must be true, false or null.`,
      id: `entries[${i}].attended harus true, false, atau null.`,
    }),
    entryTwice: ({ i, membershipId }: { i: number; membershipId: string }) => ({
      en: `entries[${i}] names ${membershipId} twice.`,
      id: `entries[${i}] menyebut ${membershipId} dua kali.`,
    }),

    /* ---- a template's event types (`event-types-payload.ts`) ---- */
    typesNotList: {
      en: 'types must be a list.',
      id: 'types harus berupa daftar.',
    },
    typesEmpty: {
      en: 'An event type list with no types gives every new office nothing to file an event under.',
      id: 'Daftar jenis event tanpa satu jenis pun membuat setiap KPM baru tidak punya jenis untuk mencatat event.',
    },
    typeNoCode: ({ n }: { n: number }) => ({
      en: `${typeAt(n).en} has no code. An event stores the code, so a rename never orphans one.`,
      id: `${typeAt(n).id} tidak memiliki kode. Event menyimpan kodenya, jadi mengganti nama tidak pernah membuat `
        + 'event kehilangan jenisnya.',
    }),
    typeCodeTwice: ({ code }: { code: string }) => ({
      en: `The code ${code} is used twice, so one type would wear two labels.`,
      id: `Kode ${code} dipakai dua kali, sehingga satu jenis akan memiliki dua label.`,
    }),
    typeCodeUnusable: ({ n, code }: { n: number; code: string }) => ({
      en: `${typeAt(n).en}: ${code} is not a usable code. Letters, digits and underscores, starting with a letter.`,
      id: `${typeAt(n).id}: ${code} bukan kode yang dapat dipakai. Gunakan huruf, angka, dan garis bawah, diawali huruf.`,
    }),
    typeNoLabel: ({ n }: { n: number }) => ({
      en: `${typeAt(n).en} has no label, so it would render as a blank row on the Events screen.`,
      id: `${typeAt(n).id} tidak memiliki label, sehingga akan tampil sebagai baris kosong di layar Events.`,
    }),
    typeColor: ({ n, color }: { n: number; color: string }) => ({
      en: `${typeAt(n).en}: ${color} is not a colour. Use a six-digit hex value such as #2D9CDB.`,
      id: `${typeAt(n).id}: ${color} bukan warna. Gunakan nilai hex enam digit, misalnya #2D9CDB.`,
    }),
  },
  EVENT_NOT_ATTENDED: {
    feedbackFromAttendees: {
      en: 'Feedback is only collected from people who joined or say they attended this event.',
      id: 'Masukan hanya dikumpulkan dari orang yang ikut atau menyatakan hadir di event ini.',
    },
  },
  EVENT_RSVP_CLOSED: {
    ended: {
      en: 'This event has ended, so its RSVP is closed.',
      id: 'Event ini sudah berakhir, jadi RSVP-nya ditutup.',
    },
  },
  EVENT_NOT_ENDED: {
    notYet: {
      en: 'This event has not ended yet.',
      id: 'Event ini belum berakhir.',
    },
    attendanceAfterEnd: {
      en: 'Attendance is confirmed once the event has ended.',
      id: 'Kehadiran dikonfirmasi setelah event berakhir.',
    },
  },
  EVENT_FEEDBACK_ALREADY_SUBMITTED: {
    already: {
      en: 'You have already given feedback for this event.',
      id: 'Anda sudah memberikan masukan untuk event ini.',
    },
  },
  EVENT_ATTENDANCE_SELF: {
    ownAttendance: {
      en: 'Nobody confirms their own attendance. Another administrator confirms yours.',
      id: 'Tidak ada yang mengonfirmasi kehadirannya sendiri. Administrator lain yang mengonfirmasi kehadiran Anda.',
    },
  },
  EVENT_HAS_RESPONSES: {
    answered: {
      en: 'People have already answered this event, so its start, its audience and an end in the future cannot change. '
        + 'Add a new event instead.',
      id: 'Sudah ada yang menanggapi event ini, jadi waktu mulai, audiens, dan waktu selesai di masa depan tidak dapat '
        + 'diubah. Tambahkan event baru sebagai gantinya.',
    },
  },
});
