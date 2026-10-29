import { formatNumber } from '@/common/format/format';
import { readerIn } from '@/common/i18n/reader';
import { messages, refusals, render, type Sentence } from '@/common/i18n/sentence';
import { decidedAs, type DecidedStatus } from './org.messages';

/**
 * **The leader limit, in both languages** (P18.98-T5 AC-2; ADR-0113, ADR-0157): the refusal at the limit, the lease
 * that makes two leader writes take turns, and a request for AgencyBoost to approve one leader past it — asked, decided
 * and, when it no longer applies, closed with what changed.
 *
 * *Leader*, *AB*, *AAB*, *Owner*, *Admin* and *AgencyBoost* stay English (glossary §A), and a kept-English noun keeps its
 * English plural (§B.0 rule 8: *1 leader · 5 leaders*). A rung is a ***jenjang*** and the ladder the ***susunan
 * jenjang***; a rung's code is written as the company wrote it.
 */

/** *5 leaders*, *1 leader*: a kept-English noun keeps its English plural, the count written the Indonesian way. */
const leaders = (n: number): string => `${formatNumber(n, undefined, 'id')} ${n === 1 ? 'leader' : 'leaders'}`;

const AT_THE_LIMIT_ID = (maxLeaders: number) =>
  `KPM ini sudah mencapai batas ${leaders(maxLeaders)} — AB dan AAB dihitung bersama, termasuk Owner.`;

/**
 * **Why an approved request no longer applies** (ADR-0157 §3) — said inside its refusal, kept in its `details.why`,
 * and closed into its decline reason. In words the asker reads; filed under no code, because none is a refusal alone.
 */
export const STALE_REASONS = messages('modules/org: leader limit, why', {
  leaderGone: {
    en: 'The leader they were to join is no longer an active member.',
    id: 'Leader tempat dia akan bergabung sudah bukan anggota aktif.',
  },
  joinRequestDecided: {
    en: 'Their request to join was decided or withdrawn since.',
    id: 'Permintaan bergabungnya sudah diputuskan atau ditarik sejak itu.',
  },
  placedSince: {
    en: 'They were placed in a unit since.',
    id: 'Dia sudah ditempatkan di sebuah unit sejak itu.',
  },
  changedWhileDeciding: {
    en: 'It changed while it was being decided.',
    id: 'Permintaan ini berubah saat sedang diputuskan.',
  },
  askerGone: {
    en: 'Whoever asked is no longer an active member of the office.',
    id: 'Orang yang mengajukannya sudah bukan anggota aktif KPM ini.',
  },
  notRoutedToAsker: {
    en: 'It was not routed to whoever asked.',
    id: 'Permintaan ini tidak diarahkan ke orang yang mengajukannya.',
  },
  noLongerReportsToAsker: {
    en: 'They no longer report to whoever asked.',
    id: 'Dia sudah tidak melapor ke orang yang mengajukannya.',
  },
  abNeedsTheOffice: {
    en: 'Only the Owner or an Admin may make somebody an AB.',
    id: 'Hanya Owner atau Admin yang dapat menjadikan seseorang AB.',
  },
  rungOffTheLadder: ({ code }: { code: string }) => ({
    en: `The rung ${code} is no longer on the ladder.`,
    id: `Jenjang ${code} sudah tidak ada di susunan jenjang.`,
  }),
  rungNoLongerLeads: ({ code }: { code: string }) => ({
    en: `The rung ${code} no longer leads.`,
    id: `Jenjang ${code} sudah bukan jenjang leader.`,
  }),
  memberGone: {
    en: 'They are no longer a member of the office.',
    id: 'Dia sudah bukan anggota KPM ini.',
  },
  movedRung: {
    en: 'They have moved rung since it was asked.',
    id: 'Dia sudah pindah jenjang sejak permintaan ini diajukan.',
  },
  letInSince: {
    en: 'They were let in since it was asked.',
    id: 'Dia sudah diterima bergabung sejak permintaan ini diajukan.',
  },
  /** A stale refusal that named nothing. */
  noLongerApplies: {
    en: 'It no longer applies.',
    id: 'Permintaan ini sudah tidak berlaku.',
  },
});

