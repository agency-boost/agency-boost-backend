import { messages, refusals } from '@/common/i18n/sentence';

/**
 * **What the inbox says, in both languages** (P18.98-T5 AC-4; ADR-0179 §7): each template's title and detail, composed
 * when the inbox is read, in the reader's language — so a notice stored before the phase reads in the new language
 * too. A name in a notice, and a reason somebody typed, are the payload's, shown as typed; the fallbacks for a payload
 * that holds none are ours, and translated. The words name the screens a notice sends somebody to as the screens name
 * them: a kept-English place (*New hires*, *All Members*, *Pending*, *Goal settings*) stays English (glossary §A).
 */
export const NOTICE_MESSAGES = messages('modules/notifications: notices', {
  somebody: { en: 'Somebody', id: 'Seseorang' },
  aLeader: { en: 'A leader', id: 'Seorang leader' },
  aMember: { en: 'a member', id: 'seorang anggota' },
  anotherLeader: { en: 'another leader', id: 'leader lain' },
  aNewLeader: { en: 'a new leader', id: 'leader baru' },
  yourLeader: { en: 'Your leader', id: 'Leader Anda' },
  anEvent: { en: 'An event', id: 'Sebuah event' },

  joinRequestReceived: ({ asker }: { asker: string }) => ({
    en: `${asker} asked to join your unit`,
    id: `${asker} meminta bergabung ke unit Anda`,
  }),
  joinRequestReceivedDetail: {
    en: 'Approve or decline it under Review requests on New hires.',
    id: 'Setujui atau tolak lewat Tinjau permintaan di New hires.',
  },
  joinRequestApproved: { en: 'You are in', id: 'Anda sudah bergabung' },
  joinRequestApprovedDetail: {
    en: 'Your request was approved. You now have a leader.',
    id: 'Permintaan Anda disetujui. Sekarang Anda memiliki leader.',
  },
  joinRequestDeclined: { en: 'Your request was declined', id: 'Permintaan Anda ditolak' },
  joinRequestDeclinedDetail: {
    en: 'You can search for another leader and ask again.',
    id: 'Anda dapat mencari leader lain dan mengajukan permintaan lagi.',
  },
  joinedWithLeaderCode: ({ joiner }: { joiner: string }) => ({
    en: `${joiner} joined your unit with your leader code`,
    id: `${joiner} bergabung ke unit Anda dengan kode leader Anda`,
  }),
  joinedWithLeaderCodeDetail: {
    en: 'A leader code needs no approval, so they are in your unit already.',
    id: 'Kode leader tidak memerlukan persetujuan, jadi dia sudah ada di unit Anda.',
  },
  taggedByLeader: { en: 'A leader added you to their unit', id: 'Seorang leader menambahkan Anda ke unitnya' },
  taggedByLeaderDetail: {
    en: 'You did not have to ask — they picked you up from the unassigned list.',
    id: 'Anda tidak perlu meminta — dia memilih Anda dari daftar anggota tanpa tim.',
  },
  inviteAccepted: ({ joiner }: { joiner: string }) => ({
    en: `${joiner} accepted your invite and joined your unit`,
    id: `${joiner} menerima undangan Anda dan bergabung ke unit Anda`,
  }),
  inviteAcceptedDetail: {
    en: 'They are in your unit now, with the join date you gave.',
    id: 'Dia sudah ada di unit Anda, dengan tanggal bergabung yang Anda berikan.',
  },
  transferRequested: ({ requester, member }: { requester: string; member: string }) => ({
    en: `${requester} asked to move ${member} into their unit`,
    id: `${requester} meminta ${member} dipindahkan ke unitnya`,
  }),
  transferRequestedDetail: {
    en: 'Approve or decline it on All Members, under Pending.',
    id: 'Setujui atau tolak di All Members, pada tab Pending.',
  },
  transferMovedYou: ({ to }: { to: string }) => ({
    en: `You now report to ${to}`,
    id: `Sekarang Anda melapor ke ${to}`,
  }),
  transferMovedYouDetail: {
    en: 'Your office moved you to their unit. Your history stays with you.',
    id: 'KPM Anda memindahkan Anda ke unitnya. Riwayat Anda tetap bersama Anda.',
  },
  transferLeftYourUnit: ({ member, to }: { member: string; to: string }) => ({
    en: `${member} moved to ${to}’s unit`,
    id: `${member} pindah ke unit ${to}`,
  }),
  transferLeftYourUnitDetail: {
    en: 'Your office approved a transfer, so they have left your unit.',
    id: 'KPM Anda menyetujui pemindahan, jadi dia sudah keluar dari unit Anda.',
  },
  transferApproved: ({ member }: { member: string }) => ({
    en: `Your request to move ${member} was approved`,
    id: `Permintaan Anda untuk memindahkan ${member} disetujui`,
  }),
  transferApprovedDetail: { en: 'They are in your unit now.', id: 'Dia sudah ada di unit Anda.' },
  transferDeclined: ({ member }: { member: string }) => ({
    en: `Your request to move ${member} was declined`,
    id: `Permintaan Anda untuk memindahkan ${member} ditolak`,
  }),
  transferDeclinedDetail: { en: 'They stay where they are.', id: 'Dia tetap di unitnya sekarang.' },
  memberRemoved: { en: 'You were removed from your unit', id: 'Anda dikeluarkan dari unit Anda' },
  memberRemovedDetail: {
    en: 'Search for a leader and ask to join again if you want to come back.',
    id: 'Cari leader dan minta bergabung lagi jika Anda ingin kembali.',
  },
  roleChanged: { en: 'Your role changed', id: 'Peran Anda berubah' },
  roleChangedDetail: {
    en: 'Your leader changed what you are. You still report to them.',
    id: 'Leader Anda mengubah peran Anda. Anda tetap melapor kepadanya.',
  },
  adminGranted: { en: 'You can now administer this office', id: 'Sekarang Anda dapat mengelola KPM ini' },
  adminGrantedDetail: { en: 'The Owner gave you KPM Admin access.', id: 'Owner memberi Anda akses KPM Admin.' },
  adminRevoked: { en: 'Your admin access was removed', id: 'Akses admin Anda dicabut' },
  adminRevokedDetail: {
    en: 'You are still in the office; you just cannot administer it.',
    id: 'Anda tetap di KPM ini; hanya saja Anda tidak dapat mengelolanya.',
  },
  leaderLimitApproved: ({ subject }: { subject: string }) => ({
    en: `AgencyBoost approved your request for ${subject}`,
    id: `AgencyBoost menyetujui permintaan Anda untuk ${subject}`,
  }),
  leaderLimitApprovedDetail: {
    en: 'The change is made: they are a leader now, past your office’s limit.',
    id: 'Perubahan sudah dibuat: dia sekarang leader, melebihi batas KPM Anda.',
  },
  leaderLimitDeclined: ({ subject }: { subject: string }) => ({
    en: `AgencyBoost declined your request for ${subject}`,
    id: `AgencyBoost menolak permintaan Anda untuk ${subject}`,
  }),
  leaderLimitDeclinedDetail: { en: 'Nothing about them changed.', id: 'Tidak ada yang berubah pada dirinya.' },
  goalSet: ({ by }: { by: string }) => ({
    en: `${by} set your goal`,
    id: `${by} mengatur goal Anda`,
  }),
  goalSetDetail: {
    en: 'Open Goal settings to see it — you can change it, it is your plan.',
    id: 'Buka Goal settings untuk melihatnya — Anda dapat mengubahnya, ini rencana Anda.',
  },
  coachingFinalized: { en: 'A coaching session was finalized', id: 'Sesi coaching telah difinalkan' },
  coachingFinalizedDetail: { en: 'What was agreed is now on the record.', id: 'Hal yang disepakati kini sudah tercatat.' },
  calendarInvitation: { en: 'You have a new invitation', id: 'Anda mendapat undangan baru' },
  calendarInvitationDetail: {
    en: 'Open it on your calendar to accept or decline.',
    id: 'Buka di kalender Anda untuk menerima atau menolak.',
  },
  calendarBlockPlaced: { en: 'Time was blocked on your calendar', id: 'Ada waktu yang diblok di kalender Anda' },
  calendarBlockPlacedDetail: {
    en: 'A leader above you placed it. Open it to see when.',
    id: 'Leader di atas Anda yang memasangnya. Buka untuk melihat waktunya.',
  },
  calendarCancelled: { en: 'An entry on your calendar was cancelled', id: 'Entri di kalender Anda dibatalkan' },
  calendarCancelledDetail: { en: 'It is no longer on your calendar.', id: 'Entri itu sudah tidak ada di kalender Anda.' },
  calendarMoved: { en: 'An entry on your calendar has moved', id: 'Entri di kalender Anda dipindahkan' },
  calendarMovedDetail: { en: 'Open it to see the new time.', id: 'Buka untuk melihat waktu barunya.' },
  setupAsYou: {
    en: 'Somebody from AgencyBoost is setting up your office as you',
    id: 'Seseorang dari AgencyBoost sedang menyiapkan KPM Anda sebagai Anda',
  },
  setupStartedDefault: { en: 'A setup session has started.', id: 'Sesi penyiapan telah dimulai.' },
  setupInYourOffice: { en: 'A setup session started in your office', id: 'Sesi penyiapan dimulai di KPM Anda' },
  setupHelpingDefault: {
    en: 'Somebody from AgencyBoost is helping set up your office.',
    id: 'Seseorang dari AgencyBoost sedang membantu menyiapkan KPM Anda.',
  },
  setupScope: {
    en: 'They can change the office\'s settings, import people and upload production files, and nothing else.',
    id: 'Dia hanya dapat mengubah pengaturan KPM, mengimpor anggota, dan mengunggah file produksi.',
  },
  supportLooking: {
    en: 'Somebody from AgencyBoost is looking at your screens',
    id: 'Seseorang dari AgencyBoost sedang melihat layar Anda',
  },
  supportStartedDefault: { en: 'A support session has started.', id: 'Sesi dukungan telah dimulai.' },
  supportLookOnly: {
    en: 'They can only look, unless a second person approves otherwise.',
    id: 'Dia hanya dapat melihat, kecuali orang kedua menyetujui sebaliknya.',
  },
  supportInYourOffice: { en: 'A support session started in your office', id: 'Sesi dukungan dimulai di KPM Anda' },
  supportHelpingDefault: {
    en: 'Somebody from AgencyBoost is helping a member.',
    id: 'Seseorang dari AgencyBoost sedang membantu seorang anggota.',
  },
  supportElevated: { en: 'That support session can now make changes', id: 'Sesi dukungan itu kini dapat mengubah data' },
  supportElevatedDefault: {
    en: 'A second person from AgencyBoost approved it.',
    id: 'Orang kedua dari AgencyBoost telah menyetujuinya.',
  },
  eventComingUp: ({ title }: { title: string }) => ({
    en: `${title} is coming up`,
    id: `${title} akan segera berlangsung`,
  }),
  eventComingUpDefault: { en: 'Check the time and where it is.', id: 'Periksa waktu dan tempatnya.' },
  somethingHappened: { en: 'Something happened', id: 'Ada sesuatu yang terjadi' },
});

