import type { WorkStatus } from '@/domain/constants';
import { DEMOGRAPHIC_DATA } from '@/domain/constants/advanced-analytics';
import { delimiterOf, parseCsv } from '@/modules/production/production-csv';
import { csvField } from '@/modules/production/production-template';

/**
 * ***Demografi › Upload data*'s file** (P19.22-T2 AC-1; ADR-0275 §2; OD-413): *Unduh daftar CSV · Lengkapi · Upload*.
 * Pure: the rows in, the CSV out, and back. Pinned by `demographics-file.spec.ts`.
 *
 * - **The list** has one row per member counted: *Kode agen*, *Nama*, *Peran*, *Upline*, and the three fields the page
 *   counts as the data — *Status kerja* (*Full-time* / *Part-time*), *Tanggal lahir* and *Tanggal bergabung*
 *   (`dd/mm/yyyy`) — filled where they are on file.
 * - **Read back by its header's names**, in any order, any case, the delimiter the header uses; **the agent code is the
 *   key**, as the People import's (ADR-0184): a row is the member with that code in this KPM.
 * - **An empty cell changes nothing** (*"Kolom kosong tidak diubah"*); a filled one is read and checked by the caller.
 */

export const DEMOGRAPHICS_FILE_HEADER = [
  'Kode agen', 'Nama', 'Peran', 'Upline', 'Status kerja', 'Tanggal lahir', 'Tanggal bergabung',
] as const;

/** One member as the list writes them. Dates `YYYY-MM-DD`, as stored. */
export interface DemographicsFileRow {
  agentCode: string;
  name: string;
  role: string;
  upline: string;
  workStatus: WorkStatus | null;
  dateOfBirth: string | null;
  joinDate: string | null;
}

/** What spreadsheet reads as the start of a formula (OWASP, *CSV injection*): written as text. */
const FORMULA_LEAD = /^[=+\-@]/;
const text = (value: string) => csvField(FORMULA_LEAD.test(value) ? `'${value}` : value);

const WORK_STATUS_WORDS: Record<WorkStatus, string> = { full_time: 'Full-time', part_time: 'Part-time' };

/** `YYYY-MM-DD` as the file writes it: `dd/mm/yyyy`. */
export function dayToFile(day: string | null): string {
  if (!day) return '';
  return `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
}

/** **The list**, header first, one line per member, `\r\n` between lines as a spreadsheet writes them. */
export function demographicsFile(rows: readonly DemographicsFileRow[]): string {
  const lines = [
    DEMOGRAPHICS_FILE_HEADER.map((h) => csvField(h)).join(','),
    ...rows.map((r) => [
      csvField(r.agentCode), text(r.name), text(r.role), text(r.upline),
      r.workStatus ? WORK_STATUS_WORDS[r.workStatus] : '', dayToFile(r.dateOfBirth), dayToFile(r.joinDate),
    ].join(',')),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/** A row read back: its line, its code, and the cells that were filled — `undefined` for an empty one. */
export interface DemographicsFileEntry {
  line: number;
  agentCode: string;
  workStatus?: string;
  dateOfBirth?: string;
  joinDate?: string;
}

const norm = (header: string) => header.trim().toLowerCase().replace(/^﻿/, '').replace(/\s+/g, ' ');

/**
 * **The file read back**: its rows by the header's names, or `null` when the header has no *Kode agen* column — no row
 * can be matched to anybody. Blank lines are skipped. At most `DEMOGRAPHIC_DATA.FILE_MAX_ROWS` rows are read.
 */
export function readDemographicsFile(content: string): DemographicsFileEntry[] | null {
  const records = parseCsv(content.replace(/^﻿/, ''), delimiterOf(content));
  const header = records[0]?.cells.map(norm) ?? [];
  const at = (name: string) => header.indexOf(norm(name));
  const code = at('Kode agen');
  if (code === -1) return null;
  const work = at('Status kerja');
  const birth = at('Tanggal lahir');
  const join = at('Tanggal bergabung');
  const cell = (cells: string[], i: number) => (i === -1 ? undefined : (cells[i] ?? '').trim() || undefined);
  return records.slice(1, DEMOGRAPHIC_DATA.FILE_MAX_ROWS + 1)
    .filter((r) => r.cells.some((c) => c.trim() !== ''))
    .map((r) => ({
      line: r.line,
      agentCode: (r.cells[code] ?? '').trim(),
      workStatus: cell(r.cells, work),
      dateOfBirth: cell(r.cells, birth),
      joinDate: cell(r.cells, join),
    }));
}

/** *Full-time* / *Part-time*, in either language, as the file may carry them; `null` for anything else. */
export function workStatusFromFile(value: string): WorkStatus | null {
  const v = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (['full-time', 'fulltime', 'penuh-waktu'].includes(v)) return 'full_time';
  if (['part-time', 'parttime', 'paruh-waktu'].includes(v)) return 'part_time';
  return null;
}

/** `dd/mm/yyyy` (or `dd-mm-yyyy`, or `YYYY-MM-DD`) as `YYYY-MM-DD`; `null` when it is no such date. */
export function dayFromFile(value: string): string | null {
  const v = value.trim();
  let y: number; let m: number; let d: number;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  else if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