/** A reason a stale request is closed with — one of `STALE_REASONS`. */
export type StaleReason = Sentence<null>;

export const LEADER_LIMIT_REFUSALS = refusals('modules/org: leader limit', {
  LEADER_LIMIT_REACHED: {
    /** `canRequest`: the reader may ask AgencyBoost to approve this one instead (ADR-0157 §1). */
    askAgencyBoost: ({ maxLeaders }: { maxLeaders: number }) => ({
      en: `This office has reached its limit of ${maxLeaders} leaders — ABs and AABs together, the Owner `
        + 'included. Ask AgencyBoost to approve this one past the limit, or to raise it.',
      id: `${AT_THE_LIMIT_ID(maxLeaders)} Minta AgencyBoost menyetujui yang satu ini melebihi batas, atau menaikkan `
        + 'batasnya.',
    }),
    untilRaised: ({ maxLeaders }: { maxLeaders: number }) => ({
      en: `This office has reached its limit of ${maxLeaders} leaders — ABs and AABs together, the Owner `
        + 'included. Nobody else can be made a leader until AgencyBoost raises it.',
      id: `${AT_THE_LIMIT_ID(maxLeaders)} Tidak ada lagi yang dapat dijadikan leader sampai AgencyBoost menaikkan `
        + 'batasnya.',
    }),
  },
  LEADER_LIMIT_REQUEST_STALE: {
    /** `why`: what changed, one of `STALE_REASONS`, written in the same language as the sentence around it. */
    noLongerApplies: ({ why }: { why: StaleReason }) => ({
      en: (figures) => `This request no longer applies: ${render(why, { language: 'en', figures })} It has been `
        + 'closed, and nothing was changed.',
      id: `Permintaan ini sudah tidak berlaku: ${render(why, readerIn('id'))} Permintaan ini ditutup, dan tidak ada `
        + 'yang diubah.',
    }),
  },
  LEADER_LIMIT_REQUEST_OPEN: {
    alreadyDeciding: {
      en: 'AgencyBoost is already deciding a request about them. Wait for it, or cancel it first.',
      id: 'AgencyBoost sedang memutuskan permintaan tentang dia. Tunggu keputusannya, atau batalkan dulu.',
    },
  },
  LEADER_LIMIT_REQUEST_DECIDED: {
    already: ({ status }: { status: DecidedStatus }) => ({
      en: `That request was already ${status}.`,
      id: `Permintaan itu sudah ${decidedAs(status)}.`,
    }),
  },
  VERSION_CONFLICT: {
    leadersBusy: {
      en: 'Somebody else is changing this office’s leaders at this moment. Try again.',
      id: 'Orang lain sedang mengubah leader KPM ini. Coba lagi.',
    },
  },
  INTERNAL_ERROR: {
    noOffice: {
      en: 'The leader limit was asked about a write with no office in its context.',
      id: 'Batas leader diperiksa untuk perubahan yang tidak memiliki KPM.',
    },
  },
  PERM_DENIED: {
    agencyBoostDecides: {
      en: 'Only AgencyBoost decides these.',
      id: 'Hanya AgencyBoost yang memutuskan permintaan ini.',
    },
  },
  VALIDATION_FAILED: {
    nameTheRung: {
      en: 'Name the rung they are to be given.',
      id: 'Sebutkan jenjang yang akan diberikan kepadanya.',
    },
    sayWhy: {
      en: 'Say why. The office reads it, and a refusal with nothing to act on is not an answer.',
      id: 'Jelaskan alasannya. KPM akan membacanya, dan penolakan tanpa hal yang dapat ditindaklanjuti bukanlah jawaban.',
    },
  },
});

/**
 * **The decline reason a stale request is closed with** — stored, so written in the deciding Super Admin's language
 * (AC-6) and shown as stored: on the office's list and in the asker's notice.
 */
export const LEADER_LIMIT_MESSAGES = messages('modules/org: leader limit', {
  closedAsStale: ({ why }: { why: StaleReason }) => ({
    en: (figures) => `No longer applies: ${render(why, { language: 'en', figures })}`,
    id: `Sudah tidak berlaku: ${render(why, readerIn('id'))}`,
  }),
});
