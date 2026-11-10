import sharp from 'sharp';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { PROPOSAL } from '@/domain/constants';
import { contrastOnWhite, readPdf, type ReadPdf } from '../../../test/pdf-text';
import {
  DOLLAR, EDUCATION, HEALTH, KPM_BRANDING, PLAIN, WORST_AGENT, WORST_INSURER, pdfInput, proposalView, worstCase,
  type ProposalSpec,
} from '../../../test/proposal-pdf-fixtures';
import { AGENCYBOOST_PDF_BRANDING, type PdfBranding } from './proposal-branding';
import { ProposalPdfBuilder, ProposalPdfTooLong, pdfRuler, renderPdf, type RenderedPdf } from './proposal-pdf.builder';
import {
  detailValueOf, dispositionOf, inLines, levelsFrom, moneyCompact, moneyInFull, proposalDocument, proposalFileName,
  startLevelOf, usdInFull, type PdfInput, type PdfLevel,
} from './proposal-pdf.layout';

/**
 * **P19.7-T3 — the proposal's PDF, rendered and read back** (ADR-0222, ADR-0223; `functional/proposal.md`, *The PDF*).
 * Every test here builds the real file with the real fonts and reads it as a viewer would (`test/pdf-text.ts`): its
 * pages, the text on each, the size and colour of every run of text.
 */
const NOW = new Date('2026-11-05T03:00:00Z');
const builder = new ProposalPdfBuilder();

async function built(spec: ProposalSpec, over: Partial<PdfInput> = {}): Promise<ReadPdf & { level: PdfLevel; bytes: Buffer }> {
  const file = await builder.build(pdfInput(proposalView(spec), over), NOW);
  return { ...readPdf(file.bytes), level: file.level, bytes: file.bytes };
}

async function at(level: PdfLevel, spec: ProposalSpec, over: Partial<PdfInput> = {}): Promise<ReadPdf> {
  const file = await renderPdf(proposalDocument(pdfInput(proposalView(spec), over), level, pdfRuler(), NOW));
  return readPdf(file.bytes);
}

const textOf = (pdf: ReadPdf) => pdf.pages.map((p) => p.text).join('\n');
const FOOTER = 'Dibuat dengan AgencyBoost';

async function withLogo(branding: PdfBranding): Promise<PdfBranding> {
  const png = await sharp({ create: { width: 480, height: 96, channels: 4, background: '#7C3AED' } }).png().toBuffer();
  return { ...branding, logo: { png, width: 480, height: 96 } };
}

