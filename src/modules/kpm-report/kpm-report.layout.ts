import type { Content, CustomTableLayout, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { formatDate, formatDayMonth, formatNumber, formatRupiah } from '@/common/format/format';
import { addDays } from '@/common/time/local-day';
import { KPM_REPORT } from '@/domain/constants';
import { PDF_FONTS } from '@/modules/proposals/proposal-pdf.layout';
import {
  deltaOf, deltaText, deltaTone, pctOf, toneOf,
  type KpmReportModel, type ReportAbGroup, type ReportDelta, type ReportFigure, type ReportGroup, type ReportPerson,
  type ReportRole, type ReportTone,
} from './kpm-report.model';
import {
  ATTENDANCE_WORDS, COMPLIANCE_WORDS, DEMOGRAPHIC_WORDS, FIELD_WORDS, MAPA_WORDS, NO_GROUP, PEER_WORDS, QUANT_WORDS,
  REPORT_ACTIONS, WEEK_ACTIONS, monthLong, periodLabel,
} from './kpm-report.words';

/**
 * **The KPM report's pages** (P19.24-T1 AC-1 to AC-3; ADR-0280 §4; the approved template
 * `revisions/2026-11-20-Superadmin/files/report/laporan-kpm-template-2026-11-20.html`). Pure: a {@link KpmReportModel} in,
 * the file's `pdfmake` definition out — flowed, not placed, so a table runs onto the next page with **its header row
 * repeated** (`headerRows`) and a row is never split (`dontBreakRows`).
 *
 * - **The order** is the template's after its own script reorders it: 1 *Ringkasan eksekutif* (one page) · 2 *Ringkasan
 *   tindakan* · 3 *KPM Overview* · 4 *Compliance* then *Status per orang* · 5 one page per AB group, each with its own
 *   header so it can be sent alone · 6 *Lampiran · Advanced analytics*.
 * - **§11's rules**: names in CAPITALS with the orange *AB* / *AAB* label (`nameText`); name lists as tables; every
 *   list says *SUDAH* / *BELUM* / *HADIR*; one colour scale (`toneOf`); the footer *"KPM · company · Laporan KPM
 *   <bulan>"* and *"hal. x / n"*; nothing smaller than `KPM_REPORT.MIN_TEXT_PT`; ▲/▼ vs last month on the key numbers.
 * - **Nothing about training**; and the AI's *Yang bisa diperbaiki* is left out while the AI is on hold (OD-358).
 */

// ------------------------------------------------------------------------------------------------ the look

/** The template's colours (its `:root`): the PDF has no stylesheet, so they are named here once. */
export const REPORT_COLOURS = {
  navy: '#1B2B4B',
  orange: '#E8873A',
  orangeTint: '#FDF1E6',
  ink: '#1C1C1A',
  grey: '#6B6A65',
  line: '#E4E2DC',
  rule: '#F1EFEA',
  head: '#F4F5F8',
  headInk: '#4A5570',
  paper: '#F7F6F2',
  white: '#FFFFFF',
  green: '#3B6D11',
  greenTint: '#EAF3DE',
  yellow: '#A0620E',
  yellowTint: '#FAEEDA',
  red: '#C23B3B',
  redTint: '#FCEBEB',
  track: '#EEECE7',
} as const;
const C = REPORT_COLOURS;

/** **Every size the file sets, in points** — each at least `KPM_REPORT.MIN_TEXT_PT` (12 CSS px), the template's px × 0.75. */
export const REPORT_TYPE = {
  SMALL: KPM_REPORT.MIN_TEXT_PT,
  BODY: 10,
  TH: KPM_REPORT.MIN_TEXT_PT,
  H1: 21,
  H2: 14,
  H3: 11.5,
  CHAPTER: 15,
  TILE: 16,
  HERO: 19,
  COUNT: 15,
  TOP_NAME: 11.5,
} as const;
const T = REPORT_TYPE;

const MARGIN = 32;
const PAGE_W = 595.28;
/** The content's width on A4 between the two margins. */
export const CONTENT_W = PAGE_W - 2 * MARGIN;

const TONE_COLOURS: Record<ReportTone, { fg: string; bg: string }> = {
  green: { fg: C.green, bg: C.greenTint },
  yellow: { fg: C.yellow, bg: C.yellowTint },
  red: { fg: C.red, bg: C.redTint },
};

// ------------------------------------------------------------------------------------------------ small parts

const num = (n: number) => formatNumber(n, undefined, 'id');
const rp = (minor: number | null) => (minor === null ? '–' : formatRupiah(minor, 'id'));
const dash = '–';

/** **A name as §11 prints it**: the orange *AB* / *AAB* before it for a leader, none for an agent; the name in CAPITALS. */
export function nameText(person: { name: string; role: ReportRole }, extra: Partial<Record<string, unknown>> = {}): Content {
  const label = person.role === 'agent' ? [] : [{ text: `${person.role.toUpperCase()} `, color: C.orange, bold: true, fontSize: T.SMALL }];
  return { text: [...label, { text: person.name || dash, bold: true, color: C.navy }], ...extra } as Content;
}

/** **A percentage in its colour** (`toneOf`): green ≥ 80, yellow 50–79, red < 50 — the one scale. */
export function pctText(pct: number | null, extra: Partial<Record<string, unknown>> = {}): Content {
  const tone = toneOf(pct);
  if (pct === null || tone === null) return { text: dash, color: C.grey, ...extra } as Content;
  return { text: ` ${pct}% `, bold: true, color: TONE_COLOURS[tone].fg, background: TONE_COLOURS[tone].bg, ...extra } as Content;
}

/** The arrow against last month, in green when the change is the good way, red the other, grey when flat. */
function deltaRun(delta: ReportDelta | null, vs: string, higherIsBetter = true): Content[] {
  const words = deltaText(delta, vs);
  if (!words) return [];
  const tone = deltaTone(delta, higherIsBetter);
  return [{ text: `  ${words}`, bold: true, color: tone === 'up' ? C.green : tone === 'down' ? C.red : C.grey, fontSize: T.SMALL } as Content];
}

/** A figure against its target: *"8 / 14"*, *"8"* with none set, *"–"* not uploaded. */
const figureText = (f: ReportFigure) => (f.value === null ? dash : f.target === null ? num(f.value) : `${num(f.value)} / ${num(f.target)}`);

/** A thin progress bar `width` points long, filled in its tone. */
function bar(pct: number | null, width: number, tone: ReportTone | null = toneOf(pct), fill?: string): Content {
  const filled = pct === null ? 0 : Math.max(0, Math.min(100, pct)) / 100 * width;
  return {
    canvas: [
      { type: 'rect', x: 0, y: 0, w: width, h: 4, r: 2, color: C.track },
      ...(filled > 0 ? [{ type: 'rect', x: 0, y: 0, w: filled, h: 4, r: 2, color: fill ?? (tone ? TONE_COLOURS[tone].fg : C.navy) }] : []),
    ],
    margin: [0, 4, 0, 0],
  } as Content;
}

/** The table look every list shares: a tinted header row, light rules between rows, no vertical lines. */
const LIST_LAYOUT: CustomTableLayout = {
  hLineWidth: (i, node) => (i === 0 || i === (node.table.headerRows ?? 0) ? 0 : 0.6),
  vLineWidth: () => 0,
  hLineColor: () => C.rule,
  fillColor: (row, node) => (row < (node.table.headerRows ?? 0) ? C.head : null),
  paddingLeft: () => 5,
  paddingRight: () => 5,
  paddingTop: () => 3.5,
  paddingBottom: () => 3.5,
};

/** A header cell: uppercase, small, the template's slate. */
const th = (text: string, alignment: 'left' | 'center' | 'right' = 'left'): TableCell =>
  ({ text: text.toUpperCase(), bold: true, fontSize: T.TH, color: C.headInk, alignment, characterSpacing: 0.2 }) as TableCell;

/** **A list as a table** (§11: never commas): its header repeats on each page it runs onto; a row is never split. */
function list(headers: TableCell[], rows: TableCell[][], widths: (string | number)[], extra: Partial<Record<string, unknown>> = {}): Content {
  return {
    table: { headerRows: 1, dontBreakRows: true, widths, body: [headers, ...rows] },
    layout: LIST_LAYOUT,
    margin: [0, 2, 0, 6],
    ...extra,
  } as Content;
}

/** A total row: bold, a navy rule above it, the paper tint. */
const totalRow = (cells: TableCell[]): TableCell[] => cells.map((c) => ({ ...(typeof c === 'object' ? c : { text: c }), bold: true, fillColor: C.paper }) as TableCell);

/** A sub-heading with the template's orange bar. */
function h3(text: string): Content {
  return {
    columns: [
      { canvas: [{ type: 'rect', x: 0, y: 1, w: 3, h: 12, color: C.orange }], width: 8 },
      { text, bold: true, fontSize: T.H3, color: C.navy },
    ],
    margin: [0, 10, 0, 4],
  } as Content;
}

/** A legend line under a table: grey, at the smallest size. */
const legend = (text: string): Content => ({ text, fontSize: T.SMALL, color: C.grey, margin: [0, 0, 0, 6] }) as Content;

/** **The tiles**: `n` bordered boxes in a row, a label, a big figure, a line, an optional bar. */
interface Tile { label: string; value: Content | string; line?: Content | string; pct?: number | null; tone?: ReportTone | null; valueColour?: string }
/** A sub-heading kept on one page with the tiles under it. */
function titledTiles(title: string, items: Tile[], n = items.length): Content {
  return { stack: [h3(title), tiles(items, n)], unbreakable: true } as Content;
}

function tiles(items: Tile[], n = items.length): Content {
  const gap = 6;
  const width = (CONTENT_W - gap * (n - 1)) / n;
  const rows: Content[] = [];
  for (let i = 0; i < items.length; i += n) {
    const chunk = items.slice(i, i + n);
    rows.push({
      columnGap: gap,
      columns: [...chunk, ...Array.from({ length: n - chunk.length }, () => null)].map((t) => (t ? {
        width,
        table: {
          widths: ['*'],
          body: [[{
            stack: [
              { text: t.label, bold: true, fontSize: T.SMALL, color: C.grey },
              typeof t.value === 'string'
                ? { text: t.value, bold: true, fontSize: T.TILE, color: t.valueColour ?? C.navy, margin: [0, 1, 0, 0] }
                : { ...(t.value as object), fontSize: T.TILE, margin: [0, 1, 0, 0] },
              ...(t.line ? [typeof t.line === 'string' ? { text: t.line, fontSize: T.SMALL, color: C.grey } : t.line] : []),
              ...(t.pct !== undefined ? [bar(t.pct ?? null, width - 16, t.tone === undefined ? toneOf(t.pct ?? null) : t.tone)] : []),
            ],
          }]],
        },
        layout: {
          hLineWidth: () => 0.8, vLineWidth: () => 0.8, hLineColor: () => C.line, vLineColor: () => C.line,
          paddingLeft: () => 7, paddingRight: () => 7, paddingTop: () => 6, paddingBottom: () => 6,
        },
      } : { width, text: '' })),
      margin: [0, 0, 0, 6],
    } as Content);
  }
  return { stack: rows, unbreakable: true } as Content;
}

// ------------------------------------------------------------------------------------------------ headers

/** The navy bar at the top of each section (the template's `.top`): the KPM, its company and code, and the period. */
function top(model: KpmReportModel, label: string): Content {
  const { office } = model;
  return {
    table: {
      widths: [26, '*', 'auto'],
      body: [[
        { text: 'AB', bold: true, color: C.navy, fillColor: C.orange, alignment: 'center', fontSize: T.BODY, margin: [0, 5, 0, 5] },
        {
          stack: [
            { text: office.name, bold: true, color: C.white, fontSize: T.TOP_NAME },
            { text: `${office.company} · KPM ${office.code}`, color: '#C9CEDA', fontSize: T.SMALL },
          ],
          margin: [4, 0, 0, 0],
        },
        {
          stack: [
            { text: label, color: '#C9CEDA', fontSize: T.SMALL, alignment: 'right' },
            { text: monthLong(model.month), bold: true, color: C.orange, fontSize: T.TOP_NAME, alignment: 'right' },
          ],
        },
      ]],
    },
    layout: {
      hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => C.navy,
      paddingLeft: () => 8, paddingRight: () => 10, paddingTop: () => 6, paddingBottom: () => 6,
    },
    margin: [0, 0, 0, 10],
  } as Content;
}

/** A chapter's title (the template's `.chap`): navy, a grey line under it, the line below in grey. */
function chapter(title: string, sub: string): Content {
  return {
    stack: [
      { text: title, bold: true, fontSize: T.CHAPTER, color: C.navy },
      { text: sub, fontSize: T.SMALL, color: C.grey, margin: [0, 1, 0, 0] },
      { canvas: [{ type: 'line', x1: 0, y1: 4, x2: CONTENT_W, y2: 4, lineWidth: 1.5, lineColor: C.line }] },
    ],
    margin: [0, 0, 0, 8],
  } as Content;
}

/** A section's first node starts a new page. */
const newPage = (nodes: Content[]): Content[] => {
  if (nodes.length > 0) (nodes[0] as { pageBreak?: string }).pageBreak = 'before';
  return nodes;
};

// ------------------------------------------------------------------------------------------------ trees of names

/** An informal group's name as printed: its own, or *Tanpa group*. */
const groupName = (g: { name: string | null }) => g.name ?? NO_GROUP;

/**
 * **A name list in the fixed order** (§11; the template's `tree`): one row per unit — informal group, AB group, unit —
 * and the unit's people listed down the last cell, one name a line. Only units with somebody in `keep`.
 */
function nameTree(groups: readonly ReportGroup[], keep: (p: ReportPerson) => boolean): Content {
  const rows: TableCell[][] = [];
  let count = 0;
  for (const g of groups) {
    for (const ab of g.abGroups) {
      for (const unit of ab.units) {
        const people = unit.people.filter(keep);
        if (people.length === 0) continue;
        count += people.length;
        const head = unit.people[0];
        rows.push([
          { text: groupName(g), bold: true, color: C.navy, fillColor: C.paper },
          ab.ab ? nameText(ab.ab) : { text: dash, color: C.grey },
          nameText(head),
          { stack: people.map((p) => nameText(p)) },
        ] as TableCell[]);
      }
    }
  }
  if (rows.length === 0) return { text: 'Tidak ada.', color: C.grey, margin: [0, 0, 0, 6] } as Content;
  return list(
    [th('Informal group'), th('AB group'), th('Unit'), th(`Nama · ${count} orang`)],
    rows,
    [90, 110, 110, '*'],
  );
}

/**
 * **Everybody with columns, in the fixed order** (the template's `plist`): a navy row per informal group, a row per AB
 * group, a tinted row per unit, then each person — the unit's head first, their people indented.
 */
function personTable(
  groups: readonly ReportGroup[],
  columns: { head: string; cell: (p: ReportPerson) => TableCell; width?: number | string }[],
  keep: (p: ReportPerson) => boolean = () => true,
  { compact = false }: { compact?: boolean } = {},
): Content {
  const span = columns.length + 1;
  const rows: TableCell[][] = [];
  const spanned = (cell: Record<string, unknown>): TableCell[] =>
    [{ ...cell, colSpan: span } as TableCell, ...Array.from({ length: span - 1 }, () => '' as TableCell)];
  let count = 0;
  for (const g of groups) {
    const abs = g.abGroups.filter((ab) => ab.units.some((u) => u.people.some(keep)));
    if (abs.length === 0) continue;
    rows.push(spanned({ text: groupName(g), bold: true, color: C.white, fillColor: C.navy }));
    for (const ab of abs) {
      rows.push(spanned({
        text: [{ text: 'AB group  ', bold: true, color: C.navy }, ...(ab.ab ? [nameText(ab.ab)] : [{ text: 'Tanpa AB', color: C.grey }])],
        fillColor: C.paper,
      }));
      for (const unit of ab.units) {
        const people = unit.people.filter(keep);
        if (people.length === 0) continue;
        rows.push(spanned({ text: `Unit ${unit.role.toUpperCase()} ${unit.people[0].name}`, bold: true, fontSize: T.SMALL, color: C.navy, fillColor: C.head, margin: [8, 0, 0, 0] }));
        for (const p of people) {
          count += 1;
          const isHead = p.membershipId === unit.headId;
          rows.push([
            nameText(p, { margin: [compact ? (isHead ? 4 : 12) : (isHead ? 12 : 24), 0, 0, 0], ...(compact ? { fontSize: T.SMALL + 0.5 } : {}) }) as TableCell,
            ...columns.map((c) => ({ ...(c.cell(p) as object), alignment: 'center' }) as TableCell),
          ]);
        }
      }
    }
  }
  // A wide matrix (*Status per orang*) keeps its headers in their own case and its cells close, so ten columns and the
  // names fit an A4 page at the smallest size allowed.
  const head = (text: string): TableCell => (compact
    ? { text, bold: true, fontSize: T.TH, color: C.headInk, alignment: 'center' } as TableCell
    : th(text, 'center'));
  return list(
    [th(`Nama · ${count} orang`), ...columns.map((c) => head(c.head))],
    rows,
    ['*', ...columns.map((c) => c.width ?? 'auto')],
    compact ? { layout: { ...LIST_LAYOUT, paddingLeft: () => 3, paddingRight: () => 3 } } : {},
  );
}

/** ✓ *sudah* / ✗ *belum* / – *tidak berlaku*: the matrix's marks, explained by a legend under its title. */
const mark = (v: boolean | null): TableCell => (v === null
  ? { text: dash, color: C.grey }
  : v ? { text: '✓', bold: true, color: C.green } : { text: '✗', bold: true, color: C.red }) as TableCell;

/** The AB groups in the report's order. */
const abGroupsOf = (model: KpmReportModel): { group: ReportGroup; ab: ReportAbGroup }[] =>
  model.groups.flatMap((group) => group.abGroups.filter((ab) => ab.ab !== null).map((ab) => ({ group, ab })));

const peopleOf = (ab: ReportAbGroup) => ab.units.flatMap((u) => u.people);

/** The first name, for *"bisa dikirim langsung ke AGUS"*. */
const firstName = (name: string) => name.split(/\s+/)[0] ?? name;

// ------------------------------------------------------------------------------------------------ 1 · Ringkasan eksekutif

function cover(model: KpmReportModel): Content[] {
  const { office, members, funnel, performance, activeAgents } = model;
  const vs = monthLong(model.month).split(' ')[0].slice(0, 3);
  const prev = previousMonthShort(model.month);
  const used14 = funnel.used14;
  const heroTile = (label: string, value: string, line: string): Content => ({
    stack: [
      { text: label, bold: true, color: '#C9CEDA', fontSize: T.SMALL },
      { text: value, bold: true, color: C.orange, fontSize: T.HERO },
      { text: line, color: '#C9CEDA', fontSize: T.SMALL },
    ],
  }) as Content;
  const funnelRow = (label: string, count: number, pct: number | null, delta: Content[]): TableCell[] => [
    { text: label, bold: true, color: C.white, fontSize: T.BODY },
    bar(pct ?? 100, 64, null, C.orange) as TableCell,
    { text: num(count), bold: true, color: C.white, alignment: 'right' },
    { text: pct === null ? '' : `${pct}%`, bold: true, color: C.orange, alignment: 'right' },
    { stack: delta, alignment: 'right' } as TableCell,
  ];
  const arrow = (d: ReportDelta | null) => {
    const words = deltaText(d, prev);
    return words ? [{ text: words.replace(` vs ${prev}`, ''), color: d && d.value < 0 ? '#F2A7A7' : '#9FD47A', bold: true, fontSize: T.SMALL }] : [];
  };
  const hero: Content = {
    table: {
      widths: ['42%', '*'],
      body: [[
        {
          table: {
            widths: ['*', '*'],
            body: [
              [heroTile('Anggota', num(members.total), `${members.leaders} leader · ${members.agents} agent`), heroTile('Anggota baru', `+${model.newMembers}`, 'bulan ini')],
              [
                heroTile('Active Agent', activeAgents.count === null ? dash : num(activeAgents.count), activeAgents.target === null ? (activeAgents.held ? 'belum ada target' : 'belum diunggah') : `dari target ${activeAgents.target}`),
                heroTile('Rekrut YTD', num(activeAgents.recruitsYtd), activeAgents.recruitsYtdTarget === null ? 'belum ada target' : `dari target ${activeAgents.recruitsYtdTarget}`),
              ],
            ],
          },
          layout: {
            hLineWidth: () => 2, vLineWidth: () => 2, hLineColor: () => C.navy, vLineColor: () => C.navy,
            fillColor: () => '#26365A', paddingLeft: () => 7, paddingRight: () => 7, paddingTop: () => 5, paddingBottom: () => 5,
          },
        },
        {
          stack: [
            { text: 'Pemakaian AgencyBoost', bold: true, color: '#C9CEDA', fontSize: T.SMALL, margin: [0, 0, 0, 3] },
            {
              table: {
                widths: [100, 64, 24, 30, '*'],
                body: [
                  funnelRow('Anggota', members.total, null, []),
                  funnelRow('Pernah pakai', funnel.everUsed.count, funnel.everUsed.pct, arrow(deltaOf(funnel.everUsed.count, funnel.everUsed.previousCount))),
                  funnelRow('Pakai 14 hari terakhir', used14.count, used14.pct, arrow(deltaOf(used14.pct, used14.previousPct, 'points'))),
                  funnelRow('Power user', funnel.powerUsers.count, funnel.powerUsers.pct, arrow(deltaOf(funnel.powerUsers.count, funnel.powerUsers.previousCount))),
                ],
              },
              layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 2, paddingRight: () => 2, paddingTop: () => 3, paddingBottom: () => 3 },
            },
          ],
        },
      ]],
    },
    layout: {
      hLineWidth: () => 0, vLineWidth: () => 0, fillColor: () => C.navy,
      paddingLeft: () => 10, paddingRight: () => 10, paddingTop: () => 10, paddingBottom: () => 10,
    },
    margin: [0, 8, 0, 4],
  } as Content;

  // Ringkasan eksekutif: five lines, each coloured by its own figure on the one scale.
  const ape = performance.total;
  const aa = activeAgents;
  const aaPct = aa.count === null ? null : pctOf(aa.count, aa.target ?? 0);
  const rkPct = pctOf(aa.recruitsYtd, aa.recruitsYtdTarget ?? 0);
  const never = model.people.filter((p) => p.coaching.status === 'never').length;
  const lapsed = model.people.filter((p) => p.coaching.status === 'lapsed').length;
  const coached = model.people.length - never - lapsed;
  const exec: { code: string; tone: ReportTone | null; title: string; line: string }[] = [
    {
      code: 'APE',
      tone: toneOf(ape.apePct),
      title: ape.apeMinor === null
        ? `APE ${monthLong(model.month)} belum diunggah`
        : `${rp(ape.apeMinor)} bulan ini${ape.apePct === null ? '' : ` · ${ape.apePct}% dari target`}`,
      line: `${performance.aboveTarget} dari ${performance.rows.length} AB group di atas target`,
    },
    {
      code: 'AA',
      tone: toneOf(aaPct),
      title: aa.count === null ? 'Active Agent: data bulan ini belum diunggah' : `Active Agent ${aa.count}${aa.target === null ? '' : ` dari target ${aa.target}`}`,
      line: `${aa.potensi} orang potensi aktif bulan ini — dampingi closing`,
    },
    {
      code: 'RK',
      tone: toneOf(rkPct),
      title: `Rekrut YTD ${aa.recruitsYtd}${aa.recruitsYtdTarget === null ? '' : ` dari ${aa.recruitsYtdTarget}`} · ${aa.recruitsMonth === 0 ? 'belum ada rekrut bulan ini' : `${aa.recruitsMonth} rekrut bulan ini`}`,
      line: 'Nama per nama: halaman KPM Overview › Active Agent & Rekrut',
    },
    {
      code: 'AB',
      tone: toneOf(used14.pct),
      title: `${used14.count} dari ${members.total} pakai AgencyBoost 14 hari terakhir (${used14.pct ?? 0}%) · ${funnel.powerUsers.count} power user`,
      line: `${members.total - funnel.everUsed.count} belum pernah pakai · ${members.total - used14.count} tidak pakai 14 hari terakhir`,
    },
    {
      code: 'CO',
      tone: toneOf(pctOf(coached, model.people.length)),
      title: `Coaching: ${never} orang belum pernah dicoaching`,
      line: `${lapsed} orang terakhir dicoaching lebih dari 14 hari lalu`,
    },
  ];
  const execTable: Content = {
    table: {
      widths: [30, '*'],
      body: exec.map((e) => [
        {
          text: e.code, bold: true, alignment: 'center', fontSize: T.SMALL, margin: [0, 6, 0, 6],
          color: e.tone ? TONE_COLOURS[e.tone].fg : C.grey, fillColor: e.tone ? TONE_COLOURS[e.tone].bg : C.rule,
        },
        { stack: [{ text: e.title, bold: true, color: C.navy, fontSize: T.BODY + 0.5 }, { text: e.line, color: C.grey, fontSize: T.SMALL }], margin: [4, 0, 0, 0] },
      ] as TableCell[]),
    },
    layout: {
      hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 0.8 : 0.6),
      vLineWidth: (i, node) => (i === 0 || i === (node.table.widths?.length ?? 0) ? 0.8 : 0),
      hLineColor: () => C.line, vLineColor: () => C.line,
      paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 5, paddingBottom: () => 5,
    },
    margin: [0, 2, 0, 6],
    unbreakable: true,
  } as Content;

  // 3 tindakan minggu ini: how many people, and the AB groups with the most.
  const week = WEEK_ACTIONS.map((a) => {
    const who = model.people.filter(a.applies);
    const top = abGroupsOf(model)
      .map(({ ab }) => ({ ab: ab.ab!, n: peopleOf(ab).filter(a.applies).length }))
      .filter((x) => x.n > 0)
      .sort((x, y) => y.n - x.n)
      .slice(0, KPM_REPORT.TOP_GROUPS_PER_ACTION);
    return [
      { text: a.label, bold: true, color: C.navy },
      { text: num(who.length), bold: true, fontSize: T.COUNT, color: C.navy, alignment: 'center' },
      top.length === 0
        ? { text: dash, color: C.grey }
        : { stack: top.map((x) => ({ text: [nameText(x.ab), { text: ` group · ${x.n}`, color: C.navy }] })) },
    ] as TableCell[];
  });

  void vs;
  return [
    top(model, 'Laporan KPM'),
    { text: office.name, bold: true, fontSize: T.H1, color: C.navy },
    {
      text: [
        `${office.company} · KPM ${office.code} · KPM Owner `,
        { text: office.ownerName ? office.ownerName.toLocaleUpperCase('id-ID') : dash, bold: true },
        ` · ${members.total} anggota (${members.leaders} leader · ${members.agents} agent) · dibuat ${formatDate(model.madeOn, 'id')}`,
      ],
      fontSize: T.SMALL,
      color: C.grey,
    } as Content,
    hero,
    { text: 'Ringkasan eksekutif', bold: true, fontSize: T.H2, color: C.navy, margin: [0, 8, 0, 4] } as Content,
    execTable,
    { text: '3 tindakan minggu ini', bold: true, fontSize: T.H2, color: C.navy, margin: [0, 6, 0, 2] } as Content,
    list([th('Tindakan'), th('Orang', 'center'), th('Paling banyak di')], week, ['*', 50, 190], { unbreakable: true }),
    legend('Nama per nama: halaman Ringkasan tindakan dan halaman per AB group.'),
  ];
}

