import { KPM_REPORT } from '@/domain/constants';
import type { ReportPerson } from './kpm-report.model';

/**
 * **Every word the KPM report prints** (P19.24-T1; ADR-0280 §4; the approved template `laporan-kpm-template-2026-11-20`).
 * **Indonesian only**, as the template: the file is the Owner's document, whatever language the Super Admin reads the
 * console in. The pages' own words where a page already says it (the KPM Overview's *Pakai ≤ 14 hari*, *Belum pernah
 * coaching*, the MAPA rows, the Quant metrics); the template's elsewhere, corrected where it disagrees with a page's
 * definition (*Activity Mgmt* is *"mencatat aktivitas dalam 7 hari terakhir"*, the page's, not the template's *"< 3 hari /
 * 7"*; parity I-1203).
 */

/** Indonesian month names in full: *Laporan KPM Oktober 2026*. */
export const BULAN = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
] as const;

/** `2026-10` → *Oktober 2026*. */
export function monthLong(month: string): string {
  const m = Number(month.slice(5, 7));
  return m >= 1 && m <= 12 ? `${BULAN[m - 1]} ${month.slice(0, 4)}` : month;
}

/** A survey run's period key as its tab names it: `2026-Q3` → *Q3 2026*, `2026-H1` → *H1 2026*, `2026-06` → *Juni 2026*. */
export function periodLabel(key: string): string {
  const quarter = /^(\d{4})-([QH]\d)$/.exec(key);
  if (quarter) return `${quarter[2]} ${quarter[1]}`;
  return /^\d{4}-\d{2}$/.test(key) ? monthLong(key) : key;
}

/** *Tanpa group*: the AB groups with no informal group, the KPM Overview's words. */
export const NO_GROUP = 'Tanpa group';

/**
 * **The actions** (*3 tindakan minggu ini*, *Ringkasan tindakan* and each person's second row on their AB group's page):
 * each a person's own reading read the other way round — nothing here is a new measure. **Nothing about training**
 * (§11). `tone` is the chip's colour on a person's row: red *segera*, yellow *minggu ini*, green *peluang*.
 */
export const REPORT_ACTIONS: readonly {
  key: string;
  label: string;
  /** The words on a person's chip, when they differ from the row's. */
  chip?: (p: ReportPerson) => string;
  tone: 'red' | 'yellow' | 'green';
  applies: (p: ReportPerson) => boolean;
}[] = [
  { key: 'never_used', label: 'Belum pernah pakai AgencyBoost', tone: 'red', applies: (p) => !p.usage.ever },
  {
    key: 'lapsed', label: 'Tidak pakai 14 hari terakhir', tone: 'red', applies: (p) => p.usage.ever && !p.usage.recent14,
    chip: (p) => `Ajak pakai lagi · terakhir ${p.usage.days ?? '–'} hari lalu`,
  },
  { key: 'never_coached', label: 'Belum pernah coaching', tone: 'red', applies: (p) => p.coaching.status === 'never', chip: () => 'Coaching pertama' },
  {
    key: 'coaching_lapsed', label: 'Coaching lebih dari 14 hari', tone: 'yellow', applies: (p) => p.coaching.status === 'lapsed',
    chip: (p) => `Coaching ulang · ${p.coaching.days ?? '–'} hari lalu`,
  },
  { key: 'no_goal', label: 'Belum isi goal setting', tone: 'yellow', applies: (p) => p.compliance.goals === false, chip: () => 'Isi goal setting' },
  { key: 'leads', label: 'Leads belum diupdate', tone: 'yellow', applies: (p) => p.compliance.leads === false, chip: () => 'Update leads' },
  {
    key: 'activity', label: 'Belum mencatat aktivitas 7 hari terakhir', tone: 'yellow', applies: (p) => p.compliance.activity === false,
    chip: () => 'Catat aktivitas',
  },
  { key: 'campaigns', label: 'Belum ikut campaign', tone: 'yellow', applies: (p) => p.compliance.campaigns === false },
  { key: 'events', label: 'Belum hadir event', tone: 'yellow', applies: (p) => p.compliance.events === false },
  { key: 'nps', label: 'Belum isi survei NPS', tone: 'yellow', applies: (p) => p.nps === false, chip: () => 'Isi survei NPS' },
  {
    key: 'activation', label: 'Activation checklist belum lengkap', tone: 'yellow', applies: (p) => p.compliance.activation === false,
  },
  {
    key: 'potensi', label: 'Potensi Active Agent bulan ini', tone: 'green', applies: (p) => p.potensi,
    chip: () => 'Potensi Active Agent: dampingi closing',
  },
  {
    key: 'qual', label: `${KPM_REPORT.QUAL_MANY_ISSUES}+ masalah di Analisa kualitatif`, tone: 'red',
    applies: (p) => (p.qualIssues ?? 0) >= KPM_REPORT.QUAL_MANY_ISSUES,
    chip: (p) => `${p.qualIssues} masalah di Analisa kualitatif`,
  },
];

