import { formatNumber } from '@/common/format/format';
import { messages, refusals } from '@/common/i18n/sentence';

/**
 * **The org module's words, in both languages** (P18.98-T5 AC-2; ADR-0179 §7): the office's members and how they are
 * placed — the hierarchy, removing somebody, changing their role, moving them to another leader, the tree, groups and
 * the Core Leader tag, and who administers the office. Joining an office has its own (`onboarding.messages.ts`), and so
 * does the leader limit (`leader-limit.messages.ts`).
 *
 * The Indonesian follows the approved glossary: the office is ***KPM*** (§B.9), the reader ***Anda***, a person
 * ***dia*** (§B.0); *reports to* is ***melapor ke*** (§B.9), *removed* ***dikeluarkan*** (§B.3), a transfer a
 * ***pemindahan***, a rung a ***jenjang*** and *retired* ***diarsipkan***. *Leader*, *Unit*, *Owner*, *Admin*,
 * *Core Leader* and *AgencyBoost* stay English (§A). A name, a rung's name and a reason somebody typed are written as
 * they were typed.
 */

/** A count in an Indonesian sentence: *1.250*. English keeps the number as it always wrote it. */
const idCount = (n: number): string => formatNumber(n, undefined, 'id');

/** Every state a request or an invite can be decided into, as the API names it in `details.status`. */
export type DecidedStatus = 'pending' | 'approved' | 'declined' | 'cancelled' | 'accepted' | 'expired';

const DECIDED_AS: Readonly<Record<DecidedStatus, string>> = {
  pending: 'menunggu',
  approved: 'disetujui',
  declined: 'ditolak',
  cancelled: 'dibatalkan',
  accepted: 'diterima',
  expired: 'kedaluwarsa',
};

/**
 * **How a request was decided, as a word in an Indonesian sentence** — *That request was already approved* reads
 * *Permintaan itu sudah disetujui*. The English writes the status as the API names it, as it always has; the value
 * itself stays in `details.status` in both. A status this does not know is written as it is.
 */
export function decidedAs(status: DecidedStatus): string {
  return DECIDED_AS[status] ?? status;
}