/**
 * **How long ago, as of the report's day** (ADR-0280 §3): *Hari ini* and *n hari lalu* in the KPM's month; for a past
 * month the day itself — *28 Okt* — since *"hari ini"* in a report about October would be the wrong day.
 */
function sinceWords(model: Pick<KpmReportModel, 'asOf' | 'madeOn'>, days: number): string {
  if (model.asOf === model.madeOn) return days === 0 ? 'Hari ini' : `${days} hari lalu`;
  return formatDayMonth(addDays(model.asOf, -days), 'id');
}

/** The month before, short: *Sep*. */
function previousMonthShort(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return monthLong(prev).split(' ')[0].slice(0, 3);
}

// ------------------------------------------------------------------------------------------------ 2 · Ringkasan tindakan

function actionsSummary(model: KpmReportModel): Content[] {
  const abs = abGroupsOf(model);
  const per = KPM_REPORT.ACTION_COLUMNS_PER_TABLE;
  const chunks: typeof abs[] = [];
  for (let i = 0; i < Math.max(abs.length, 1); i += per) chunks.push(abs.slice(i, i + per));
  const tables = chunks.map((chunk, at) => {
    // Two header rows, as the template's: each informal group over its AB groups, then each AB group by first name.
    const spans: TableCell[] = [{ text: '' }, { text: '' }];
    for (let i = 0; i < chunk.length;) {
      const group = chunk[i].group;
      let n = 1;
      while (i + n < chunk.length && chunk[i + n].group === group) n += 1;
      spans.push({ text: groupName(group), colSpan: n, bold: true, fontSize: T.SMALL, color: C.orange, alignment: 'center' } as TableCell);
      for (let k = 1; k < n; k += 1) spans.push('' as TableCell);
      i += n;
    }
    const heads: TableCell[] = [
      th('Tindakan'), th('Total', 'center'),
      ...chunk.map(({ ab }) => ({ ...(nameText({ name: firstName(ab.ab!.name), role: 'ab' }) as object), fontSize: T.TH, alignment: 'center' }) as TableCell),
    ];
    const rows = REPORT_ACTIONS.map((a) => [
      { text: a.label, bold: true, color: C.navy },
      { text: num(model.people.filter(a.applies).length), bold: true, alignment: 'center', color: C.navy },
      ...chunk.map(({ ab }) => {
        const n = peopleOf(ab).filter(a.applies).length;
        // Counts are not shares: no colour of the scale on them (§11, one colour scale).
        return n === 0 ? { text: dash, color: C.grey, alignment: 'center' } : { text: num(n), alignment: 'center', bold: true, color: C.navy, fillColor: C.rule };
      }),
    ] as TableCell[]);
    return {
      table: { headerRows: 2, dontBreakRows: true, widths: ['*', 34, ...chunk.map(() => 52)], body: [spans, heads, ...rows] },
      layout: { ...LIST_LAYOUT, paddingLeft: () => 3, paddingRight: () => 3 },
      margin: [0, at > 0 ? 10 : 2, 0, 6],
    } as Content;
  });
  return newPage([
    top(model, 'Periode'),
    chapter('Ringkasan tindakan', 'Jumlah orang per tindakan, per AB group · nama per nama di halaman per AB group'),
    ...tables,
    legend('Detail nama per nama di halaman berikut, satu halaman per AB group — tiap halaman bisa dikirim langsung ke leader-nya.'),
  ]);
}

