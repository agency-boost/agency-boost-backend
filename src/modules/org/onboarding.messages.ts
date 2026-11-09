import { messages, refusals } from '@/common/i18n/sentence';
import { decidedAs, type DecidedStatus } from './org.messages';

/**
 * **Joining an office, in both languages** (P18.10-T5 AC-2; ADR-0179 §7): registering to one and asking a leader
 * (`OnboardingService`), a leader's code (`LeaderCodeService`), deciding who gets in and tagging somebody untagged
 * (`ApprovalsService`), and *+ Add agent* with the invites it makes (`InvitesService`) — the routes under `/join`,
 * `/new-hires` and `/invites`.
 *
 * The glossary's words: an invite is an ***undangan***, a link a ***tautan*** (§B.0), the agent code a ***kode agen***
 * (§A.6), *tagged to* ***di-tag ke*** and *reports to* ***melapor ke*** (§B.9); *Leader*, *Unit* and *KPM* stay
 * English (§A). A code and a name are written as they were typed.
 */
export const ONBOARDING_REFUSALS = refusals('modules/org: joining', {
  TENANT_NO_MEMBERSHIP: {
    registerBeforeLooking: {
      en: 'Register an office before looking for a leader.',
      id: 'Daftar ke sebuah KPM sebelum mencari leader.',
    },
    registerBeforeAsking: {
      en: 'Register an office before asking for a leader.',
      id: 'Daftar ke sebuah KPM sebelum meminta leader.',
    },
    noRequestToWithdraw: {
      en: 'You have no request to withdraw.',
      id: 'Anda tidak memiliki permintaan untuk ditarik.',
    },
  },
  ORG_AGENT_ALREADY_TAGGED: {
    alreadyRegistered: {
      en: 'You are already registered to an office.',
      id: 'Anda sudah terdaftar di sebuah KPM.',
    },
    /** P19.10-T1 AC-4: waiting in one office, with a leader's code into another. */
    waitingElsewhere: {
      en: 'You are waiting to join another office. This code is for a different one, so it cannot place you.',
      id: 'Anda sedang menunggu bergabung di KPM lain. Kode ini untuk KPM yang berbeda, jadi tidak dapat menempatkan Anda.',
    },
    youReport: {
      en: 'You already report to somebody. Moving to another leader is not something you can ask for here.',
      id: 'Anda sudah melapor ke seseorang. Pindah ke leader lain tidak dapat Anda minta di sini.',
    },
    reportsToSomebody: {
      en: 'They already report to somebody. Moving them is a different operation.',
      id: 'Dia sudah melapor ke seseorang. Memindahkannya adalah proses yang berbeda.',
    },
    /** `who`: the account's name, as the person wrote it. */
    reportsHere: ({ who }: { who: string }) => ({
      en: `${who} already reports to this leader.`,
      id: `${who} sudah melapor ke leader ini.`,
    }),
    theyReportHere: {
      en: 'They already report to this leader.',
      id: 'Dia sudah melapor ke leader ini.',
    },
    inAnotherOffice: {
      en: 'You already belong to an office, so this invite cannot add you. Ask whoever runs your office to move you.',
      id: 'Anda sudah tergabung di sebuah KPM, jadi undangan ini tidak dapat menambahkan Anda. Minta pengelola KPM '
        + 'Anda untuk memindahkan Anda.',
    },
    inThisOffice: {
      en: 'You already belong to this office, so this invite cannot add you again.',
      id: 'Anda sudah tergabung di KPM ini, jadi undangan ini tidak dapat menambahkan Anda lagi.',
    },
  },
  ORG_CYCLE_DETECTED: {
    askYourself: {
      en: 'You cannot ask to report to yourself.',
      id: 'Anda tidak dapat meminta untuk melapor ke diri sendiri.',
    },
    theyReportToYou: {
      en: 'They report to you, so they cannot be your leader. Ask somebody outside your unit.',
      id: 'Dia melapor ke Anda, jadi dia tidak dapat menjadi leader Anda. Minta seseorang di luar unit Anda.',
    },
    addYourself: {
      en: 'You cannot add yourself to your own unit.',
      id: 'Anda tidak dapat menambahkan diri sendiri ke unit Anda.',
    },
    ownCode: {
      en: 'That is your own agent code. Nobody joins their own unit.',
      id: 'Itu kode agen Anda sendiri. Tidak ada yang bergabung ke unitnya sendiri.',
    },
  },
  ORG_LEADER_NOT_IN_KPM: {
    notAvailable: {
      en: 'That leader is not available in this office.',
      id: 'Leader itu tidak tersedia di KPM ini.',
    },
    notYourUnit: {
      en: 'That is not one of your own units.',
      id: 'Itu bukan salah satu unit Anda sendiri.',
    },
    notActive: {
      en: 'That leader is not an active member of this office.',
      id: 'Leader itu bukan anggota aktif KPM ini.',
    },
    inviterLeft: {
      en: 'The leader who invited you is no longer in the office. Ask the office for a new invite.',
      id: 'Leader yang mengundang Anda sudah tidak ada di KPM ini. Minta undangan baru kepada KPM.',
    },
  },
  ORG_NOT_PERMITTED_TO_TAG: {
    leadsTheOffice: {
      en: 'They lead the office. Nobody tags them into a unit.',
      id: 'Dia memimpin KPM ini. Dia tidak dapat di-tag ke unit mana pun.',
    },
    leadsOwnUnit: {
      en: 'They lead a unit of their own. Only the office can place them.',
      id: 'Dia memimpin unitnya sendiri. Hanya KPM yang dapat menempatkannya.',
    },
  },
  ORG_REQUEST_ALREADY_DECIDED: {
    /** A join request decided by somebody else first: which way it went. */
    request: ({ status }: { status: DecidedStatus }) => ({
      en: `That request was already ${status}.`,
      id: `Permintaan itu sudah ${decidedAs(status)}.`,
    }),
    invite: ({ status }: { status: DecidedStatus }) => ({
      en: `That invite was already ${status}.`,
      id: `Undangan itu sudah ${decidedAs(status)}.`,
    }),
  },
  PERM_DENIED: {
    routeElsewhere: {
      en: 'You cannot send this request into somebody else’s unit.',
      id: 'Anda tidak dapat mengirim permintaan ini ke unit orang lain.',
    },
  },
  VALIDATION_FAILED: {
    letInDirectly: {
      en: 'Letting them in does not make a new leader, so it needs nobody’s approval. Do it directly.',
      id: 'Menerima dia bergabung tidak menambah leader baru, jadi tidak perlu persetujuan siapa pun. Lakukan langsung.',
    },
    /* *+ Add agent*'s own sentences (`field`), each naming its field as the API names it. */
    agentCodeShape: {
      en: 'agentCode must be digits only, 3 to 32 of them',
      id: 'agentCode hanya boleh berisi angka, 3 sampai 32 digit',
    },
    /** P19.5-T2 (ADR-0214 §7): inside a KPM on a template, a new code follows the template's format. */
    agentCodeNotTemplate: ({ example }: { example: string }) => ({
      en: `agentCode is not in the agent code format of this KPM's template — for example ${example}`,
      id: `agentCode tidak sesuai format kode agen di template KPM ini — contohnya ${example}`,
    }),
    /** A code at most this long, whatever the format: the shape the form checks before the template's format. */
    agentCodeTooLong: {
      en: 'agentCode must be 1 to 64 characters',
      id: 'agentCode harus 1 sampai 64 karakter',
    },
    fullNameEmpty: {
      en: 'fullName must not be empty',
      id: 'fullName tidak boleh kosong',
    },
    phoneShape: {
      en: 'phone must be a phone number: digits, spaces or dashes, with a + in front at most',
      id: 'phone harus berupa nomor telepon: angka, spasi, atau tanda hubung, dengan paling banyak satu + di depan',
    },
    joinDateShape: {
      en: 'joinDate must be a date, YYYY-MM-DD',
      id: 'joinDate harus berupa tanggal, YYYY-MM-DD',
    },
  },
  AGENT_CODE_TAKEN: {
    heldElsewhere: ({ agentCode }: { agentCode: string }) => ({
      en: `Agent code ${agentCode} is already registered to somebody else. Ask your office to sort it out.`,
      id: `Kode agen ${agentCode} sudah terdaftar atas nama orang lain. Minta KPM Anda menyelesaikannya.`,
    }),
  },
  ORG_INVITE_PENDING: {
    waiting: ({ agentCode }: { agentCode: string }) => ({
      en: `Agent code ${agentCode} already has an invite waiting to be accepted. Resend that one, or cancel it first.`,
      id: `Kode agen ${agentCode} sudah memiliki undangan yang menunggu diterima. Kirim ulang undangan itu, atau `
        + 'batalkan dulu.',
    }),
  },
  /** An invite's link that opens nothing — each saying plainly why (`InvitesService.open`). */
  NOT_FOUND: {
    linkNotValid: {
      en: 'This invite link is not valid. Check you opened the whole link, or ask whoever sent it for a new one.',
      id: 'Tautan undangan ini tidak valid. Pastikan Anda membuka seluruh tautannya, atau minta tautan baru kepada '
        + 'pengirimnya.',
    },
    alreadyUsed: {
      en: 'This invite was already used. Sign in instead.',
      id: 'Undangan ini sudah dipakai. Silakan masuk.',
    },
    expired: {
      en: 'This invite has expired. Ask whoever sent it to send it again.',
      id: 'Undangan ini sudah kedaluwarsa. Minta pengirimnya mengirimkannya lagi.',
    },
  },
  /** A leader's code that opens nothing: unknown and left-behind alike, so a prober learns nothing. */
  ORG_INVITE_EXPIRED: {
    codeNotValid: {
      en: 'That code is not valid. It may be mistyped, or the person who gave it to you may '
        + 'have left — ask them to check it.',
      id: 'Kode itu tidak valid. Mungkin salah ketik, atau orang yang memberikannya kepada Anda sudah keluar — minta '
        + 'dia memeriksanya.',
    },
  },
  AUTH_RATE_LIMITED: {
    tooMany: ({ minutes }: { minutes: number }) => ({
      en: `Too many attempts. Try again in ${minutes} minute(s).`,
      id: `Terlalu banyak percobaan. Coba lagi dalam ${minutes} menit.`,
    }),
    tooManyCodes: ({ minutes }: { minutes: number }) => ({
      en: `Too many code attempts. Try again in ${minutes} minute(s).`,
      id: `Terlalu banyak percobaan kode. Coba lagi dalam ${minutes} menit.`,
    }),
  },
});

/** **The words joining puts in a response** where it has no name to give: the leader's, when their account is gone. */
export const ONBOARDING_MESSAGES = messages('modules/org: joining', {
  /** A leader's code previewed: whose unit it is. */
  aLeader: { en: 'a leader', id: 'seorang leader' },
  /** Who they joined, on the invite's banner and when they are in. */
  yourLeader: { en: 'your leader', id: 'leader Anda' },
});
