import { KPM_REPORT } from '@/domain/constants';
import { readPdf, type ReadPdf } from '../../../test/pdf-text';
import { AGUS, BUDI, INDAH, OSCAR, RINA, SARI, SATRIA, WINDA, YOSEF, reportModel } from '../../../test/kpm-report-fixture';
import { KpmReportBuilder } from './kpm-report.builder';
import { REPORT_COLOURS, footerText, reportFileName } from './kpm-report.layout';

/**
 * **P19.24-T1 — the KPM report's file** (ADR-0280; the approved template `laporan-kpm-template-2026-11-20`). The real
 * file, built with the real fonts from a model made by hand (`test/kpm-report-fixture.ts`), read back as a viewer reads
 * it (`test/pdf-text.ts`): every page's words, each with its size and colour.
 */
const NOW = new Date('2026-11-20T03:00:00Z');
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('P19.24-T1 the KPM report’s file', () => {
  const builder = new KpmReportBuilder();
  let pdf: ReadPdf;
  let pages: number;
  let all: string;
  const pageWith = (words: string) => pdf.pages.findIndex((p) => flat(p.text).includes(words));

  beforeAll(async () => {
    const file = await builder.build(reportModel(), NOW);
    pdf = readPdf(file.bytes);
    pages = file.pages;
    all = flat(pdf.pages.map((p) => p.text).join('\n'));
  }, 60_000);

  it('P19.24-T1 AC-3 is an A4 PDF in the app’s Inter that reads back, its pages counted from its footer', () => {
    expect(pdf.header).toBe('%PDF-1.3');
    expect(pdf.pages).toHaveLength(pages);
    expect(pages).toBeGreaterThanOrEqual(10);
    expect(pages).toBeLessThanOrEqual(30);
    expect(pdf.pages[0].width).toBeCloseTo(595.28, 1);
    const fonts = new Set(pdf.pages.flatMap((p) => p.fragments.map((f) => f.font)));
    expect([...fonts].every((f) => f.startsWith('Inter'))).toBe(true);
    expect(pdf.info.Title ?? '').toContain('Laporan KPM');
  });

  it('P19.24-T1 AC-1 holds the template’s sections in its order', () => {
    const order = [
      'Ringkasan eksekutif', '3 tindakan minggu ini', 'Jumlah orang per tindakan', 'Performa vs target, pemakaian, coaching',
      'Performa vs target per AB group',
      'Pemakaian per AB group', 'Pemakaian: sudah vs belum', 'Power user ·', 'Aktivitas & leads', 'Active Agent & Rekrut · Oktober',
      'Coaching 1-on-1', 'Pemakaian per informal group', 'Compliance · 8 item', 'urutan informal group → AB group → unit', `Untuk ${SATRIA.name}`,
      `Untuk ${AGUS.name}`, `Untuk ${YOSEF.name}`, 'Advanced analytics · Demografi KPM', 'Perlu melengkapi data',
      'Advanced analytics · MAPA driver', 'Metrik MAPA', 'Advanced analytics · NPS', 'Kenapa ·', 'Belum mengisi survei',
      'Advanced analytics · Analisa kuantitatif', 'Advanced analytics · Analisa kualitatif', 'Siapa bermasalah',
      'Advanced analytics · Informal group', 'Advanced analytics · Event', 'Kehadiran per orang',
    ];
    const at = order.map((words) => [words, all.indexOf(words)] as const);
    expect(at.filter(([, i]) => i < 0)).toEqual([]);
    for (let i = 1; i < at.length; i += 1) expect([at[i][0], at[i][1] > at[i - 1][1]]).toEqual([at[i][0], true]);
  });

  it('P19.24-T1 AC-1 leaves out the AI’s part while it is on hold (OD-358), and anything about training (§11)', () => {
    expect(all).not.toContain('Yang bisa diperbaiki');
    expect(all).not.toMatch(/\(AI\)/);
    expect(all).not.toMatch(/training|pelatihan/i);
  });

  it('P19.24-T1 AC-1 puts the executive summary on the first page alone', () => {
    expect(pageWith('Ringkasan eksekutif')).toBe(0);
    expect(pageWith('3 tindakan minggu ini')).toBe(0);
    expect(pageWith('Jumlah orang per tindakan')).toBe(1);
  });

  it('P19.24-T1 AC-2 writes the footer on every page: the KPM, its company, the month, and hal. x / n', () => {
    expect(footerText(reportModel())).toBe('BSD City Branch · Prudential · Laporan KPM Oktober 2026');
    pdf.pages.forEach((page, i) => {
      expect(flat(page.text)).toContain('BSD City Branch · Prudential · Laporan KPM Oktober 2026');
      expect(flat(page.text)).toContain(`hal. ${i + 1} / ${pages}`);
    });
  });

  it('P19.24-T1 AC-2 sets nothing smaller than 12 px (9 pt)', () => {
    const sizes = pdf.pages.flatMap((p) => p.fragments.map((f) => f.size));
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(KPM_REPORT.MIN_TEXT_PT);
  });

  it('P19.24-T1 AC-2 prints names in CAPITALS with the orange AB / AAB label, an agent with none', () => {
    expect(all).toContain(`AB ${AGUS.name}`);
    expect(all).toContain(`AAB ${SARI.name}`);
    expect(all).not.toContain(`AB ${RINA.name}`);
    const label = pdf.pages.flatMap((p) => p.fragments).find((f) => f.text.trim() === 'AAB');
    expect(label?.colour.toUpperCase()).toBe(REPORT_COLOURS.orange.toUpperCase());
  });

  it('P19.24-T1 AC-2 lists people in the fixed order: informal group → AB group → AB unit → each AAB unit → person', () => {
    const at = pageWith('urutan informal group → AB group → unit');
    const status = flat(`${pdf.pages[at].text} ${pdf.pages[at + 1]?.text ?? ''}`);
    const order = [SATRIA, OSCAR, AGUS, INDAH, SARI, BUDI, YOSEF, WINDA].map((p) => status.indexOf(p.name));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The AB unit (Agus and his own agent Indah) before the AAB unit (Sari and hers).
    expect(status.indexOf(`Unit AB ${AGUS.name}`)).toBeLessThan(status.indexOf(`Unit AAB ${SARI.name}`));
  });

  it('P19.24-T1 AC-2 says SUDAH / BELUM / HADIR in its lists, never a comma-separated list of names', () => {
    expect(all).toContain('✓ SUDAH');
    expect(all).toContain('✗ BELUM');
    expect(all).toContain('✓ HADIR');
    expect(all).toContain('Belum dicatat');
    expect(all).not.toMatch(/[A-Z]{3,} [A-Z]{3,}, [A-Z]{3,} [A-Z]{3,}/);
  });

  it('P19.24-T1 AC-2 draws ▲ / ▼ against last month on the key numbers', () => {
    // Activities 144 against 128 in September; leads 48 against 40; without activity 2 against 1.
    expect(all).toContain('▲ 16 vs Sep');
    expect(all).toContain('▲ 8 vs Sep');
    expect(all).toContain('▲ 1 vs Sep');
    // Pakai 14 hari terakhir in points, on the first page.
    expect(flat(pdf.pages[0].text)).toContain('▲ 8 poin');
  });

  it('P19.24-T1 AC-2 colours a share on the one scale: 80% green, 58% yellow, 33% red', () => {
    const fragments = pdf.pages.flatMap((p) => p.fragments);
    const colourOf = (text: string) => fragments.find((f) => f.text.trim() === text)?.colour.toUpperCase();
    expect(colourOf('80%')).toBe(REPORT_COLOURS.green.toUpperCase());
    expect(colourOf('58%')).toBe(REPORT_COLOURS.yellow.toUpperCase());
    expect(colourOf('33%')).toBe(REPORT_COLOURS.red.toUpperCase());
  });

  it('P19.24-T1 AC-1 gives each AB group a page of its own that can be sent alone', () => {
    for (const [ab, own, other] of [[SATRIA, OSCAR, BUDI], [AGUS, BUDI, OSCAR], [YOSEF, WINDA, BUDI]] as const) {
      const at = pageWith(`Untuk ${ab.name}`);
      const page = flat(pdf.pages[at].text);
      expect(page).toContain('BSD City Branch');
      expect(page).toContain(`Halaman ini bisa dikirim langsung ke ${ab.name.split(' ')[0]}`);
      expect(page).toContain(own.name);
      expect(page).not.toContain(other.name);
      // It starts its page: the AB group before it ended on an earlier one.
      expect(flat(pdf.pages[at - 1].text)).not.toContain(`Untuk ${ab.name}`);
    }
  });

  it('P19.24-T1 AC-2 names a person’s actions on their row, nothing about training among them', () => {
    const agus = flat(pdf.pages[pageWith(`Untuk ${AGUS.name}`)].text);
    expect(agus).toContain('Coaching pertama');
    expect(agus).toContain('9 masalah di Analisa kualitatif');
    expect(agus).toContain('Potensi Active Agent: dampingi closing');
  });

  it('P19.24-T1 AC-3 names the file Laporan-KPM-{KPM}-{bulan}.pdf, accents taken off', () => {
    expect(reportFileName('BSD City Branch', '2026-10')).toEqual({ name: 'Laporan-KPM-BSD-City-Branch-2026-10.pdf', ascii: 'Laporan-KPM-BSD-City-Branch-2026-10.pdf' });
    expect(reportFileName('Café Ünit', '2026-10').name).toBe('Laporan-KPM-Cafe-Unit-2026-10.pdf');
  });

  it('P19.24-T1 AC-3 builds an office with nobody in it without failing', async () => {
    const empty = reportModel({ groups: [], people: [], members: { total: 0, leaders: 0, agents: 0 } });
    const file = await builder.build({
      ...empty,
      performance: { ...empty.performance, rows: [] },
      appendix: { demographics: null, mapa: null, nps: null, quant: null, qual: null, informal: null, events: null },
    }, NOW);
    expect(readPdf(file.bytes).pages.length).toBeGreaterThanOrEqual(3);
  });
});