// ------------------------------------------------------------------------------------------------ 3 · KPM Overview

function overview(model: KpmReportModel): Content[] {
  const { performance, funnel, members, activity, activeAgents } = model;
  const prev = previousMonthShort(model.month);
  const month = monthLong(model.month);
  const usageRow = (label: Content, people: readonly ReportPerson[]): TableCell[] => {
    const n = people.length;
    const ever = people.filter((p) => p.usage.ever).length;
    const recent = people.filter((p) => p.usage.recent14).length;
    const power = people.filter((p) => p.usage.powerUser).length;
    const cell = (k: number) => ({ text: [pctText(pctOf(k, n)), { text: `  ${num(k)}`, bold: true, color: C.navy }], alignment: 'center' });
    return [label, { text: num(n), alignment: 'center' }, cell(ever), cell(recent), cell(power), { text: num(n - ever), alignment: 'center' }] as TableCell[];
  };

  const perfRows: TableCell[][] = performance.rows.map((r) => [
    nameText({ name: r.label, role: 'ab' }),
    { text: r.groupName ?? NO_GROUP, color: C.navy },
    { text: rp(r.apeMinor), color: C.navy },
    { ...(pctText(r.apePct) as object), alignment: 'center' },
    { text: figureText(r.activeAgents), alignment: 'center', color: C.navy },
    { text: figureText(r.rekrutYtd), alignment: 'center', color: C.navy },
  ] as TableCell[]);
  const t = performance.total;
  perfRows.push(totalRow([
    { text: t.label }, { text: '' }, { text: rp(t.apeMinor) }, { ...(pctText(t.apePct) as object), alignment: 'center' },
    { text: figureText(t.activeAgents), alignment: 'center' }, { text: figureText(t.rekrutYtd), alignment: 'center' },
  ] as TableCell[]));

  const usageRows = abGroupsOf(model).map(({ ab }) => usageRow(nameText(ab.ab!), peopleOf(ab)));
  usageRows.push(totalRow(usageRow({ text: 'Total KPM' }, model.people)));

  const powerUsers = model.people.filter((p) => p.usage.powerUser);
  const leaderOf = (p: ReportPerson): string => {
    if (p.unitHeadId && p.unitHeadId !== p.membershipId) return model.people.find((x) => x.membershipId === p.unitHeadId)?.name ?? dash;
    if (p.abId && p.abId !== p.membershipId) return model.people.find((x) => x.membershipId === p.abId)?.name ?? dash;
    return 'KPM Owner';
  };

  const never = model.people.filter((p) => p.coaching.status === 'never');
  const lapsed = model.people.filter((p) => p.coaching.status === 'lapsed');
  const recent = model.people.filter((p) => p.coaching.status === 'recent');
  const n = members.total;
  const sudah = (y: number): Content => ({ text: [{ text: num(y), color: C.green }, ' sudah · ', { text: num(n - y), color: C.red }, ' belum'], bold: true, color: C.navy });

  return newPage([
    top(model, 'Periode'),
    chapter('KPM Overview', 'Performa vs target, pemakaian, coaching — sama dengan halaman KPM Overview'),
    h3(`Performa vs target per AB group · ${month}`),
    ...(performance.held ? [] : [legend(`Data produksi ${month} belum diunggah: APE dan Active Agent ditulis –.`)]),
    list(
      [th('AB group'), th('Informal group'), th('APE'), th('% target', 'center'), th('Active Agent', 'center'), th('Rekrut YTD', 'center')],
      perfRows, [120, '*', 92, 50, 62, 58],
    ),
    h3('Pemakaian per AB group'),
    list(
      [th('AB group'), th('Anggota', 'center'), th('Pernah pakai', 'center'), th('Pakai 14 hari terakhir', 'center'), th('Power user', 'center'), th('Belum pernah', 'center')],
      usageRows, ['*', 50, 72, 88, 72, 50],
    ),
    titledTiles('Pemakaian: sudah vs belum', [
      { label: 'Pernah pakai', value: sudah(funnel.everUsed.count), line: `${funnel.everUsed.pct ?? 0}% dari ${n} anggota` },
      { label: 'Pakai 14 hari terakhir', value: sudah(funnel.used14.count), line: `${funnel.used14.pct ?? 0}% dari ${n} anggota` },
      { label: 'Power user', value: sudah(funnel.powerUsers.count), line: `${funnel.powerUsers.pct ?? 0}% dari ${n} anggota` },
    ], 3),
    h3(`Power user · ${powerUsers.length} orang`),
    powerUsers.length === 0
      ? legend('Belum ada power user.')
      : list([th('Nama'), th('Leader'), th('Group')], powerUsers.map((p) => [nameText(p), { text: leaderOf(p), color: C.navy }, { text: p.groupName ?? NO_GROUP, color: C.navy }] as TableCell[]), ['*', '*', '*']),
    legend('Status per orang (pakai, power user, compliance): halaman Compliance › Status per orang.'),
    titledTiles(`Aktivitas & leads · ${month}`, [
      { label: 'Jumlah aktivitas', value: num(activity.total), line: { text: ['dicatat bulan ini', ...deltaRun(deltaOf(activity.total, activity.previousTotal), prev)], fontSize: T.SMALL, color: C.grey } },
      { label: 'Rata-rata aktivitas', value: n === 0 ? dash : formatNumber(activity.total / n, 1, 'id'), line: 'per anggota' },
      {
        label: 'Total leads aktif', value: num(activity.leadsSales + activity.leadsRecruit),
        line: { text: [`Sales ${num(activity.leadsSales)} · Rekrut ${num(activity.leadsRecruit)}`, ...deltaRun(deltaOf(activity.leadsSales + activity.leadsRecruit, activity.previousLeads), prev)], fontSize: T.SMALL, color: C.grey },
      },
      {
        label: 'Tanpa aktivitas', value: num(activity.withoutActivity), valueColour: C.red,
        line: { text: ['orang bulan ini', ...deltaRun(deltaOf(activity.withoutActivity, activity.previousWithout), prev, false)], fontSize: T.SMALL, color: C.grey },
      },
    ], 4),
    titledTiles(`Active Agent & Rekrut · ${month}`, [
      { label: 'Potensi Active Agent', value: num(activeAgents.potensi), line: { text: ['belum closing bulan ini', ...deltaRun(deltaOf(activeAgents.potensi, activeAgents.previousPotensi), prev)], fontSize: T.SMALL, color: C.grey } },
      {
        label: 'Jadi Active Agent', value: activeAgents.count === null ? dash : num(activeAgents.count), valueColour: C.green,
        line: { text: [activeAgents.target === null ? 'belum ada target' : `dari target ${activeAgents.target}`, ...deltaRun(deltaOf(activeAgents.count, activeAgents.previousCount), prev)], fontSize: T.SMALL, color: C.grey },
      },
      {
        label: 'Rekrut bulan ini', value: num(activeAgents.recruitsMonth),
        line: { text: [activeAgents.recruitsMonthTarget === null ? 'belum ada target' : `target ${activeAgents.recruitsMonthTarget}`, ...deltaRun(deltaOf(activeAgents.recruitsMonth, activeAgents.previousRecruitsMonth), prev)], fontSize: T.SMALL, color: C.grey },
      },
      { label: 'Rekrut YTD', value: num(activeAgents.recruitsYtd), line: activeAgents.recruitsYtdTarget === null ? 'belum ada target' : `dari target ${activeAgents.recruitsYtdTarget}` },
    ], 4),
    { text: `Yang sudah ACTIVE · ${model.people.filter((p) => p.activeAgent === true).length} orang`, bold: true, fontSize: T.SMALL, color: C.green, margin: [0, 2, 0, 0] } as Content,
    activeAgents.held ? nameTree(model.groups, (p) => p.activeAgent === true) : legend(`Data produksi ${month} belum diunggah.`),
    { text: `POTENSI active · ${activeAgents.potensi} orang`, bold: true, fontSize: T.SMALL, color: C.yellow } as Content,
    nameTree(model.groups, (p) => p.potensi),
    { text: `REKRUT ${model.month.slice(0, 4)} · ${activeAgents.recruits.length} orang`, bold: true, fontSize: T.SMALL, color: C.navy } as Content,
    activeAgents.recruits.length === 0
      ? legend('Belum ada rekrut tahun ini.')
      : list(
        [th('Nama rekrut'), th('Direkrut oleh'), th('Bergabung', 'center')],
        activeAgents.recruits.map((r) => [
          nameText({ name: r.name, role: 'agent' }),
          r.recruiter ? nameText(r.recruiter) : { text: dash, color: C.grey },
          { text: formatDate(r.joinDate, 'id'), alignment: 'center', color: C.navy },
        ] as TableCell[]),
        ['*', '*', 90],
      ),
    legend('Pernah pakai = pernah mencatat aktivitas · Pakai 14 hari terakhir = mencatat aktivitas dalam 14 hari terakhir · Power user = aktivitas minimal 10 hari dari 30 hari terakhir'),
    titledTiles('Coaching 1-on-1', [
      { label: 'Dicoaching ≤ 14 hari', value: `${recent.length} dari ${n}`, line: `${pctOf(recent.length, n) ?? 0}%`, pct: pctOf(recent.length, n) },
      { label: 'Lebih dari 14 hari', value: num(lapsed.length), line: 'perlu dijadwalkan ulang', pct: pctOf(lapsed.length, n), tone: 'yellow' },
      { label: 'Belum pernah coaching', value: num(never.length), line: `termasuk ${never.filter((p) => p.role !== 'agent').length} leader`, pct: pctOf(never.length, n), tone: 'red' },
    ], 3),
    titledTiles('Pemakaian per informal group', model.groups.filter((g) => g.abGroups.length > 0).map((g) => {
      const people = g.abGroups.flatMap(peopleOf);
      const used = people.filter((p) => p.usage.recent14).length;
      return {
        label: groupName(g),
        value: `${used} dari ${people.length}`,
        line: `pakai 14 hari terakhir · ${people.filter((p) => p.usage.powerUser).length} power user`,
        pct: pctOf(used, people.length),
      };
    }), 3),
  ]);
}

