import { formatDate } from '@/common/format/format';
import { messages, refusals } from '@/common/i18n/sentence';

/**
 * **The coaching module's refusals, in both languages** (P18.98-T5 AC-2, AC-3): a session written, finalized,
 * reopened and printed, a 1:1 logged after it was held, and a coachee's capability ticks. *Coaching*, *1:1*, *AB*,
 * *AAB* and *Leader* stay English (glossary §A), and so do the session's own *action item* and *coaching tip*; a
 * session is a *sesi coaching*, finalized *difinalkan*, reopened *dibuka kembali* (the API's vocabulary).
 *
 * **ADR-0084 rule 2 holds in both languages**: a string coaching writes itself names none of the six words —
 * *office*, *KPM*, *reports to*, *tagged to*, *untagged*, *unassigned* — nor their Indonesian, *KPM*, *melapor ke*,
 * *di-tag ke*, *tanpa tim* (`coaching-copy.spec.ts` reads every sentence here).
 */
export const COACHING_REFUSALS = refusals('modules/coaching', {
  COACHING_SESSION_FINALIZED: {
    locked: {
      en: 'This session is finalized and locked to view-only. Reopen it to change what was agreed.',
      id: 'Sesi ini sudah difinalkan dan dikunci hanya untuk dilihat. Buka kembali untuk mengubah hal yang disepakati.',
    },
  },
  /** The prototype's five finalize checks (`Overall.html:11111-11117`), by the rule `details.rule` names. */
  COACHING_SESSION_INCOMPLETE: {
    noActionItem: {
      en: 'Add at least one action item before finalizing.',
      id: 'Tambahkan paling tidak satu action item sebelum memfinalkan.',
    },
    emptyTip: {
      en: 'Fill in or remove the empty coaching tip before finalizing.',
      id: 'Isi atau hapus coaching tip yang kosong sebelum memfinalkan.',
    },
    emptyActionItem: {
      en: 'Fill in or remove the empty action item before finalizing.',
      id: 'Isi atau hapus action item yang kosong sebelum memfinalkan.',
    },
    undatedActionItem: {
      en: 'Every action item needs a date before finalizing.',
      id: 'Setiap action item harus diberi tanggal sebelum memfinalkan.',
    },
    /** A lead's month tag, not a leader edge: *tagged "this month"* is the prototype's, and no one of the six. */
    leadThisMonthUndated: ({ leadName }: { leadName: string }) => ({
      en: `${leadName} is tagged "this month" but has no next action date set — add one before finalizing.`,
      id: `${leadName} di-tag "bulan ini" tetapi belum memiliki tanggal tindakan berikutnya — tambahkan sebelum `
        + 'memfinalkan.',
    }),
  },
  COACHING_SESSION_NOT_FINALIZED: {
    printFinalizedOnly: {
      en: 'Only a finalized session can be printed. Finalize it first.',
      id: 'Hanya sesi yang sudah difinalkan yang dapat dicetak. Finalkan dulu.',
    },
    reopenFinalizedOnly: {
      en: 'Only a finalized session can be reopened.',
      id: 'Hanya sesi yang sudah difinalkan yang dapat dibuka kembali.',
    },
  },
  COACHING_REOPEN_WINDOW_CLOSED: {
    windowEnded: ({ until, days }: { until: string; days: number }) => ({
      en: (figures) => `This session could be reopened until ${formatDate(until, figures)}, ${days} days after it was held.`,
      id: `Sesi ini hanya dapat dibuka kembali sampai ${formatDate(until, 'id')}, ${days} hari setelah diadakan.`,
    }),
  },
  COACHING_REOPEN_COACH_NOT_CURRENT: {
    coachMovedOn: {
      en: 'Only the session’s coach can finalize a correction, and they no longer coach this person.',
      id: 'Hanya coach sesi ini yang dapat memfinalkan koreksi, dan dia sudah tidak lagi menjadi coach orang ini.',
    },
  },
  PERM_DENIED: {
    logOneOnOne: {
      en: 'A 1:1 is logged by a leader who runs coaching sessions: an AB or an AAB.',
      id: '1:1 dicatat oleh leader yang menjalankan sesi coaching: AB atau AAB.',
    },
  },
  CONFIG_ARCHIVED: {
    /** Shown in the Leader Notes tab's banner as written (ADR-0084 rule 2; parity L-66). */
    itemRetired: {
      en: 'This item has been retired. A profile that already had it keeps it; nobody ticks it anew.',
      id: 'Item ini sudah diarsipkan. Profil yang sudah memilikinya tetap menyimpannya; profil lain tidak dapat '
        + 'mencentangnya.',
    },
  },
  VALIDATION_FAILED: {
    unknownTick: {
      en: 'Every tick must name a milestone or a skill item in the capability catalog.',
      id: 'Setiap centang harus menyebut milestone atau item skill yang ada di katalog capability.',
    },
    logDate: {
      en: 'The day the 1:1 was held is a date, written YYYY-MM-DD, and no later than today.',
      id: 'Tanggal 1:1 diadakan ditulis dengan format YYYY-MM-DD, dan tidak boleh setelah hari ini.',
    },
    logNote: ({ max }: { max: number }) => ({
      en: `The note is 1 to ${max} characters once trimmed.`,
      id: `Catatan harus 1 sampai ${max} karakter, tanpa spasi di awal dan akhir.`,
    }),
    notADate: ({ value }: { value: string }) => ({
      en: `${value} is not a date. Dates are written YYYY-MM-DD.`,
      id: `${value} bukan tanggal. Tanggal ditulis dengan format YYYY-MM-DD.`,
    }),
    lastWeekItemUnknown: {
      en: 'One of last week’s items is not on this session.',
      id: 'Salah satu item minggu lalu tidak ada di sesi ini.',
    },
    rowIdUnknown: ({ field }: { field: string }) => ({
      en: `An id in ${field} is not on this session, or is sent twice.`,
      id: `Ada id di ${field} yang tidak ada di sesi ini, atau dikirim dua kali.`,
    }),
    /* The DTOs' own sentences (`field`, `coaching-session.dto.ts`). */
    dateShape: {
      en: 'A date is written YYYY-MM-DD.',
      id: 'Tanggal ditulis dengan format YYYY-MM-DD.',
    },
    reasonBlank: {
      en: 'reason must not be blank',
      id: 'reason tidak boleh kosong',
    },
  },
});

/**
 * **The words a session writes into its answers** (P18.98-T5 AC-4, AC-6): *From leads (automatic)*'s line for a dated
 * lead with no note — the prototype's *Follow up with {name}* (`Overall.html:11057`). Live in an open session, in the
 * reader's language; **stored at finalize**, in the language of the leader finalizing, and shown as stored. The name
 * is the lead's own, shown as typed; *Follow up* stays English (glossary §A.6).
 */
export const COACHING_MESSAGES = messages('modules/coaching', {
  followUpWith: ({ name }: { name: string }) => ({
    en: `Follow up with ${name}`,
    id: `Follow up dengan ${name}`,
  }),
});
