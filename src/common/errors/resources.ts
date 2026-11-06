/**
 * **What a `404 NOT_FOUND` names, in both languages** (P18.10-T5 AC-2; the glossary for approval's §B.6,
 * *{Resource} tidak ditemukan.*). The English is the name the API has always written — *Membership not found.* — so
 * every assertion on it stands, the odd spelling included (*EventType*, *Kpm*); the Indonesian is the thing named in
 * the reader's words, a kept-English term kept (§A: *Lead*, *Event*, *Campaign*, *Goal*, *Unit*, *New hire*).
 *
 * `NotFoundException` takes only a name listed here, so a new one fails `tsc` until it has its Indonesian.
 */
export const RESOURCE_NAMES = {
  Activation: 'Activation',
  'Activation checklist': 'Activation checklist',
  'Activation item': 'Item activation',
  'Activity category': 'Kategori aktivitas',
  'Activity type': 'Jenis aktivitas',
  /* P19.5-T4: the KPM's *Advanced analytics* reads, to a field member who is not a Core Leader (roles §3.9 ¶). */
  'Advanced analytics': 'Advanced analytics',
  Asset: 'File',
  'Calendar entry': 'Entri kalender',
  Campaign: 'Campaign',
  CapabilityGrid: 'Capability Mapping',
  CapabilityItem: 'Item Capability Mapping',
  'Coaching session': 'Sesi coaching',
  Company: 'Perusahaan',
  Document: 'Dokumen',
  Event: 'Event',
  EventType: 'Jenis event',
  Goal: 'Goal',
  Group: 'Grup',
  Import: 'Impor',
  Invite: 'Undangan',
  'Join request': 'Permintaan bergabung',
  KPM: 'KPM',
  Kpm: 'KPM',
  'KPM analytics': 'KPM analytics',
  'KPM request': 'Permintaan KPM',
  Lead: 'Lead',
  'Lead status': 'Status lead',
  /* UI-169 item 5 (ADR-0199): a linked login, the glossary's *Linked login* — *akun tertaut*. */
  'Linked login': 'Akun tertaut',
  'Leader-limit request': 'Permintaan batas leader',
  Meeting: 'Rapat',
  Member: 'Anggota',
  Membership: 'Anggota',
  'New hire': 'New hire',
  'New hires': 'New hires',
  Notification: 'Notifikasi',
  'Org level': 'Jenjang',
  Override: 'Koreksi manual',
  Product: 'Produk',
  Ratio: 'Ratio',
  Session: 'Sesi',
  /* P19.3-T2 (UI-149): a page `PUT /kpm/settings/:page/reviewed` does not know — not one of the setup card's four. */
  'Settings page': 'Halaman pengaturan',
  Standing: 'Hasil campaign',
  'Support session': 'Sesi dukungan',
  /* P19.5-T4 (ADR-0216 §2): a KPM's survey run, on its own routes — `PATCH`, `DELETE` and the results' `?runId=`. */
  'Survey run': 'Periode survei',
  Template: 'Template',
  'Template library': 'Template library',
  'That row': 'Baris itu',
  'Training category': 'Kategori training',
  'Training item': 'Item training',
  'Training module': 'Modul training',
  'Training skill': 'Skill training',
  TrainingModule: 'Modul training',
  'Transfer request': 'Permintaan pemindahan',
  Unit: 'Unit',
  User: 'Pengguna',
} as const;

/** A resource a `404` may name. */
export type ResourceName = keyof typeof RESOURCE_NAMES;