// ------------------------------------------------------------------------------------------------ 4 · Compliance

function compliance(model: KpmReportModel): Content[] {
  const year = model.asOf.slice(0, 4);
  const nps = model.npsPeriod ? periodLabel(model.npsPeriod) : null;
  const items = model.compliance.map((c) => {
    const w = COMPLIANCE_WORDS[c.key];
    const pct = pctOf(c.done, c.of);
    return {
      label: w.name,
      value: { text: [{ text: `${c.done} dari ${c.of}  `, bold: true, color: C.navy }, pctText(pct, { fontSize: T.SMALL })] } as Content,
      line: `${w.unit} · ${w.line(year, nps)}`,
      pct,
    } satisfies Tile;
  });
  // Each column as wide as its longest header word at 9 pt bold (measured with the file's own fonts), so none breaks.
  const WIDTH: Record<string, number> = { goals: 37, activity: 41, leads: 28, activation: 46, events: 34, campaigns: 51 };
  const columns = [
    { head: 'Pakai 14 hari', width: 28, cell: (p: ReportPerson) => mark(p.usage.recent14) },
    { head: 'Power user', width: 32, cell: (p: ReportPerson) => (p.usage.powerUser ? { text: '★', bold: true, color: C.green } : { text: dash, color: C.grey }) as TableCell },
    ...(['goals', 'activity', 'leads', 'activation', 'events', 'campaigns'] as const).map((key) => ({
      head: COMPLIANCE_WORDS[key].column, width: WIDTH[key], cell: (p: ReportPerson) => mark(p.compliance[key]),
    })),
    { head: 'Coaching', width: 46, cell: (p: ReportPerson) => mark(p.coaching.status === 'recent') },
    { head: 'NPS', width: 20, cell: (p: ReportPerson) => mark(p.nps) },
  ];
  return newPage([
    top(model, 'Periode'),
    chapter(`Compliance · ${model.compliance.length} item`, 'Sama dengan KPM Overview › Compliance; per item: siapa yang belum, nama per nama'),
    tiles(items, 4),
    { ...(chapter('Status per orang', 'Semua anggota · ✓ SUDAH · ✗ BELUM · – tidak berlaku · urutan informal group → AB group → unit') as object), margin: [0, 10, 0, 6] } as Content,
    personTable(model.groups, columns, () => true, { compact: true }),
    legend('Activation hanya untuk agent baru (90 hari); Events hanya untuk yang diundang; – = tidak berlaku. Definisi tiap item: halaman Compliance.'),
  ]);
}