export const ORG_REFUSALS = refusals('modules/org', {
  TENANT_NO_MEMBERSHIP: {
    notInOffice: {
      en: 'You are not in an office.',
      id: 'Anda belum tergabung di KPM mana pun.',
    },
  },

  /* ------------------------------------------------------------------ the hierarchy */
  ORG_LEADER_NOT_IN_KPM: {
    notAMember: {
      en: 'That leader is not a member of this office.',
      id: 'Leader itu bukan anggota KPM ini.',
    },
  },
  ORG_CYCLE_DETECTED: {
    ownLeader: {
      en: 'That would make this member their own leader.',
      id: 'Itu akan menjadikan anggota ini leader bagi dirinya sendiri.',
    },
  },
  INTERNAL_ERROR: {
    leaderCode: {
      en: 'Could not allocate a leader code.',
      id: 'Kode leader tidak dapat dibuat.',
    },
  },
  ORG_TREE_TOO_LARGE: {
    tooLarge: ({ count }: { count: number }) => ({
      en: `This office has ${count} members, more than the tree can draw.`,
      id: `KPM ini memiliki ${idCount(count)} anggota, lebih banyak dari yang dapat digambar dalam bagan.`,
    }),
  },

  /* ------------------------------------------------------------------ removing somebody */
  ORG_REMOVAL_NOT_CONFIRMED: {
    /** The word is the literal one the body carries, in both languages: the API compares it as typed. */
    typeToConfirm: ({ word }: { word: string }) => ({
      en: `Type ${word} to confirm.`,
      id: `Ketik ${word} untuk mengonfirmasi.`,
    }),
  },
  ORG_ALREADY_REMOVED: {
    alreadyRemoved: {
      en: 'They have already been removed from this office.',
      id: 'Dia sudah dikeluarkan dari KPM ini.',
    },
    nobodyToMove: {
      en: 'They are no longer an active member of the office, so there is nobody to move. The request is closed.',
      id: 'Dia sudah bukan anggota aktif KPM ini, jadi tidak ada yang dapat dipindahkan. Permintaan ini ditutup.',
    },
  },
  ORG_REMOVAL_NOT_PERMITTED: {
    yourself: {
      en: 'You cannot remove yourself from the office.',
      id: 'Anda tidak dapat mengeluarkan diri sendiri dari KPM ini.',
    },
    directLeaderOnly: {
      en: 'Only somebody’s direct leader can remove them.',
      id: 'Hanya leader langsung seseorang yang dapat mengeluarkannya.',
    },
    root: {
      en: 'The office’s root member cannot be removed. Reassign the office first.',
      id: 'Anggota teratas KPM ini tidak dapat dikeluarkan. Alihkan kepemilikan KPM ini terlebih dahulu.',
    },
    owner: {
      en: 'They own this office. Transfer it first — only the platform can do that.',
      id: 'Dia pemilik KPM ini. Alihkan kepemilikannya terlebih dahulu — hanya platform yang dapat melakukannya.',
    },
  },
  ORG_SUBTREE_DISPOSITION_REQUIRED: {
    sayWhere: ({ count }: { count: number }) => ({
      en: `${count} ${count === 1 ? 'person reports' : 'people report'} to them. `
        + 'Say where they go before removing this leader.',
      id: `${idCount(count)} orang melapor kepadanya. Tentukan ke mana mereka dipindahkan sebelum mengeluarkan leader ini.`,
    }),
    notToThem: {
      en: 'Their reports cannot be moved to the person being removed.',
      id: 'Anggota yang melapor kepadanya tidak dapat dipindahkan ke orang yang sedang dikeluarkan.',
    },
  },

  /* ------------------------------------------------------------------ changing somebody's role */
  ORG_ROLE_CHANGE_NOT_PERMITTED: {
    owner: {
      en: 'They own this office. Transfer it first — only the platform can do that.',
      id: 'Dia pemilik KPM ini. Alihkan kepemilikannya terlebih dahulu — hanya platform yang dapat melakukannya.',
    },
    /** `rung`: the senior rung's name as the company's ladder writes it (`shortOfRung`) — *AB*, or its own. */
    officeOnly: ({ rung }: { rung: string }) => ({
      en: `Only the office’s Owner or an Admin can change somebody’s role to or from ${rung}.`,
      id: `Hanya Owner atau Admin KPM yang dapat mengubah peran seseorang menjadi atau dari ${rung}.`,
    }),
    directLeaderOnly: {
      en: 'Only somebody’s direct leader can change their role.',
      id: 'Hanya leader langsung seseorang yang dapat mengubah perannya.',
    },
  },
  ORG_HAS_DIRECT_REPORTS: {
    moveFirst: ({ count }: { count: number }) => ({
      en: `${count} ${count === 1 ? 'person reports' : 'people report'} to them. Move them to another leader first.`,
      id: `${idCount(count)} orang melapor kepadanya. Pindahkan mereka ke leader lain terlebih dahulu.`,
    }),
  },

  /* ------------------------------------------------------------------ moving somebody to another leader */
  ORG_TRANSFER_STALE: {
    movedSince: {
      en: 'They have moved to another leader since this was asked, so it no longer says where they come from. The '
        + 'request is closed; ask again if they should still move.',
      id: 'Dia sudah pindah ke leader lain sejak permintaan ini diajukan, jadi asal yang disebutkannya tidak lagi '
        + 'benar. Permintaan ini ditutup; ajukan lagi jika dia tetap perlu dipindahkan.',
    },
  },
  ORG_TRANSFER_PENDING: {
    waiting: {
      en: 'A transfer request for them is already waiting for the office to decide.',
      id: 'Permintaan pemindahan untuknya sudah menunggu keputusan KPM.',
    },
  },
  ORG_NOT_PERMITTED_TO_TAG: {
    ownerNotAdded: {
      en: 'They own this office. Nobody adds them to a unit.',
      id: 'Dia pemilik KPM ini. Dia tidak dapat ditambahkan ke unit mana pun.',
    },
  },
  ORG_REQUEST_ALREADY_DECIDED: {
    transfer: ({ status }: { status: DecidedStatus }) => ({
      en: `That transfer request was already ${status}.`,
      id: `Permintaan pemindahan itu sudah ${decidedAs(status)}.`,
    }),
  },

  /* ------------------------------------------------------------------ groups and the Core Leader tag */
  ORG_GROUP_NOT_FOUND: {
    notHere: {
      en: 'One of those groups is not in this office, or has been retired.',
      // A group is retired with *Nonaktifkan grup* on the screen (P18.98-T4), so its refusal says *dinonaktifkan*.
      id: 'Salah satu grup itu tidak ada di KPM ini, atau sudah dinonaktifkan.',
    },
  },
  ORG_GROUP_OWNER_NOT_IN_KPM: {
    ownerInOffice: {
      en: 'Give the group an owner who is in this office.',
      id: 'Pilih pemilik grup dari anggota KPM ini.',
    },
  },
  ORG_GROUP_NAME_TAKEN: {
    /** The group's name, as the office typed it. */
    taken: ({ name }: { name: string }) => ({
      en: `This office already has a group called “${name}”.`,
      id: `KPM ini sudah memiliki grup bernama “${name}”.`,
    }),
  },
  CORE_LEADER_NOT_A_LEADER: {
    leadersOnly: {
      en: 'Only a leader can be a Core Leader. Move them to a leader rung first.',
      id: 'Hanya leader yang dapat menjadi Core Leader. Pindahkan dia ke jenjang leader terlebih dahulu.',
    },
  },

  /* ------------------------------------------------------------------ a person's WhatsApp number (M1) */
  MEMBER_PHONE_ON_FILE: {
    onFile: {
      en: 'They already have a WhatsApp number. Only they can change it, on My profile.',
      id: 'Dia sudah memiliki nomor WhatsApp. Hanya dia yang dapat mengubahnya, di Profil saya.',
    },
  },

  /* ------------------------------------------------------------------ who administers the office */
  ORG_ALREADY_ADMIN: {
    alreadyAdmin: {
      en: 'They already administer this office.',
      id: 'Dia sudah mengelola KPM ini.',
    },
  },
  ORG_ADMIN_TARGET_NOT_ACTIVE: {
    notJoinedYet: {
      en: 'They have not joined the office yet.',
      id: 'Dia belum bergabung dengan KPM ini.',
    },
  },
  ORG_NOT_AN_ADMIN: {
    notAdmin: {
      en: 'They do not administer this office.',
      id: 'Dia tidak mengelola KPM ini.',
    },
  },
  PERM_OWNER_ONLY: {
    ownersOwnAccess: {
      en: 'The Owner’s own access cannot be revoked. Transfer the office instead.',
      id: 'Akses Owner sendiri tidak dapat dicabut. Alihkan kepemilikan KPM ini sebagai gantinya.',
    },
  },

  VALIDATION_FAILED: {
    /** Asking AgencyBoost about a role change the leader limit would not stop (ADR-0157 §1). */
    changeDirectly: {
      en: 'That change does not make a new leader, so it needs nobody’s approval. Make it directly.',
      id: 'Perubahan itu tidak menambah leader baru, jadi tidak perlu persetujuan siapa pun. Lakukan langsung.',
    },
    /* The DTOs' own sentences (`field`), each naming its field as the API names it. */
    toRoleShape: {
      en: 'toRole must be a rung code',
      id: 'toRole harus berupa kode jenjang',
    },
    orgLevelCodeShape: {
      en: 'orgLevelCode must be a rung code',
      id: 'orgLevelCode harus berupa kode jenjang',
    },
    /* UI V1 (2026-10-30; UI-081, D-22): an agent's WhatsApp number, set by their leader — `+62` and 9 to 13 digits. */
    phoneShape: {
      en: 'phone must be an Indonesian number: 9 to 13 digits after +62',
      id: 'phone harus nomor Indonesia: 9 sampai 13 digit setelah +62',
    },
  },
});

/**
 * **The org module's other words**: a name the API has none for, and the sentences it **stores** — a history row's
 * reason, a notice's next step — written in the writer's language when they are stored (AC-6), and shown as stored.
 */
export const ORG_MESSAGES = messages('modules/org', {
  /** In place of the name of a person whose account is gone: a row still names somebody, never a blank. */
  unknownName: { en: 'Unknown', id: 'Tidak diketahui' },
  /** The reason on the `re_parented` edge of each report a removed leader leaves, with the remover's own reason. */
  leaderRemoved: ({ reason }: { reason: string | null }) => ({
    en: `Leader removed from the office${reason ? `: ${reason}` : ''}`,
    id: `Leader dikeluarkan dari KPM${reason ? `: ${reason}` : ''}`,
  }),
  /** The reason on the `re_parented` edge a transfer's approval opens. */
  transferApproved: { en: 'Transfer request approved', id: 'Permintaan pemindahan disetujui' },
  /** What a removed member's notice tells them to do next — the prototype's own copy. */
  removedNextStep: {
    en: 'Search for a leader and request to join again if you want to come back.',
    id: 'Cari leader dan minta bergabung lagi jika Anda ingin kembali.',
  },
});
