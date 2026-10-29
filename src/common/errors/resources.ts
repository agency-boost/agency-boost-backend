/**
 * **What a `404 NOT_FOUND` names, in both languages** (P18.98-T5 AC-2; the glossary for approval's §B.6,
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
  Standing: 'Hasil campaign',
  'Support session': 'Sesi dukungan',
  Template: 'Templat',
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