// ------------------------------------------------------------------------------------------------ 5 · per AB group

function abGroupPages(model: KpmReportModel): Content[] {
  const prev = previousMonthShort(model.month);
  void prev;
  return abGroupsOf(model).flatMap(({ group, ab }) => {
    const head = ab.ab!;
    const people = peopleOf(ab);
    const n = people.length;
    const row = model.performance.rows.find((r) => r.abId === head.membershipId);
    const card: Content = {
      table: {
        widths: ['*'],
        body: [[{
          stack: [
            {
              columns: [
                {
                  width: '*',
                  stack: [
                    nameText(head, { fontSize: T.H2 }),
                    { text: [{ text: 'Informal group ', color: C.grey }, { text: groupName(group), bold: true, color: C.navy }, { text: ` · ${n} orang · ${ab.units.length} unit`, color: C.grey }], fontSize: T.SMALL },
                  ],
                },
                { width: 120, text: `Halaman ini bisa dikirim langsung ke ${firstName(head.name)}`, fontSize: T.SMALL, color: C.grey, alignment: 'right' },
              ],
              margin: [0, 0, 0, 6],
            },
            tilesInCard([
              { label: 'Pakai 14 hari terakhir', value: `${people.filter((p) => p.usage.recent14).length} / ${n}` },
              { label: 'Dicoaching ≤ 14 hari', value: `${people.filter((p) => p.coaching.status === 'recent').length} / ${n}` },
              { label: 'APE vs target', value: row?.apePct === null || row?.apePct === undefined ? dash : `${row.apePct}%` },
              { label: 'Active Agent', value: row ? figureText(row.activeAgents) : dash },
            ]),
          ],
        }]],
      },
      layout: {
        hLineWidth: () => 1.2, vLineWidth: () => 1.2, hLineColor: () => C.navy, vLineColor: () => C.navy,
        paddingLeft: () => 10, paddingRight: () => 10, paddingTop: () => 8, paddingBottom: () => 8,
      },
      margin: [0, 0, 0, 8],
      unbreakable: true,
    } as Content;

    const body: TableCell[][] = [];
    for (const unit of ab.units) {
      body.push([{ text: `Unit ${unit.role.toUpperCase()} ${unit.people[0].name} · ${unit.people.length} orang`, colSpan: 8, bold: true, fontSize: T.SMALL, color: C.navy, fillColor: C.head }, '', '', '', '', '', '', ''] as TableCell[]);
      for (const p of unit.people) {
        const pct = p.goalMinor ? pctOf(p.ytdMinor ?? 0, p.goalMinor) : null;
        const isHead = p.membershipId === unit.headId;
        body.push([
          { text: [nameText(p), ...(p.usage.powerUser ? [{ text: '  ★ Power user', bold: true, color: C.green, fontSize: T.SMALL }] : [])], margin: [isHead ? 0 : 10, 0, 0, 0] },
          { text: p.goalMinor ? formatNumber(Math.round(p.goalMinor / 100), undefined, 'id') : 'Belum isi', alignment: 'center', color: p.goalMinor ? C.navy : C.red, bold: !p.goalMinor },
          { text: p.ytdMinor === null ? dash : formatNumber(Math.round(p.ytdMinor / 100), undefined, 'id'), alignment: 'center', color: C.navy },
          { ...(pctText(pct) as object), alignment: 'center' },
          { text: num(p.activities), alignment: 'center', color: C.navy },
          { text: `${num(p.leads.sales)} · ${num(p.leads.recruit)}`, alignment: 'center', color: C.navy },
          {
            text: p.usage.days === null ? 'Belum pernah' : sinceWords(model, p.usage.days),
            alignment: 'center', bold: !p.usage.recent14, color: p.usage.recent14 ? C.navy : C.red,
          },
          {
            text: p.coaching.days === null ? 'Belum' : sinceWords(model, p.coaching.days),
            alignment: 'center', bold: true,
            color: p.coaching.status === 'never' ? C.red : p.coaching.status === 'lapsed' ? C.yellow : C.green,
          },
        ] as TableCell[]);
        const chips = REPORT_ACTIONS.filter((a) => a.applies(p));
        body.push([
          '',
          {
            colSpan: 7,
            text: chips.length === 0
              ? [{ text: 'Semua beres', color: C.grey }]
              : chips.flatMap((a, i) => [
                ...(i > 0 ? [{ text: '   ' }] : []),
                { text: ` ${a.chip ? a.chip(p) : a.label} `, bold: true, fontSize: T.SMALL, color: TONE_COLOURS[a.tone].fg, background: TONE_COLOURS[a.tone].bg },
              ]),
            fontSize: T.SMALL,
          },
          '', '', '', '', '', '',
        ] as TableCell[]);
      }
    }
    const goal = people.reduce((s, p) => s + (p.goalMinor ?? 0), 0);
    const ytd = people.reduce((s, p) => s + (p.ytdMinor ?? 0), 0);
    body.push(totalRow([
      { text: 'Total AB group' },
      { text: formatNumber(Math.round(goal / 100), undefined, 'id'), alignment: 'center', fontSize: T.SMALL },
      { text: formatNumber(Math.round(ytd / 100), undefined, 'id'), alignment: 'center', fontSize: T.SMALL },
      { ...(pctText(goal > 0 ? pctOf(ytd, goal) : null) as object), alignment: 'center' },
      { text: num(people.reduce((s, p) => s + p.activities, 0)), alignment: 'center' },
      { text: `${num(people.reduce((s, p) => s + p.leads.sales, 0))} · ${num(people.reduce((s, p) => s + p.leads.recruit, 0))}`, alignment: 'center' },
      { text: `${people.filter((p) => p.usage.recent14).length} aktif`, alignment: 'center' },
      { text: `${people.filter((p) => p.coaching.status === 'recent').length} ≤14 hr`, alignment: 'center' },
    ] as TableCell[]));
    return newPage([
      top(model, `Untuk ${head.name}`),
      card,
      h3('Anggota · nama per nama'),
      {
        table: {
          headerRows: 1,
          dontBreakRows: true,
          widths: ['*', 68, 68, 34, 46, 46, 52, 50],
          body: [
            [th('Nama'), ...[`Goal APE ${model.month.slice(0, 4)}`, 'Capaian YTD', '%', 'Aktivitas bulan ini', 'Leads aktif Sales · Rekrut', 'Terakhir pakai', 'Coaching']
              .map((h) => ({ text: h, bold: true, fontSize: T.TH, color: C.headInk, alignment: 'center' }) as TableCell)],
            ...body,
          ],
        },
        layout: { ...LIST_LAYOUT, paddingLeft: () => 3, paddingRight: () => 3 },
      } as Content,
      legend(`Baris kedua tiap orang: yang perlu dilakukan (merah = segera · kuning = minggu ini · hijau = peluang). Goal dan capaian dalam rupiah. Aktivitas = dicatat bulan ini. Leads aktif = belum selesai. Terakhir pakai dan coaching dihitung per ${formatDate(model.asOf, 'id')}.`),
    ]);
  });
}

