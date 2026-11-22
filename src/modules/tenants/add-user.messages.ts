import { refusals } from '@/common/i18n/sentence';

/**
 * ***Tambah user* and *Masukkan*, refused** (P19.28-T1; ADR-0286): written for the person at the sheet — the Super
 * Admin, or an Owner or a KPM Admin in their own KPM — and for the person who opens the invitation link. An office is a
 * *KPM* (§B.9); *Owner* is kept (§A.5). Another KPM is never named to anybody but the Super Admin.
 */
export const ADD_USER_REFUSALS = refusals('modules/tenants: add user', {
  VALIDATION_FAILED: {
    kpmNeeded: {
      en: 'Choose the KPM this person joins.',
      id: 'Pilih KPM untuk orang ini.',
    },
    roleNeeded: {
      en: 'Choose their role.',
      id: 'Pilih perannya.',
    },
    kpmOrNewKpm: {
      en: 'Choose a KPM, or make a new one — not both.',
      id: 'Pilih KPM, atau buat KPM baru — tidak keduanya.',
    },
    leaderNeeded: {
      en: 'Choose their leader: an AB or an AAB of this KPM.',
      id: 'Pilih leader-nya: AB atau AAB dari KPM ini.',
    },
    noLeaderForSenior: ({ rung }: { rung: string }) => ({
      en: `${rung} has no leader. Leave the leader empty.`,
      id: `${rung} tidak punya leader. Kosongkan leader-nya.`,
    }),
    phone: {
      en: 'Enter a WhatsApp number of 9 to 13 digits after +62.',
      id: 'Isi nomor WhatsApp 9 sampai 13 digit setelah +62.',
    },
  },
  PERM_DENIED: {
    newKpmIsPlatforms: {
      en: 'Only AgencyBoost makes a new KPM. Choose this KPM instead.',
      id: 'Hanya AgencyBoost yang dapat membuat KPM baru. Pilih KPM ini.',
    },
    ownerIsOwners: {
      en: 'Only an owner of this KPM, or AgencyBoost, makes somebody an owner. Leave “Jadikan KPM Owner” off.',
      id: 'Hanya owner KPM ini, atau AgencyBoost, yang dapat menjadikan seseorang owner. Matikan “Jadikan KPM Owner”.',
    },
  },
  ORG_AGENT_ALREADY_TAGGED: {
    memberHere: ({ name }: { name: string }) => ({
      en: `${name} is already a member of this KPM.`,
      id: `${name} sudah menjadi anggota KPM ini.`,
    }),
    memberElsewhere: {
      en: 'This WhatsApp number or email belongs to somebody who is already a member of another KPM.',
      id: 'Nomor WhatsApp atau email ini milik orang yang sudah menjadi anggota KPM lain.',
    },
    memberElsewhereNamed: ({ name, kpm }: { name: string; kpm: string }) => ({
      en: `${name} is already a member of ${kpm}. Move them from inside that KPM.`,
      id: `${name} sudah menjadi anggota ${kpm}. Pindahkan dari dalam KPM itu.`,
    }),
    alreadyPlaced: {
      en: 'You are already a member of a KPM, so this invitation cannot place you.',
      id: 'Anda sudah menjadi anggota sebuah KPM, jadi undangan ini tidak dapat menempatkan Anda.',
    },
    notThisPerson: {
      en: 'This account is the AgencyBoost team’s, and joins no KPM.',
      id: 'Akun ini milik tim AgencyBoost dan tidak bergabung ke KPM mana pun.',
    },
  },
  ORG_INVITE_PENDING: {
    numberWaiting: {
      en: 'This WhatsApp number already has an invitation to this KPM waiting. Send that one again, or cancel it first.',
      id: 'Nomor WhatsApp ini sudah punya undangan ke KPM ini yang menunggu. Kirim ulang undangan itu, atau batalkan '
        + 'dulu.',
    },
  },
  TENANT_COMPANY_MISMATCH: {
    otherCompany: ({ name, userCompany, kpmCompany }: { name: string; userCompany: string; kpmCompany: string }) => ({
      en: `${name} signed up with ${userCompany}, and this KPM is ${kpmCompany}'s. Choose a ${userCompany} KPM.`,
      id: `${name} mendaftar di ${userCompany}, sedangkan KPM ini milik ${kpmCompany}. Pilih KPM ${userCompany}.`,
    }),
    noAgentCode: ({ name }: { name: string }) => ({
      en: `${name}'s account has no agent code yet, so it cannot join a KPM. They add it on their profile first.`,
      id: `Akun ${name} belum punya kode agen, jadi belum bisa bergabung ke KPM. Isi dulu di profilnya.`,
    }),
    acceptOtherCompany: ({ company }: { company: string }) => ({
      en: `This invitation is to a ${company} KPM, and your account is of another company or has no agent code.`,
      id: `Undangan ini ke KPM ${company}, sedangkan akun Anda milik perusahaan lain atau belum punya kode agen.`,
    }),
  },
  ORG_REQUEST_ALREADY_DECIDED: {
    accepted: {
      en: 'This invitation was accepted already.',
      id: 'Undangan ini sudah diterima.',
    },
    cancelled: {
      en: 'This invitation was cancelled already.',
      id: 'Undangan ini sudah dibatalkan.',
    },
  },
  NOT_FOUND: {
    linkNotValid: {
      en: 'This invitation link is not valid. Check you opened the whole link, or ask for a new one.',
      id: 'Tautan undangan ini tidak valid. Pastikan Anda membuka seluruh tautannya, atau minta tautan baru.',
    },
    used: {
      en: 'This invitation was already used. Sign in to open your KPM.',
      id: 'Undangan ini sudah dipakai. Silakan masuk untuk membuka KPM Anda.',
    },
    cancelled: {
      en: 'This invitation was cancelled. Ask whoever invited you for a new one.',
      id: 'Undangan ini sudah dibatalkan. Minta undangan baru kepada yang mengundang Anda.',
    },
    expired: {
      en: 'This invitation has expired. Ask whoever invited you to send it again.',
      id: 'Undangan ini sudah kedaluwarsa. Minta yang mengundang Anda untuk mengirimkannya lagi.',
    },
    forSomebodyElse: {
      en: 'This invitation is for another account. Sign in with the account it was sent to.',
      id: 'Undangan ini untuk akun lain. Masuk dengan akun yang diundang.',
    },
  },
  AUTH_RATE_LIMITED: {
    tooMany: ({ minutes }: { minutes: number }) => ({
      en: `Too many attempts. Try again in ${minutes} minute(s).`,
      id: `Terlalu banyak percobaan. Coba lagi dalam ${minutes} menit.`,
    }),
  },
});