describe('P19.7-T3 the proposal’s PDF (ADR-0222, ADR-0223)', () => {
  describe('AC-8: a real file a phone opens and a printer prints', () => {
    it('P19.7-T3 AC-8 is a PDF of two A4 pages, Inter embedded, that reads back as text', async () => {
      const pdf = await built({ items: [HEALTH] });
      expect(pdf.header.startsWith('%PDF-')).toBe(true);
      expect(pdf.bytes.subarray(-6).toString('latin1')).toContain('%%EOF');
      expect(pdf.pages).toHaveLength(PROPOSAL.PDF_PAGES);
      for (const page of pdf.pages) expect(page.width).toBeCloseTo(595.28, 1);
      const fonts = new Set(pdf.pages.flatMap((p) => p.fragments.map((f) => f.font)));
      expect([...fonts].sort()).toEqual(['Inter-Bold', 'Inter-Regular', 'Inter-SemiBold']);
      expect(pdf.pages[0].text).toContain('Proposal untuk Bapak/Ibu Pak Budi Santoso');
      expect(pdf.pages[1].text).toContain('Rincian');
    });

    it('P19.7-T3 AC-8 names itself for the client and the KPM, made by AgencyBoost, naming no insurer (ADR-0222 §6)', async () => {
      const pdf = await built({ items: [HEALTH] });
      expect(pdf.info).toMatchObject({
        Title: 'Proposal untuk Bapak/Ibu Pak Budi Santoso', Author: 'KPM Cahaya Jakarta', Producer: 'AgencyBoost', Creator: 'AgencyBoost',
      });
      expect(pdf.info.CreationDate).toBe('D:20261105030000Z');
      expect(JSON.stringify(pdf.info)).not.toContain('Prudential');
    });

    it('P19.7-T3 AC-8 prints readably: nothing runs past the margins, nothing below 11 pt but the 8 pt footer (ADR-0223 §2)', async () => {
      for (const spec of [{ items: [HEALTH, EDUCATION] }, worstCase()]) {
        const pdf = await built(spec, spec.items.length > 2 ? { agent: WORST_AGENT, insurer: WORST_INSURER } : {});
        for (const page of pdf.pages) {
          for (const f of page.fragments) {
            expect([f.text, f.x >= 42.5 - 0.5, f.end <= 595.28 - 42.5 + 0.5]).toEqual([f.text, true, true]);
            if (f.text.trim() === '') continue;
            // Below 11 pt is the footer's 8 pt and nothing else.
            if (f.size < PROPOSAL.PDF_BODY_MIN_PT) expect([f.text, f.size, FOOTER.includes(f.text.trim())]).toEqual([f.text, PROPOSAL.PDF_FOOTER_PT, true]);
          }
        }
      }
    });
  });

  describe('AC-4: page 1, Ringkasan', () => {
    it('P19.7-T3 AC-4 heads with the wordmark and the date, the title, and one line of age · channel · cara bayar', async () => {
      const pdf = await built({ items: [HEALTH], payFrequency: 'quarterly' });
      const lines = pdf.pages[0].text.split('\n');
      expect(lines.slice(0, 5)).toEqual([
        'AgencyBoost',
        '5 Nov 2026',
        'Proposal untuk Bapak/Ibu Pak Budi Santoso',
        'Umur 36 (ulang tahun berikutnya) · Konvensional · Kuartalan',
        'KESEHATAN',
      ]);
    });

    it('P19.7-T3 AC-4 writes a row per product like a receipt: type, name and plan, insured, the premium, Total dibayar, the summary values', async () => {
      const pdf = await built({ items: [HEALTH, EDUCATION] });
      const page = pdf.pages[0].text;
      for (const line of [
        'KESEHATAN', 'PRUWell Medical · Gold', 'Tertanggung: Klien', 'Premi per bulan', 'Rp 1.250.000',
        'Plan Gold Masa bayar 10 tahun', 'Uang pertanggungan Rp 1 M',
        'DANA PENDIDIKAN', 'PRUCerah', 'Tertanggung: Anak Adik Raka, 8 th', 'Target dana Rp 500 Jt',
      ]) expect(page.split('\n')).toContain(line);
      // Total dibayar: the premium × 12 × the term's years, in full (§B.34).
      expect(page.replace(/\n/g, ' ')).toContain('Total dibayar selama 10 tahun: Rp 150.000.000');
      expect(page.replace(/\n/g, ' ')).toContain('Total dibayar selama 18 tahun: Rp 270.000.000');
      // Only the showOnSummary figures: Wilayah is page 2's.
      expect(page).not.toContain('Wilayah');
    });

    it('P19.7-T3 AC-4 writes Total premi only while the switch is on, one line per currency, never summed', async () => {
      const off = await built({ items: [HEALTH, DOLLAR] });
      expect(off.pages[0].text).not.toContain('Total premi');
      const on = await built({ items: [HEALTH, DOLLAR, PLAIN], showTotal: true });
      const lines = on.pages[0].text.split('\n');
      const at = lines.findIndex((l) => l.startsWith('Total premi per bulan'));
      expect(lines.slice(at, at + 3)).toEqual(['Total premi per bulan', 'Rp 2.500.000', 'USD 1.250,00']);
    });

    it('P19.7-T3 AC-4 writes the agent as text — name, Kode agen, phone — and leaves out a part the profile lacks', async () => {
      const full = await built({ items: [PLAIN] });
      expect(full.pages[0].text).toContain('Rina Wijaya\nKode agen AG-0417-001 · 0812 3456 7890');
      const noPhone = await built({ items: [PLAIN] }, { agent: { name: 'Rina Wijaya', code: 'AG-0417-001', phone: null } });
      expect(noPhone.pages[0].text).toContain('Rina Wijaya\nKode agen AG-0417-001\n');
      const nameOnly = await built({ items: [PLAIN] }, { agent: { name: 'Rina Wijaya', code: null, phone: null } });
      expect(nameOnly.pages[0].text).not.toContain('Kode agen');
    });

    it('P19.7-T3 AC-4 writes a premium not yet typed as –, never zero', async () => {
      const pdf = await built({ items: [{ ...PLAIN, premium: null }] });
      expect(pdf.pages[0].text).toContain('Premi per bulan\n–');
    });
  });

  describe('AC-5: page 2, Rincian', () => {
    it('P19.7-T3 AC-5 lists each product’s values in two columns: Tertanggung and the premium first, then its showOnPdf fields', async () => {
      const pdf = await built({ items: [HEALTH] });
      const lines = pdf.pages[1].text.split('\n');
      expect(lines.slice(0, 5)).toEqual([
        'Rincian',
        'PRUWell Medical · Gold',
        'Tertanggung Klien Premi per bulan Rp 1.250.000',
        'Plan Gold Masa bayar 10 tahun',
        'Uang pertanggungan Rp 1 M Wilayah Indonesia',
      ]);
    });

    it('P19.7-T3 AC-5 lists up to four benefits from the catalogue', async () => {
      const pdf = await built({ items: [HEALTH] });
      const page = pdf.pages[1].text;
      for (const benefit of HEALTH.benefits!.slice(0, 4)) expect(page).toContain(benefit);
      expect(page).not.toContain(HEALTH.benefits![4]);
    });

    it('P19.7-T3 AC-5 works out the pdfDetail amounts from the agent’s values, marks Nilai tunai tidak dijamin, and writes – for what cannot be worked out', async () => {
      const pdf = await built({ items: [HEALTH, EDUCATION] });
      const page = pdf.pages[1].text.split('\n');
      expect(page).toEqual(expect.arrayContaining([
        'Manfaat utama', 'Batas tahunan Rp 2 M', 'Kamar per hari Rp 1,5 jt', 'Jadwal', 'Pembayaran premi 10 tahun',
        'Yang tidak ditanggung', 'Kondisi yang sudah ada 12 bulan', 'Nilai tunai (contoh) — tidak dijamin',
        'Tahun ke-10 contoh Rp 100 Jt', 'Tahapan dana Rp 25 Jt',
      ]));
      const empty = await built({ items: [{ ...HEALTH, values: { plan: 'Gold', masa_bayar: '10 tahun' } }] });
      expect(empty.pages[1].text.split('\n')).toEqual(expect.arrayContaining(['Batas tahunan –', 'Uang pertanggungan – Wilayah Indonesia']));
    });

    it('P19.7-T3 AC-5 ends with the disclaimer naming the insurer, Langkah selanjutnya, and the footer on both pages', async () => {
      const pdf = await built({ items: [HEALTH] });
      const two = pdf.pages[1].text;
      expect(two.replace(/\n/g, ' ')).toContain(
        'Ringkasan ini bukan ilustrasi resmi. Manfaat dan premi mengikuti Ilustrasi Resmi dan polis dari PT Prudential Life Assurance.',
      );
      expect(two).toContain('Langkah selanjutnya: Diskusikan → Lengkapi data → Polis terbit');
      for (const page of pdf.pages) {
        const footer = page.fragments.filter((f) => f.size === PROPOSAL.PDF_FOOTER_PT).map((f) => f.text).join('').trim();
        expect(footer).toBe(FOOTER);
      }
    });

    it('P19.7-T3 AC-7 names the insurer only in the disclaimer (decision 5)', async () => {
      const pdf = await built({ items: [HEALTH, EDUCATION] }, { insurer: 'PT Asuransi Contoh' });
      const all = textOf(pdf).replace(/\n/g, ' ');
      expect(all.split('PT Asuransi Contoh')).toHaveLength(2);
      expect(all).toContain('polis dari PT Asuransi Contoh.');
    });
  });

  describe('AC-6: the fitting rule (Acc. 15) — two pages, never more, broken only between products', () => {
    it('P19.7-T3 AC-6 starts one or two products at level A and three or more at C', () => {
      expect([1, 2, 3, 4, 5].map(startLevelOf)).toEqual(['A', 'A', 'C', 'C', 'C']);
      expect(levelsFrom(1)).toEqual(['A', 'B', 'C', 'D']);
      expect(levelsFrom(4)).toEqual(['C', 'D']);
    });

    it.each([[1, [HEALTH]], [2, [HEALTH, EDUCATION]]])(
      'P19.7-T3 AC-6 with %p product(s) both pages fit at level A, everything on page 2', async (_n, items) => {
        const pdf = await built({ items });
        expect([pdf.pages.length, pdf.level]).toEqual([2, 'A']);
        expect(pdf.pages[1].text).toContain('Manfaat\n');
        expect(pdf.pages[1].text).not.toContain('Rincian lengkap di Ilustrasi Resmi');
      },
    );

    it('P19.7-T3 AC-6 Acc. 15 with four products: two pages, the fields and only Manfaat utama, then “Rincian lengkap di Ilustrasi Resmi”', async () => {
      const pdf = await built({ items: [HEALTH, EDUCATION, PLAIN, DOLLAR], showTotal: true });
      expect([pdf.pages.length, pdf.level]).toEqual([2, 'C']);
      const two = pdf.pages[1].text;
      // Every product has its block on page 2, the fields of each in it.
      for (const name of ['PRUWell Medical · Gold', 'PRUCerah', 'PRUlink', 'PRU Prosper']) expect(two.split('\n')).toContain(name);
      expect(two).toContain('Manfaat utama\nBatas tahunan Rp 2 M');
      for (const dropped of ['Jadwal', 'Yang tidak ditanggung', 'Nilai tunai', 'Rawat inap sesuai tagihan']) expect(two).not.toContain(dropped);
      expect(two).toContain('Rincian lengkap di Ilustrasi Resmi');
      // Page 1 holds all four rows.
      for (const name of ['PRUWell Medical · Gold', 'PRUCerah', 'PRUlink', 'PRU Prosper']) expect(pdf.pages[0].text.split('\n')).toContain(name);
    });

    it('P19.7-T3 AC-6 drops Nilai tunai first: a proposal too long at A is laid out at B, its other blocks kept', async () => {
      // A long Nilai tunai table on each of two products: page 2 runs over at A, and fits once it goes.
      const long = {
        ...HEALTH,
        pdfDetail: HEALTH.pdfDetail!.map((block) => (block.block !== 'nilai_tunai' ? block : {
          ...block,
          rows: Array.from({ length: PROPOSAL.PDF_DETAIL_ROWS_MAX }, (_, i) => ({ ...block.rows[0], label: `Tahun ke-${(i + 1) * 5}` })),
        })),
      };
      const a = await at('A', { items: [long, long] });
      const b = await at('B', { items: [long, long] });
      expect([a.pages.length, b.pages.length]).toEqual([3, 2]);
      const pdf = await built({ items: [long, long] });
      expect(pdf.level).toBe('B');
      expect(pdf.pages[1].text).not.toContain('Nilai tunai');
      expect(pdf.pages[1].text).toContain('Jadwal');
    });

    it('P19.7-T3 AC-6 the worst case — five products, every bound at its maximum, the longest names — is two pages at level D', async () => {
      for (const branding of [AGENCYBOOST_PDF_BRANDING, await withLogo(KPM_BRANDING)]) {
        const pdf = await built(worstCase(), { agent: WORST_AGENT, insurer: WORST_INSURER, branding });
        expect([pdf.pages.length, pdf.level]).toEqual([PROPOSAL.PDF_PAGES, 'D']);
        // Page 1 holds every row and the agent; page 2 every product's block and the foot.
        expect(pdf.pages[0].text.match(/Premi per semester/g)).toHaveLength(PROPOSAL.ITEMS_MAX);
        expect(pdf.pages[0].text).toContain('Total premi per semester');
        expect(pdf.pages[0].text).toContain('Kode agen AG-0417-0000000001');
        expect(pdf.pages[1].text.match(/Premi per semester/g)).toHaveLength(PROPOSAL.ITEMS_MAX);
        expect(pdf.pages[1].text).toContain('Langkah selanjutnya: Diskusikan → Lengkapi data → Polis terbit');
        // Text that would run past its slot ends in an ellipsis; nothing is drawn past the margin (AC-8's test).
        expect(pdf.pages[0].text).toContain('…');
      }
    });

    it('P19.7-T3 AC-6 never makes a third page: a level D that did not fit is refused, not printed (ADR-0223 §5)', async () => {
      class TooLong extends ProposalPdfBuilder {
        protected override render(_definition: TDocumentDefinitions): Promise<RenderedPdf> {
          return Promise.resolve({ bytes: Buffer.alloc(0), pages: 3 });
        }
      }
      await expect(new TooLong().build(pdfInput(proposalView({ items: [HEALTH] })), NOW)).rejects.toBeInstanceOf(ProposalPdfTooLong);
    });

    it('P19.7-T3 AC-6 breaks only between products: each product’s block on page 2 is whole, on one page', async () => {
      const pdf = await built({ items: [HEALTH, EDUCATION] });
      expect(pdf.pages[0].text).not.toContain('Rincian');
      const two = pdf.pages[1].text;
      expect(two.indexOf('PRUWell Medical · Gold')).toBeLessThan(two.indexOf('Tahun ke-10 contoh Rp 100 Jt'));
      expect(two.indexOf('Tahun ke-10 contoh Rp 100 Jt')).toBeLessThan(two.indexOf('PRUCerah'));
    });
  });

  describe('AC-7: KPM style and colours (Acc. 16)', () => {
    const colourOf = (pdf: ReadPdf, page: number, text: string) => pdf.pages[page].fragments.find((f) => f.text.trim().startsWith(text))?.colour;

    it('P19.7-T3 AC-7 without branding carries AgencyBoost’s wordmark, navy and orange (as text, its ink)', async () => {
      const pdf = await built({ items: [HEALTH] });
      expect(pdf.pages[0].text.split('\n').slice(0, 2)).toEqual(['AgencyBoost', '5 Nov 2026']);
      expect(colourOf(pdf, 0, 'KESEHATAN')).toBe('#A85E1B');
      expect(colourOf(pdf, 0, 'Proposal')).toBe('#1B2B4B');
      expect(colourOf(pdf, 0, 'Rp')).toBe('#1B2B4B');
    });

    it('P19.7-T3 AC-7 with branding: the KPM’s logo heads it, the secondary ink draws the headings and figures, the primary ink the type labels', async () => {
      const branding = await withLogo(KPM_BRANDING);
      const pdf = await built({ items: [HEALTH] }, { branding });
      expect(pdf.pages[0].text.split('\n')[0]).toBe('5 Nov 2026');
      expect(pdf.bytes.toString('latin1')).toMatch(/\/Subtype \/Image/);
      expect(colourOf(pdf, 0, 'KESEHATAN')).toBe(KPM_BRANDING.primaryInk);
      expect(colourOf(pdf, 0, 'Proposal')).toBe(KPM_BRANDING.secondaryInk);
      expect(colourOf(pdf, 0, 'Rp')).toBe(KPM_BRANDING.secondaryInk);
      expect(colourOf(pdf, 1, 'Rincian')).toBe(KPM_BRANDING.secondaryInk);
      expect(colourOf(pdf, 1, 'Langkah')).toBe(KPM_BRANDING.secondaryInk);
      // Body text keeps the fixed navy, labels the fixed grey: a KPM's colour is never a body text's.
      expect(colourOf(pdf, 0, 'Tertanggung')).toBe('#1B2B4B');
      expect(colourOf(pdf, 0, 'Premi')).toBe('#5F5E5A');
    });

    it('P19.7-T3 AC-7 reads 4.5:1 on white everywhere it writes, the brand’s own light colour kept for lines', async () => {
      const pdf = await built({ items: [HEALTH, EDUCATION], showTotal: true }, { branding: KPM_BRANDING });
      const colours = new Set(pdf.pages.flatMap((p) => p.fragments.filter((f) => f.text.trim()).map((f) => f.colour)));
      for (const colour of colours) expect([colour, contrastOnWhite(colour) >= 4.5]).toEqual([colour, true]);
      // The light secondary itself (2.1:1) draws no text — only the rules, as a stroke.
      expect(colours.has(KPM_BRANDING.secondary)).toBe(false);
      expect(contrastOnWhite(KPM_BRANDING.secondary)).toBeLessThan(4.5);
    });

    it('P19.7-T3 AC-7 a download again is rebuilt with the branding the KPM shows now', async () => {
      const before = await built({ items: [HEALTH] });
      const after = await built({ items: [HEALTH] }, { branding: KPM_BRANDING });
      expect(colourOf(before, 0, 'KESEHATAN')).toBe(AGENCYBOOST_PDF_BRANDING.primaryInk.toUpperCase());
      expect(colourOf(after, 0, 'KESEHATAN')).toBe(KPM_BRANDING.primaryInk);
    });
  });

  describe('the words: Syariah, money and the file name', () => {
    it('P19.7-T2 AC-5 on a Syariah proposal Premi is Kontribusi everywhere, the disclaimer and the labels included (ADR-0221 §9)', async () => {
      const pdf = await built({ items: [{ ...HEALTH, syariahName: 'PRUWell Medical Syariah' }], channel: 'syariah', showTotal: true });
      const all = textOf(pdf).replace(/\n/g, ' ');
      expect(all).toContain('Umur 36 (ulang tahun berikutnya) · Syariah · Bulanan');
      expect(all).toContain('Kontribusi per bulan');
      expect(all).toContain('Total kontribusi per bulan');
      expect(all).toContain('Manfaat dan kontribusi mengikuti Ilustrasi Resmi');
      expect(all).toContain('PRUWell Medical Syariah · Gold');
      expect(all).toContain('Santunan asuransi Rp 1 M');
      expect(all).not.toMatch(/\bPremi\b/);
    });

    it('P19.7-T3 AC-4 writes a premium and its totals in full, a field’s amount compact, and USD in full with its code (ADR-0223 §8)', () => {
      expect(moneyInFull(1_250_000_00, 'IDR')).toBe('Rp 1.250.000');
      expect(moneyCompact(100_000_000_000, 'IDR')).toBe('Rp 1 M');
      expect(moneyCompact(25_000_000_000, 'IDR')).toBe('Rp 250 Jt');
      expect(usdInFull(125_000)).toBe('USD 1.250,00');
      expect(usdInFull(123_456_789)).toBe('USD 1.234.567,89');
      expect(moneyCompact(125_000, 'USD')).toBe('USD 1.250,00');
      expect(usdInFull(-5)).toBe('-USD 0,05');
    });

    it('P19.7-T3 AC-5 works a formula out on the item’s own money values, in its currency; anything else is –', () => {
      const item = proposalView({ items: [HEALTH] }).items[0];
      expect(detailValueOf({ label: 'x', note: null, formula: '2 × up', text: null }, item)).toBe('Rp 2 M');
      expect(detailValueOf({ label: 'x', note: null, formula: 'up / 0', text: null }, item)).toBe('–');
      expect(detailValueOf({ label: 'x', note: null, formula: '2 × missing', text: null }, item)).toBe('–');
      expect(detailValueOf({ label: 'x', note: null, formula: null, text: 'Sesuai plan' }, item)).toBe('Sesuai plan');
      expect(detailValueOf({ label: 'x', note: null, formula: null, text: null }, item)).toBe('–');
    });

    it.each([
      ['Ibu Siti Nur’aini', 'Proposal-Ibu-Siti-Nur-aini-2026-11-05.pdf', 'Proposal-Ibu-Siti-Nur-aini-2026-11-05.pdf'],
      ["Ibu Siti Nur'aini", 'Proposal-Ibu-Siti-Nur-aini-2026-11-05.pdf', 'Proposal-Ibu-Siti-Nur-aini-2026-11-05.pdf'],
      ['Pak Bédi  Ñoviandi', 'Proposal-Pak-Bedi-Noviandi-2026-11-05.pdf', 'Proposal-Pak-Bedi-Noviandi-2026-11-05.pdf'],
      ['  — !!', 'Proposal-Klien-2026-11-05.pdf', 'Proposal-Klien-2026-11-05.pdf'],
      ['王小明', 'Proposal-王小明-2026-11-05.pdf', 'Proposal--2026-11-05.pdf'],
    ])('P19.7-T3 AC-2 names the file of %p Proposal-{Nama}-{tanggal}.pdf (ADR-0222 §6)', (client, name, ascii) => {
      expect(proposalFileName(client, '2026-11-05')).toEqual({ name, ascii });
    });

    it(`P19.7-T3 AC-2 keeps at most ${PROPOSAL.FILE_NAME_CLIENT_MAX} characters of the name, and no dash at the cut`, () => {
      const { name } = proposalFileName(`${'A'.repeat(59)} Budi`, '2026-11-05');
      expect(name).toBe(`Proposal-${'A'.repeat(59)}-2026-11-05.pdf`);
      expect(proposalFileName('B'.repeat(80), '2026-11-05').name).toBe(`Proposal-${'B'.repeat(60)}-2026-11-05.pdf`);
    });

    it('P19.7-T3 AC-2 answers the name as an attachment, ASCII and UTF-8 (RFC 6266)', () => {
      expect(dispositionOf(proposalFileName('Ibu Siti', '2026-11-05')))
        .toBe('attachment; filename="Proposal-Ibu-Siti-2026-11-05.pdf"; filename*=UTF-8\'\'Proposal-Ibu-Siti-2026-11-05.pdf');
      expect(dispositionOf(proposalFileName('王', '2026-11-05'))).toContain("filename*=UTF-8''Proposal-%E7%8E%8B-2026-11-05.pdf");
    });

    it('P19.7-T3 AC-6 sets a text in its lines, broken between words, the last ended in … when it runs past them', () => {
      const ruler = pdfRuler();
      expect(inLines(ruler, 'PRUWell Medical', 'bold', 13, 300, 2)).toBe('PRUWell Medical');
      const two = inLines(ruler, 'Kata '.repeat(60), 'regular', 11, 200, 2).split('\n');
      expect(two).toHaveLength(2);
      expect(two[1].endsWith('…')).toBe(true);
      for (const line of two) expect(ruler.width(line, 'regular', 11)).toBeLessThanOrEqual(199);
      // A word longer than the line is cut where it must be; a money figure's no-break space is not a break.
      expect(inLines(ruler, 'W'.repeat(80), 'regular', 11, 100, 1).endsWith('…')).toBe(true);
      expect(inLines(ruler, 'Total: Rp 150.000.000', 'regular', 11, 90, 2)).toBe('Total:\nRp 150.000.000');
    });
  });

  describe('ADR-0222 §3: at most two renders at once', () => {
    it(`P19.7-T3 AC-8 builds at most ${PROPOSAL.PDF_CONCURRENCY} files at once in one process; the others wait their turn`, async () => {
      const seen: number[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      class Slow extends ProposalPdfBuilder {
        protected override async render(_definition: TDocumentDefinitions): Promise<RenderedPdf> {
          seen.push(this.load.running);
          await gate;
          return { bytes: Buffer.from('%PDF-'), pages: 2 };
        }
      }
      const slow = new Slow();
      const input = pdfInput(proposalView({ items: [HEALTH] }));
      const all = Promise.all([0, 1, 2, 3].map(() => slow.build(input, NOW)));
      await new Promise((resolve) => setImmediate(resolve));
      expect(slow.load).toEqual({ running: 2, waiting: 2 });
      release();
      await all;
      expect(Math.max(...seen)).toBe(PROPOSAL.PDF_CONCURRENCY);
      expect(slow.load).toEqual({ running: 0, waiting: 0 });
    });
  });
});