/** Tiles inside the AB group's card: no border of their own, a light fill. */
function tilesInCard(items: { label: string; value: string }[]): Content {
  return {
    columnGap: 6,
    columns: items.map((t) => ({
      table: {
        widths: ['*'],
        body: [[{ stack: [{ text: t.label, bold: true, fontSize: T.SMALL, color: C.grey }, { text: t.value, bold: true, fontSize: T.TILE, color: C.navy }] }]],
      },
      layout: {
        hLineWidth: () => 0.8, vLineWidth: () => 0.8, hLineColor: () => C.line, vLineColor: () => C.line,
        paddingLeft: () => 7, paddingRight: () => 7, paddingTop: () => 5, paddingBottom: () => 5,
      },
    })),
  } as Content;
}

// ------------------------------------------------------------------------------------------------ 6 · Lampiran

function appendixHead(model: KpmReportModel, name: string, sub: string, breakBefore = true): Content[] {
  const nodes: Content[] = breakBefore
    ? [top(model, 'Lampiran'), chapter(`Lampiran · Advanced analytics · ${name}`, sub)]
    : [{ ...(chapter(`Lampiran · Advanced analytics · ${name}`, sub) as object), margin: [0, 16, 0, 8] } as Content];
  return breakBefore ? newPage(nodes) : nodes;
}

/** A share bar of parts, one row of a 100% stack: each part's share written in it. */
function stackRow(parts: { label: string; count: number }[], total: number, colours: string[]): Content {
  const shown = parts.filter((p) => p.count > 0);
  if (total === 0 || shown.length === 0) return legend('Belum ada data.');
  return {
    table: {
      widths: shown.map((p) => `${Math.max(4, (p.count / total) * 100)}%`),
      body: [shown.map((p) => {
        const i = parts.indexOf(p);
        const share = pctOf(p.count, total) ?? 0;
        const fill = colours[i % colours.length];
        const light = fill === '#D9D6CE' || fill === '#AEB6CF' || fill === '#F5C79E' || fill === '#C9B6E8' || fill === '#97C459';
        return { text: share >= 9 ? `${share}%` : '', fontSize: T.SMALL, bold: true, color: light ? C.ink : C.white, fillColor: fill, alignment: 'center' };
      })],
    },
    layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 2, paddingBottom: () => 2 },
    margin: [0, 0, 0, 2],
  } as Content;
}

function stackLegend(parts: { label: string; count: number }[], colours: string[]): Content {
  return {
    text: parts.flatMap((p, i) => [{ text: '■ ', color: colours[i % colours.length] }, { text: `${p.label} ${p.count}   `, color: C.grey }]),
    fontSize: T.SMALL,
    margin: [0, 0, 0, 6],
  } as Content;
}

function demographics(model: KpmReportModel): Content[] {
  const d = model.appendix.demographics;
  if (!d) return [];
  const label = (k: string, from?: number | null, to?: number | null, own?: string) => {
    if (own) return own;
    if (DEMOGRAPHIC_WORDS[k]) return DEMOGRAPHIC_WORDS[k];
    if (from !== undefined || to !== undefined) return from === null ? `< ${to} tahun` : to === null ? `> ${from} tahun` : `${from}–${to} tahun`;
    return k;
  };
  const part = (rows: { key: string; count: number; from?: number | null; to?: number | null; label?: string }[]) =>
    rows.map((r) => ({ label: label(r.key, r.from, r.to, r.label), count: r.count }));
  const blocks: [string, { label: string; count: number }[], string[]][] = [
    ['Peran', part(d.role), ['#1B2B4B', '#41506E', '#AEB6CF', '#D9D6CE']],
    ['Status kerja', part(d.workStatus), ['#3B6D11', '#97C459', '#D9D6CE']],
    ['Lama di KPM', part(d.tenureBand), ['#F5C79E', '#E8873A', '#B85E1C', '#7A3A0E', '#D9D6CE']],
    ['Usia', part(d.ageBand), ['#C9B6E8', '#8E6CC7', '#5B3F94', '#D9D6CE']],
    ['Jenis kelamin', part(d.gender), ['#1B2B4B', '#E8873A', '#D9D6CE']],
  ];
  return [
    ...appendixHead(model, 'Demografi KPM', 'Komposisi anggota dari data profil'),
    tiles([
      { label: 'Total manpower', value: num(d.manpower), line: `${model.members.leaders} leader · ${model.members.agents} agent` },
      { label: 'Data profil lengkap', value: `${d.complete} dari ${d.manpower}`, line: `${d.completePct ?? 0}%`, pct: d.completePct },
      { label: 'Perlu melengkapi', value: num(d.incomplete), line: 'tanggal lahir, status kerja, bulan bergabung' },
    ], 3),
    ...blocks.flatMap(([title, parts, colours]) => [h3(title), stackRow(parts, d.manpower, colours), stackLegend(parts, colours)]),
    h3('Perlu melengkapi data · nama per nama'),
    d.missing.size === 0
      ? legend('Semua data profil sudah lengkap.')
      : personTable(model.groups, [{
        head: 'Belum diisi',
        width: 200,
        cell: (p) => ({ text: (d.missing.get(p.membershipId) ?? []).map((f) => FIELD_WORDS[f] ?? f).join(' · '), color: C.red, alignment: 'left' }) as TableCell,
      }], (p) => d.missing.has(p.membershipId)),
  ];
}