/**
 * **What the email says, in both languages** (P18.98-T5 AC-5): the frame every email shares — the subject's tag, the
 * greeting and the sign-off — and the two auth emails, which have no inbox row of their own. Every other email is the
 * inbox's words (`NOTICE_MESSAGES`) in the frame.
 */
export const EMAIL_MESSAGES = messages('modules/notifications: emails', {
  subject: ({ subject }: { subject: string }) => ({ en: `[AgencyBoost] ${subject}`, id: `[AgencyBoost] ${subject}` }),
  hello: ({ name }: { name: string }) => ({ en: `Hello ${name},`, id: `Halo ${name},` }),
  helloNobody: { en: 'Hello,', id: 'Halo,' },
  signOff: { en: '— AgencyBoost', id: '— AgencyBoost' },
  verifySubject: { en: 'Verify your email address', id: 'Verifikasi alamat email Anda' },
  verifyOpen: {
    en: 'Open this link to verify your address. You cannot sign in until you have.',
    id: 'Buka tautan ini untuk memverifikasi alamat Anda. Anda tidak dapat masuk sebelum melakukannya.',
  },
  verifyIgnore: {
    en: 'If you did not create an AgencyBoost account, ignore this — nothing happens '
      + 'until the link is opened.',
    id: 'Jika Anda tidak membuat akun AgencyBoost, abaikan email ini — tidak ada yang terjadi '
      + 'sampai tautan dibuka.',
  },
  resetSubject: { en: 'Reset your password', id: 'Atur ulang kata sandi Anda' },
  resetOpen: {
    en: 'Open this link to choose a new password.',
    id: 'Buka tautan ini untuk membuat kata sandi baru.',
  },
  resetIgnore: {
    en: 'If you did not ask for this, ignore it. Your password has not changed, and the '
      + 'link expires on its own.',
    id: 'Jika Anda tidak memintanya, abaikan email ini. Kata sandi Anda tidak berubah, dan '
      + 'tautan ini akan kedaluwarsa dengan sendirinya.',
  },
  seeWhatChanged: { en: 'Open AgencyBoost to see what changed.', id: 'Buka AgencyBoost untuk melihat perubahannya.' },
  /* UI V1 (2026-10-30; UI-111, ADR-0181): the email change — its link, to the new address; its notice, to the old. */
  changeVerifySubject: { en: 'Confirm your new email address', id: 'Konfirmasi alamat email baru Anda' },
  changeVerifyOpen: {
    en: 'Open this link to make this address the email you sign in to AgencyBoost with. '
      + 'Your email does not change until you do.',
    id: 'Buka tautan ini untuk menjadikan alamat ini email yang Anda pakai untuk masuk ke AgencyBoost. '
      + 'Email Anda tidak berubah sebelum Anda membukanya.',
  },
  changeVerifyIgnore: {
    en: 'If you did not ask for this, ignore it. Nothing changes until the link is opened, and it expires on its own.',
    id: 'Jika Anda tidak memintanya, abaikan email ini. Tidak ada yang berubah sampai tautan dibuka, dan tautan ini '
      + 'akan kedaluwarsa dengan sendirinya.',
  },
  changeNoticeSubject: { en: 'Your email address is being changed', id: 'Alamat email Anda sedang diubah' },
  changeNoticeAsked: ({ newEmail }: { newEmail: string }) => ({
    en: `Someone signed in to your account asked to change its email to ${newEmail}. `
      + 'It changes only when the link sent to that address is opened.',
    id: `Seseorang yang masuk ke akun Anda meminta email akun ini diubah menjadi ${newEmail}. `
      + 'Email itu baru berubah setelah tautan yang dikirim ke alamat tersebut dibuka.',
  }),
  changeNoticeNotYou: {
    en: 'If this was not you, change your password now: that cancels the change.',
    id: 'Jika ini bukan Anda, segera ubah kata sandi Anda: itu membatalkan perubahan ini.',
  },
});

/** **The inbox's own refusal** (P18.98-T5 AC-2): a permission the reader does not hold. */
export const NOTIFICATION_REFUSALS = refusals('modules/notifications', {
  PERM_DENIED: {
    cannot: { en: 'You cannot do that.', id: 'Anda tidak dapat melakukannya.' },
  },
});