/** *3 tindakan minggu ini*: the three the template names, each over the actions above. */
export const WEEK_ACTIONS: readonly { label: string; applies: (p: ReportPerson) => boolean }[] = [
  { label: 'Ajak pakai lagi / mulai pakai', applies: (p) => !p.usage.recent14 },
  { label: 'Coaching pertama', applies: (p) => p.coaching.status === 'never' },
  { label: 'Dampingi closing (potensi Active Agent)', applies: (p) => p.potensi },
];

/** The eight compliance items: their name and their line, the KPM Overview card's unit first. */
export const COMPLIANCE_WORDS: Readonly<Record<string, { name: string; unit: string; line: (year: string, nps: string | null) => string; column: string }>> = {
  goals: { name: 'Goal Setting', unit: 'anggota', line: (year) => `goal terisi untuk ${year}`, column: 'Goal setting' },
  activity: { name: 'Activity Mgmt', unit: 'anggota', line: () => 'mencatat aktivitas dalam 7 hari terakhir', column: 'Activity' },
  leads: { name: 'Leads Mgmt', unit: 'anggota', line: () => 'punya lead terbuka, semua dengan tindakan berikutnya', column: 'Leads' },
  activation: { name: 'Activation', unit: 'agent baru', line: () => 'activation checklist lengkap (agent baru, 90 hari)', column: 'Activation' },
  events: { name: 'Events', unit: 'yang diundang', line: (year) => `hadir di event ${year}`, column: 'Events' },
  campaigns: { name: 'Campaigns', unit: 'anggota', line: () => 'memenuhi campaign yang berjalan', column: 'Campaigns' },
  coaching: { name: 'Coaching 1-on-1', unit: 'anggota', line: () => 'dicoaching dalam 14 hari terakhir', column: 'Coaching' },
  nps: { name: 'Survei NPS', unit: 'yang diundang', line: (_year, nps) => (nps ? `mengisi survei NPS ${nps}` : 'belum ada survei NPS'), column: 'NPS' },
};

/** The MAPA rows as the page names them (`advanced-analytics-page.ts`, *mapa.rows*). */
export const MAPA_WORDS: Readonly<Record<string, string>> = {
  ape: 'APE (Rp jt)',
  manpower: 'M · Manpower',
  rekrut: 'M · Rekrut',
  active_agent: 'A · Active Agent',
  new_agent_3m: 'A · % agent baru aktif dalam 3 bulan',
  policies: 'P · Polis terbit',
  policies_per_active_agent: 'P · Polis per Active Agent',
  average_case_size: 'A · Nilai rata-rata polis (Rp jt)',
};

/** The Quant metrics as the page names them (`advanced-analytics-page.ts`, *quant.metrics*). */
export const QUANT_WORDS: Readonly<Record<string, string>> = {
  A1: 'Rekrut per leader',
  A2: 'Pertumbuhan bersih active agent (tahunan)',
  A3: 'Active agent per leader',
  B1: 'Rekrut baru aktif dalam 3 bulan',
  B2: 'Aktivasi rekrut keseluruhan',
  B3: 'Aktivasi agent lama (bukan rekrut)',
  C1: 'Active agent rata-rata per bulan (per leader)',
  C2: 'Polis per active agent',
  C3: 'Rata-rata bulan aktif',
  D1: 'Nilai per polis (Rp jt)',
};

/** The Quant position chips (`advanced-analytics-page.ts`, *quant*). */
export const PEER_WORDS = { above: 'Di atas peers', in_line: 'Sejajar', below: 'Di bawah peers' } as const;

/** Demografi's bands and values, as the page names them. */
export const DEMOGRAPHIC_WORDS: Readonly<Record<string, string>> = {
  ab: 'AB', aab: 'AAB', agent: 'Agent',
  full_time: 'Full-time', part_time: 'Part-time',
  male: 'Laki-laki', female: 'Perempuan',
  gen_z: 'Gen Z', gen_y: 'Gen Y', gen_x: 'Gen X',
  unset: 'Belum diisi',
};

/** The required profile fields, as *Perlu melengkapi data* names what is missing. */
export const FIELD_WORDS: Readonly<Record<string, string>> = {
  dateOfBirth: 'tanggal lahir',
  gender: 'jenis kelamin',
  workStatus: 'status kerja',
  joinDate: 'bulan bergabung',
};

/** An attendance mark's words (*Kehadiran per orang*): every list says *HADIR* plainly. */
export const ATTENDANCE_WORDS: Readonly<Record<string, string>> = {
  attended: '✓ HADIR',
  absent: '✗ Tidak hadir',
  waiting: 'Belum dicatat',
};