function mapa(model: KpmReportModel): Content[] {
  const m = model.appendix.mapa;
  if (!m) return [];
  const [y, mm] = model.month.split('-');
  const prevYear = String(Number(y) - 1);
  const short = monthLong(model.month).split(' ')[0].slice(0, 3);
  const value = (unit: string, v: number | null) => {
    if (v === null) return dash;
    if (unit === 'idr_minor') return formatNumber(v / 100 / 1_000_000, 1, 'id');
    if (unit === 'percentage') return `${formatNumber(v, 0, 'id')}%`;
    return formatNumber(v, unit === 'ratio' || !Number.isInteger(v) ? 1 : undefined, 'id');
  };
  const change = (unit: string, now: number | null, before: number | null): TableCell => {
    if (now === null || before === null) return { text: dash, color: C.grey, alignment: 'center' } as TableCell;
    const points = unit === 'percentage';
    const diff = points ? now - before : before === 0 ? null : ((now - before) / Math.abs(before)) * 100;
    if (diff === null) return { text: dash, color: C.grey, alignment: 'center' } as TableCell;
    const rounded = Math.round(diff);
    const words = rounded === 0 ? `0${points ? ' poin' : '%'}` : `${rounded > 0 ? '▲' : '▼'} ${Math.abs(rounded)}${points ? ' poin' : '%'}`;
    return { text: words, bold: true, alignment: 'center', color: rounded > 0 ? C.green : rounded < 0 ? C.red : C.grey } as TableCell;
  };
  const head = (label: string, f: ReportFigure, unit: 'idr_minor' | 'count'): Tile => {
    const pct = f.value === null || f.target === null ? null : pctOf(f.value, f.target);
    return {
      label,
      value: f.value === null ? dash : unit === 'idr_minor' ? rp(f.value) : f.target === null ? num(f.value) : `${num(f.value)} dari ${num(f.target)}`,
      line: f.target === null ? 'belum ada target' : `${pct ?? 0}% dari target${unit === 'idr_minor' ? ` ${rp(f.target)}` : ''}`,
      pct,
    };
  };
  void mm;
  return [
    ...appendixHead(model, 'MAPA driver', 'Manpower · Activation · Productivity · Average case size'),
    tiles([head('APE bulan ini', m.headline.ape, 'idr_minor'), head('Active Agent', m.headline.activeAgent, 'count'), head('Rekrut', m.headline.rekrut, 'count')], 3),
    h3('Metrik MAPA'),
    list(
      [th('Metrik'), th(`YTD ${prevYear}`, 'center'), th(`YTD ${y}`, 'center'), th('', 'center'), th(`${short} ${prevYear}`, 'center'), th(`${short} ${y}`, 'center'), th('', 'center'), th('Target bulanan', 'center')],
      m.rows.map((r) => [
        { text: MAPA_WORDS[r.key] ?? r.key, bold: true, color: C.navy },
        { text: value(r.unit, r.ytdLastYear), alignment: 'center', color: C.navy },
        { text: value(r.unit, r.ytd), alignment: 'center', bold: true, color: C.navy },
        change(r.unit, r.ytd, r.ytdLastYear),
        { text: value(r.unit, r.sameMonthLastYear), alignment: 'center', color: C.navy },
        { text: value(r.unit, r.thisMonth), alignment: 'center', bold: true, color: C.navy },
        change(r.unit, r.thisMonth, r.sameMonthLastYear),
        { text: value(r.unit, r.target), alignment: 'center', color: C.grey },
      ] as TableCell[]),
      ['*', 50, 50, 46, 50, 50, 46, 50],
      { unbreakable: true },
    ),
  ];
}

function npsPart(model: KpmReportModel): Content[] {
  const s = model.appendix.nps;
  if (!s) return [];
  const notAnswered = model.people.filter((p) => p.nps === false);
  const lowest = s.lines.slice(1).filter((l) => l.score !== null).sort((a, b) => (a.score ?? 0) - (b.score ?? 0)).slice(0, 2);
  const shares = (sh: { promoterPct: number; passivePct: number; detractorPct: number } | null): TableCell => {
    if (!sh) return { text: dash, color: C.grey } as TableCell;
    const parts = [
      { pct: sh.promoterPct, fill: '#2E7D4F', ink: C.white },
      { pct: sh.passivePct, fill: '#F2C14E', ink: C.ink },
      { pct: sh.detractorPct, fill: C.red, ink: C.white },
    ].filter((p) => p.pct > 0);
    return {
      table: {
        widths: parts.map((p) => `${Math.max(6, p.pct)}%`),
        body: [parts.map((p) => ({ text: p.pct >= 9 ? `${p.pct}%` : '', fontSize: T.SMALL, bold: true, color: p.ink, fillColor: p.fill, alignment: 'center' }))],
      },
      layout: { hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 1, paddingBottom: () => 1 },
    } as TableCell;
  };
  return [
    ...appendixHead(model, 'NPS', `Survei ${periodLabel(s.period)} · ${s.sent} dari ${s.invited} menjawab (${pctOf(s.sent, s.invited) ?? 0}%) · ${s.leaders} leader, ${s.agents} agent`, false),
    list(
      [th('Pertanyaan'), th('NPS', 'center'), th('vs periode lalu', 'center'), th('Promoter · Passive · Detractor')],
      s.lines.map((l) => [
        { text: l.text, bold: true, color: C.navy },
        { text: l.score === null ? dash : `${l.score > 0 ? '+' : ''}${l.score}`, bold: true, alignment: 'center', color: C.navy },
        l.change === null
          ? { text: dash, color: C.grey, alignment: 'center' }
          : { text: `${l.change > 0 ? '▲' : l.change < 0 ? '▼' : '='} ${Math.abs(l.change)} poin`, bold: true, alignment: 'center', color: l.change > 0 ? C.green : l.change < 0 ? C.red : C.grey },
        shares(l.shares),
      ] as TableCell[]),
      ['*', 40, 70, 170],
    ),
    legend('Promoter ■ hijau · Passive ■ kuning · Detractor ■ merah. NPS = % promoter − % detractor.'),
    ...lowest.flatMap((l, i) => [
      h3(`Kenapa · ${l.text}${i === 0 ? ' (terendah)' : ''}`),
      ...(l.reasons.length === 0
        ? [legend('Belum ada alasan tertulis.')]
        : [list(
          [th('Peran'), th('Alasan')],
          l.reasons.slice(0, 6).map((q) => [
            { text: q.who === 'leader' ? 'Leader' : q.who === 'agent' ? 'Agent' : dash, bold: true, color: C.navy },
            { text: q.text, italics: false, color: C.ink },
          ] as TableCell[]),
          [60, '*'],
        )]),
    ]),
    h3(`Belum mengisi survei · ${notAnswered.length} orang`),
    notAnswered.length === 0
      ? legend('Semua yang diundang sudah mengisi.')
      : personTable(model.groups, [{ head: 'Survei NPS', width: 90, cell: () => ({ text: '✗ BELUM', bold: true, color: C.red }) as TableCell }], (p) => p.nps === false),
  ];
}

function quantPart(model: KpmReportModel): Content[] {
  const q = model.appendix.quant;
  if (!q) return [];
  const text = (code: string, v: number | null) => {
    if (v === null) return dash;
    if (code === 'B1' || code === 'B2' || code === 'B3') return `${formatNumber(v, 0, 'id')}%`;
    if (code === 'D1') return formatNumber(v / 100 / 1_000_000, 1, 'id');
    if (code === 'A2') return `${v > 0 ? '+' : ''}${formatNumber(v, 1, 'id')}`;
    return formatNumber(v, Number.isInteger(v) ? undefined : 1, 'id');
  };
  const count = (s: 'above' | 'in_line' | 'below') => q.metrics.filter((m) => m.status === s).length;
  const statusTone: Record<string, ReportTone> = { above: 'green', in_line: 'yellow', below: 'red' };
  return [
    ...appendixHead(model, 'Analisa kuantitatif', `KPM dibanding median KPM sejenis (peers) dan semester lalu · ${q.fromMonth ? `${monthLong(q.fromMonth)} – ` : ''}${monthLong(q.periodEnd)}`),
    tiles([
      { label: PEER_WORDS.above, value: num(count('above')), valueColour: C.green },
      { label: PEER_WORDS.in_line, value: num(count('in_line')), valueColour: C.yellow },
      { label: PEER_WORDS.below, value: num(count('below')), valueColour: C.red },
    ], 3),
    list(
      [th(''), th('Metrik'), th('KPM Anda', 'center'), th('Median peers', 'center'), th('Semester lalu', 'center'), th('Posisi')],
      q.metrics.map((m) => [
        { text: m.code, bold: true, color: C.navy },
        { text: QUANT_WORDS[m.code] ?? m.code, color: C.navy },
        { text: text(m.code, m.value), bold: true, alignment: 'center', color: C.navy },
        { text: text(m.code, m.median), alignment: 'center', color: C.navy },
        { text: text(m.code, m.previous), alignment: 'center', color: C.navy },
        m.status === null
          ? { text: dash, color: C.grey }
          : { text: ` ${PEER_WORDS[m.status]} `, bold: true, color: TONE_COLOURS[statusTone[m.status]].fg, background: TONE_COLOURS[statusTone[m.status]].bg },
      ] as TableCell[]),
      [22, '*', 54, 60, 60, 80],
    ),
  ];
}

function qualPart(model: KpmReportModel): Content[] {
  const q = model.appendix.qual;
  if (!q) return [];
  const issueTone = (pct: number | null): ReportTone | null => (pct === null ? null : toneOf(100 - pct));
  const answered = model.people.filter((p) => q.people.has(p.membershipId));
  return [
    ...appendixHead(model, 'Analisa kualitatif', `Semua item per area · % bermasalah = nilai 1–3 atau tidak konsisten · ${q.respondents} dari ${q.invited} menjawab · ${periodLabel(q.period)}`),
    ...q.blocks.flatMap((b) => [
      h3(`${b.title} · N = ${b.respondents}`),
      list(
        [th(`Item (${b.rows.length})`), th('% bermasalah', 'center'), th('Sem. lalu', 'center')],
        b.rows.map((r, i) => {
          const tone = issueTone(r.issuePct);
          return [
            { text: [{ text: `${i + 1}. `, color: C.grey }, { text: r.label, color: C.navy }] },
            r.issuePct === null
              ? { text: dash, color: C.grey, alignment: 'center' }
              : { text: ` ${r.issuePct}% `, bold: true, alignment: 'center', color: tone ? TONE_COLOURS[tone].fg : C.navy, background: tone ? TONE_COLOURS[tone].bg : undefined },
            {
              text: r.previousPct === null ? dash : `${r.previousPct}%${r.issuePct !== null && r.issuePct > r.previousPct ? ' ▲' : r.issuePct !== null && r.issuePct < r.previousPct ? ' ▼' : ''}`,
              alignment: 'center', color: r.previousPct === null ? C.grey : r.issuePct !== null && r.issuePct > r.previousPct ? C.red : r.issuePct !== null && r.issuePct < r.previousPct ? C.green : C.grey,
            },
          ] as TableCell[];
        }),
        ['*', 80, 70],
      ),
    ]),
    legend('Warna % bermasalah memakai skala yang sama dibalik: hijau ≤ 20% bermasalah, kuning 21–50%, merah > 50%. ▲ = lebih banyak masalah dari semester lalu.'),
    h3('Siapa bermasalah · per orang'),
    answered.length === 0
      ? legend('Jawaban per orang tidak disimpan untuk survei ini.')
      : personTable(model.groups, [
        {
          head: 'Menjawab', width: 64,
          cell: (p) => (q.people.get(p.membershipId)?.answered
            ? { text: '✓ SUDAH', bold: true, color: C.green }
            : { text: '✗ BELUM', bold: true, color: C.red }) as TableCell,
        },
        {
          head: 'Item bermasalah', width: 70,
          cell: (p) => {
            const n = q.people.get(p.membershipId)?.issues ?? null;
            return (n === null ? { text: dash, color: C.grey } : { text: num(n), bold: true, color: n >= KPM_REPORT.QUAL_MANY_ISSUES ? C.red : C.navy }) as TableCell;
          },
        },
      ], (p) => q.people.has(p.membershipId)),
  ];
}

function informalPart(model: KpmReportModel): Content[] {
  const inf = model.appendix.informal;
  if (!inf) return [];
  const figure = (f: ReportFigure, digits?: number): TableCell => {
    if (f.value === null) return { text: dash, color: C.grey, alignment: 'center' } as TableCell;
    const value = formatNumber(f.value, digits, 'id');
    const pct = f.target === null ? null : pctOf(f.value, f.target);
    return {
      text: [{ text: f.target === null ? value : `${value} / ${formatNumber(f.target, digits, 'id')}`, color: C.navy }, ...(pct === null ? [] : ['  ', pctText(pct)])],
      alignment: 'center',
    } as TableCell;
  };
  return [
    ...appendixHead(model, 'Informal group', 'Driver per informal group dan AB group · sama dengan Advanced analytics › Informal group', false),
    ...inf.groups.filter((g) => g.rows.length > 0).flatMap((g) => [
      { text: groupName(g), bold: true, color: C.white, background: C.navy, fontSize: T.BODY, margin: [0, 4, 0, 2] } as Content,
      list(
        [th('AB group'), th('Anggota', 'center'), th('Monthly Active Agent', 'center'), th('Pemakaian', 'center'), th('1-on-1 per minggu', 'center'), th('Rekrut YTD', 'center')],
        g.rows.map((r) => [
          nameText({ name: r.label, role: 'ab' }),
          { text: num(r.people), alignment: 'center', color: C.navy },
          figure(r.maa),
          { ...(pctText(r.usagePct) as object), alignment: 'center' },
          figure(r.oneOnOne, 1),
          figure(r.rekrut),
        ] as TableCell[]),
        ['*', 46, 96, 62, 92, 80],
      ),
    ]),
    legend('Target 1-on-1 per minggu = 2 × target Active Agent. Pemakaian = pakai dalam 30 hari terakhir.'),
  ];
}

function eventsPart(model: KpmReportModel): Content[] {
  const ev = model.appendix.events;
  if (!ev) return [];
  const per = KPM_REPORT.EVENT_COLUMNS_PER_TABLE;
  const chunks: typeof ev.list[] = [];
  for (let i = 0; i < ev.list.length; i += per) chunks.push(ev.list.slice(i, i + per));
  const average = ev.summaryPct === null ? '' : ` · rata-rata kehadiran ${ev.summaryPct}%`;
  return [
    ...appendixHead(model, 'Event', `Semua event ${monthLong(model.month)}: kehadiran dan feedback${average} · sama dengan Advanced analytics › Event`, false),
    list(
      [th('Event'), th('Tanggal', 'center'), th('Hadir', 'center'), th('NPS', 'center')],
      ev.list.map((e) => [
        { text: e.title, bold: true, color: C.navy },
        { text: formatDate(e.startsOn, 'id'), alignment: 'center', color: C.navy },
        e.attended === null || e.audience === null
          ? { text: 'Belum dicatat', alignment: 'center', color: C.grey }
          : { text: [pctText(e.pct), { text: `  ${num(e.attended)} dari ${num(e.audience)}`, color: C.navy }], alignment: 'center' },
        { text: e.nps === null ? dash : `${e.nps > 0 ? '+' : ''}${e.nps} · ${e.answers} jawaban`, alignment: 'center', color: C.navy },
      ] as TableCell[]),
      ['*', 80, 110, 90],
    ),
    h3('Kehadiran per orang'),
    ...chunks.map((chunk) => personTable(
      model.groups,
      chunk.map((e) => ({
        head: e.title,
        width: 66,
        cell: (p: ReportPerson) => {
          const m = p.attendance[e.id] ?? null;
          if (m === null) return { text: dash, color: C.grey } as TableCell;
          return { text: ATTENDANCE_WORDS[m], bold: m !== 'waiting', fontSize: T.SMALL, color: m === 'attended' ? C.green : m === 'absent' ? C.red : C.grey } as TableCell;
        },
      })),
      (p) => chunk.some((e) => (p.attendance[e.id] ?? null) !== null),
    )),
    legend('✓ HADIR = dikonfirmasi hadir · ✗ Tidak hadir = diundang, tidak hadir · Belum dicatat = kehadiran belum dicatat · – = tidak diundang.'),
  ];
}

// ------------------------------------------------------------------------------------------------ the document

/** The footer's left words (§11): *"BSD City Branch · Prudential · Laporan KPM Oktober 2026"*. */
export function footerText(model: Pick<KpmReportModel, 'office' | 'month'>): string {
  return `${model.office.name} · ${model.office.company} · Laporan KPM ${monthLong(model.month)}`;
}

/** The sections a report holds, in order, by the name a test reads back. */
export function reportContent(model: KpmReportModel): Content[] {
  return [
    ...cover(model),
    ...actionsSummary(model),
    ...overview(model),
    ...compliance(model),
    ...abGroupPages(model),
    ...demographics(model),
    ...mapa(model),
    ...npsPart(model),
    ...quantPart(model),
    ...qualPart(model),
    ...informalPart(model),
    ...eventsPart(model),
  ];
}

/**
 * **The file's definition** (AC-3): A4 portrait, the app's Inter, the footer on every page, and the file's metadata —
 * its title *"Laporan KPM {KPM} {bulan}"*, the author AgencyBoost. `createdAt` is the clock's: no date is read from the
 * machine.
 */
export function kpmReportDocument(model: KpmReportModel, createdAt: Date): TDocumentDefinitions {
  const left = footerText(model);
  return {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [MARGIN, MARGIN, MARGIN, 44],
    info: {
      title: `Laporan KPM ${model.office.name} ${monthLong(model.month)}`,
      author: 'AgencyBoost',
      producer: 'AgencyBoost',
      creator: 'AgencyBoost',
      creationDate: createdAt,
    },
    defaultStyle: { font: PDF_FONTS.REGULAR, fontSize: T.BODY, color: C.ink, lineHeight: 1.15 },
    footer: (current: number, count: number) => ({
      columns: [
        { text: left, fontSize: T.SMALL, color: C.grey },
        { text: `hal. ${current} / ${count}`, fontSize: T.SMALL, bold: true, color: C.navy, alignment: 'right', width: 'auto' },
      ],
      margin: [MARGIN, 14, MARGIN, 0],
    }) as Content,
    content: reportContent(model),
  };
}

// ------------------------------------------------------------------------------------------------ the file's name

/**
 * **`Laporan-KPM-{KPM}-{YYYY-MM}.pdf`**: the KPM's name with its accents taken off, every run of characters that are not
 * letters or digits made one `-`; `ascii` the same with every character above 127 dropped, for `filename=`.
 */
export function reportFileName(kpmName: string, month: string): { name: string; ascii: string } {
  const kpm = kpmName.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'KPM';
  const name = `Laporan-KPM-${kpm}-${month}.pdf`;
  // eslint-disable-next-line no-control-regex
  return { name, ascii: name.replace(/[^\x00-\x7F]/g, '') };
}
