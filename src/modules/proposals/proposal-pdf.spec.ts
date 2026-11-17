import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import { contrastRatio } from '@/domain/branding/palette';
import { PROPOSAL } from '@/domain/constants';
import { AGENCYBOOST_COLOURS } from '@/modules/branding/branding-reader';
import { CHECK_ILLUSTRATION } from '@/modules/products/proposal-fields-prudential';
import { readPdf, type ReadPdf } from '../../../test/pdf-text';
import {
  BUDI, CRITICAL, DOLLAR, EDUCATION, FUTURE, HEALTH, KPM_GREEN, KPM_LIGHT, SYARIAH, field, input, item, option, proposal,
  worstCase,
} from '../../../test/proposal-pdf-fixtures';
import { agencyBoostLogo, artOf, type ArtKind } from './proposal-pdf.art';
import { AGENCYBOOST_PDF_BRANDING, pdfBrandingOf, type PdfBranding } from './proposal-branding';
import { ProposalPdfBuilder, ProposalPdfTooLong, pagesFor, pdfRuler, type RenderedPdf } from './proposal-pdf.builder';
import {
  PDF_ROLE_MIN, PDF_TYPE, densitiesFor, dispositionOf, fitProposal, inLines, proposalDocument, proposalFileName,
  type PdfLayout,
} from './proposal-pdf.layout';
import {
  PDF_INK, addressOf, artOfItem, coloursOf, moneyInFull, moneyInWords, pdfModelOf, rowsOfItem, totalOf, usdInFull,
  type PdfModelInput, type PdfItemSource,
} from './proposal-pdf.model';

/**
 * **P19.14-T3 — the proposal's PDF, redrawn** (ADR-0256; `functional/proposal.md`, *The PDF*; the 11 Nov spec's *The PDF
 * design*). Each test builds the real file with the real fonts and reads it back as a viewer would (`test/pdf-text.ts`)
 * — or reads the layout the file is drawn from: every line's place, size, colour and role.
 */
const NOW = new Date('2026-11-11T03:00:00Z');
const builder = new ProposalPdfBuilder();
const ruler = pdfRuler();

interface Built extends ReadPdf { bytes: Buffer; layout: PdfLayout }

async function built(source: PdfModelInput): Promise<Built> {
  const model = pdfModelOf(source);
  const file = await builder.build(model, NOW);
  return { ...readPdf(file.bytes), bytes: file.bytes, layout: fitProposal(model, ruler)! };
}

const textOf = (pdf: ReadPdf) => pdf.pages.map((p) => p.text).join('\n');
const flat = (s: string) => s.replace(/ /g, ' ').replace(/\s+/g, ' ');
const ONE = () => input(proposal([HEALTH]));
const FOUR = (over: Parameters<typeof proposal>[1] = {}) => input(proposal([HEALTH, CRITICAL, EDUCATION, FUTURE], { showTotal: true, ...over }));

async function withLogo(branding: PdfBranding): Promise<PdfBranding> {
  const png = await sharp({ create: { width: 512, height: 512, channels: 4, background: '#0F6E56' } }).png().toBuffer();
  return { ...branding, logo: { png, width: 512, height: 512 } };
}

/** Every stream of a PDF inflated, with its raw bytes: what a search through the file finds. */
function everything(bytes: Buffer): string {
  const raw = bytes.toString('latin1');
  const out = [raw];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = raw.indexOf('endstream', start);
    try {
      out.push(inflateSync(bytes.subarray(start, end)).toString('latin1'));
    } catch {
      // not a Flate stream (an image's own encoding): searched raw above
    }
  }
  return out.join('\n');
}

/** A text as a PDF string may hold it: UTF-16BE hex, the way pdfkit writes the document's info. */
const utf16Hex = (s: string) => Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase();

/** An info value read back: a literal UTF-16BE string (its byte-order mark first) decoded. */
const infoText = (s: string) => (s.startsWith('\u00fe\u00ff') ? Buffer.from(s.slice(2), 'latin1').swap16().toString('utf16le') : s);

describe('P19.14-T3 the proposal’s PDF (ADR-0256)', () => {
  describe('AC-1: one page for one product, exactly two for more, never a product split', () => {
    it('P19.14-T3 AC-1 one product prints exactly one A4 page, Inter embedded, that reads back', async () => {
      const pdf = await built(ONE());
      expect(pdf.header).toBe('%PDF-1.3');
      expect(pdf.pages).toHaveLength(PROPOSAL.PDF_PAGES_ONE_PRODUCT);
      expect(pdf.pages[0].width).toBeCloseTo(595.28, 1);
      expect(pdf.bytes.toString('latin1')).toMatch(/\/FontName \/[A-Z]{6}\+Inter-Bold/);
      expect(pagesFor(1)).toBe(1);
    });

    it.each([2, 3, 4])('P19.14-T3 AC-1 %i products print exactly two pages', async (n) => {
      const pdf = await built(input(proposal([HEALTH, CRITICAL, EDUCATION, FUTURE].slice(0, n), { showTotal: true })));
      expect(pdf.pages).toHaveLength(PROPOSAL.PDF_PAGES);
      expect(pagesFor(n)).toBe(2);
    });

    it(`P19.14-T3 AC-1 the worst case — ${PROPOSAL.ITEMS_MAX} products, every bound at its maximum, the longest names — is two pages`, async () => {
      const pdf = await built(worstCase());
      expect(pdf.pages).toHaveLength(PROPOSAL.PDF_PAGES);
      // It needed the last densities: a page fits, never by a third page.
      expect(pdf.layout.pages.every((p) => p.over <= 0)).toBe(true);
    });

    it('P19.14-T3 AC-1 no page break inside a product: its card whole on page 1, its box whole on page 2', async () => {
      const pdf = await built(FOUR());
      const blocks = pdf.layout.pages.flatMap((p) => p.blocks);
      for (const at of [0, 1, 2, 3]) {
        const mine = blocks.filter((b) => b.item === at);
        expect(mine.map((b) => [b.where, b.page])).toEqual([['card', 1], ['box', 2]]);
        for (const b of mine) expect(b.bottom).toBeLessThan(841.89);
      }
      // Each product's whole name on page 1 (its card) and page 2 (its box).
      expect(flat(pdf.pages[0].text)).toContain('PRUTahapan Cemerlang · PRO');
      expect(flat(pdf.pages[1].text)).toContain('PRUTahapan Cemerlang');
    });

    it('P19.14-T3 AC-1 a file that renders to the wrong length is refused, never printed', async () => {
      class Long extends ProposalPdfBuilder {
        protected override async render(): Promise<RenderedPdf> {
          return { bytes: Buffer.from('%PDF-'), pages: 3 };
        }
      }
      await expect(new Long().build(pdfModelOf(FOUR()), NOW)).rejects.toBeInstanceOf(ProposalPdfTooLong);
    });

    it('P19.14-T3 AC-1 boxes start at 7 rows with two products and 5 with more; rows come most important first, Nilai tunai last', () => {
      expect(densitiesFor('second', 2)[0].rows).toBe(PROPOSAL.PDF_BOX_ROWS_FEW);
      expect(densitiesFor('second', 3)[0].rows).toBe(PROPOSAL.PDF_BOX_ROWS_MANY);
      expect(densitiesFor('one', 1)[0].rows).toBe(PROPOSAL.PDF_HERO_ROWS_MAX);
      const rich = item({
        snapshot: {
          fields: [field({ key: 'up', label: 'Uang pertanggungan', type: 'money' })],
          pdfDetail: [
            { block: 'nilai_tunai', rows: [{ label: 'Tahun ke-10', note: null, formula: '10% × up', text: null }], notGuaranteed: true },
            { block: 'manfaat', rows: [{ label: 'Meninggal dunia', note: null, formula: '100% × up', text: null }] },
          ],
          benefits: ['Santunan'],
        },
        fieldValues: { up: 100_000_000_00 },
      });
      const rows = rowsOfItem(rich, false);
      expect(rows.map((r) => r.kind)).toEqual(['value', 'detail', 'benefit', 'cash']);
      expect(rows[rows.length - 1].label).toBe('Tahun ke-10 (tidak dijamin)');
    });
  });

  describe('AC-2: large type, dark text, no placeholder ever', () => {
    it('P19.14-T3 AC-2 sets every size at least its floor: body 12, labels 10, product names 15, premiums 18, the client 24', () => {
      expect([PROPOSAL.PDF_BODY_MIN_PT, PROPOSAL.PDF_LABEL_MIN_PT, PROPOSAL.PDF_PRODUCT_NAME_MIN_PT, PROPOSAL.PDF_PREMIUM_MIN_PT, PROPOSAL.PDF_CLIENT_NAME_MIN_PT])
        .toEqual([12, 10, 15, 18, 24]);
      for (const source of [ONE(), FOUR(), worstCase(), input(proposal([HEALTH]), { branding: KPM_LIGHT })]) {
        const model = pdfModelOf(source);
        const layout = fitProposal(model, ruler)!;
        const runs = layout.pages.flatMap((p) => p.runs);
        for (const run of runs) expect([run.text, run.size >= PDF_ROLE_MIN[run.role]]).toEqual([run.text, true]);
        // And in the document `pdfmake` draws: no text below the labels' floor.
        const nodes = (proposalDocument(model, layout, NOW).content as { fontSize?: number }[]).filter((n) => n.fontSize !== undefined);
        expect(Math.min(...nodes.map((n) => n.fontSize!))).toBeGreaterThanOrEqual(PROPOSAL.PDF_LABEL_MIN_PT);
      }
      expect(Math.min(PDF_TYPE.ROW, PDF_TYPE.WHO, PDF_TYPE.DISCLAIMER, PDF_TYPE.FACT, PDF_TYPE.STEP_TEXT)).toBe(12);
    });

    it('P19.14-T3 AC-2 prints the names, premiums and client at their sizes in the file itself', async () => {
      const pdf = await built(FOUR());
      const size = (page: number, text: string) => pdf.pages[page].fragments.find((f) => flat(f.text) === text)?.size;
      expect(size(0, 'Bapak Budi Contoh')).toBeGreaterThanOrEqual(24);
      expect(size(1, 'Bapak Budi Contoh')).toBeGreaterThanOrEqual(24);
      expect(size(0, 'PCB88')).toBeGreaterThanOrEqual(15);
      expect(size(0, 'Rp 1.690.000')).toBeGreaterThanOrEqual(18);
      expect(size(0, 'Rp 4.518.000')).toBeGreaterThanOrEqual(18);
      expect(Math.min(...pdf.pages.flatMap((p) => p.fragments.map((f) => f.size)))).toBeGreaterThanOrEqual(10);
    });

    it('P19.14-T3 AC-2 writes body text and numbers in the spec’s dark #1a1f2b, and every word reads 4.5:1 where it sits', () => {
      for (const branding of [AGENCYBOOST_PDF_BRANDING, KPM_GREEN, KPM_LIGHT]) {
        const model = pdfModelOf(input(proposal([HEALTH, CRITICAL]), { branding }));
        const c = model.colours;
        expect(c.ink).toBe(PDF_INK);
        const runs = fitProposal(model, ruler)!.pages.flatMap((p) => p.runs);
        // The rows' values, the tiles' values: the dark text.
        expect(runs.find((r) => flat(r.text) === 'Rp 500 juta')?.colour).toBe(PDF_INK);
        expect(runs.find((r) => r.text === 'Menikah')?.colour).toBe(PDF_INK);
        // Words on white or a tint, and words on the band, each read.
        for (const colour of [c.ink, c.muted, c.band, c.secondInk]) expect(contrastRatio(colour, '#ffffff')).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(c.bandOnTint, c.tint)).toBeGreaterThanOrEqual(4.5);
        for (const colour of [c.onBand, c.onBandSoft]) expect(contrastRatio(colour, c.band)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(c.onBand, c.bandLift)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(c.avatarText, c.avatarFill)).toBeGreaterThanOrEqual(4.5);
      }
    });

    it('P19.14-T3 AC-2 never prints a placeholder — no ●●●, [dari ilustrasi], dari tabel tarif, Sesuai ilustrasi resmi or –', async () => {
      const gaps = item({
        snapshot: {
          name: 'PRUCerah', category: 'education', typeLabel: 'DANA PENDIDIKAN',
          fields: [
            field({ key: 'masa_bayar', label: 'Masa bayar', type: 'chips', options: [option(CHECK_ILLUSTRATION)], paymentYears: true }),
            field({ key: 'target_dana', label: 'Target dana', type: 'money' }),
          ],
          pdfDetail: [
            { block: 'manfaat', rows: [{ label: 'Tahapan dana', note: null, formula: '5% × target_dana', text: null }] },
            { block: 'masa', rows: [{ label: 'Dana di akhir', note: null, formula: null, text: 'dari tabel tarif' }] },
          ],
        },
        fieldValues: { masa_bayar: CHECK_ILLUSTRATION },
        premium: null,
      });
      for (const source of [input(proposal([gaps])), input(proposal([gaps, HEALTH], { showTotal: true })), FOUR(), worstCase()]) {
        const all = flat(textOf(await built(source)));
        expect(all).not.toMatch(/●|\[dari ilustrasi\]|dari tabel tarif|Sesuai ilustrasi resmi|Rp ?–|: –/);
      }
      // The row with no value is left out, and so is its label; a premium not typed prints no figure.
      const one = flat(textOf(await built(input(proposal([gaps])))));
      expect(one).not.toContain('Tahapan dana');
      expect(one).not.toContain('Dana di akhir');
      expect(one).not.toContain('Masa bayar');
      expect(one).not.toMatch(/Rp \d/);
    });
  });

  describe('AC-3: what each page says', () => {
    it('P19.14-T3 AC-3 heads page 1 with the logo, the name, the tagline and date, DISIAPKAN KHUSUS UNTUK and Bapak/Ibu {Nama}', async () => {
      const page = flat((await built(FOUR())).pages[0].text);
      for (const part of ['AgencyBoost', 'Proposal perlindungan keluarga · 11 November 2026', 'DISIAPKAN KHUSUS UNTUK', 'Bapak Budi Contoh']) {
        expect(page).toContain(part);
      }
    });

    it('P19.14-T3 AC-3 addresses the client by gender, never doubling a title the lead carries', () => {
      expect(addressOf('Budi Contoh', 'male')).toEqual({ title: 'Bapak Budi Contoh', short: 'Bapak Budi' });
      expect(addressOf('Pak Budi Santoso', 'male')).toEqual({ title: 'Bapak Budi Santoso', short: 'Bapak Budi' });
      expect(addressOf('Ibu Sari', null)).toEqual({ title: 'Ibu Sari', short: 'Ibu Sari' });
      expect(addressOf('Sari', null)).toEqual({ title: 'Bapak/Ibu Sari', short: 'Bapak/Ibu Sari' });
    });

    it('P19.14-T3 AC-3 Tentang prints Usia and Jenis kelamin, and each detail and Yang dibahas only when filled', async () => {
      const bare = flat((await built(input(proposal([HEALTH], { client: { name: 'Budi Contoh', age: 35, gender: 'male', details: null } })))).pages[0].text);
      expect(bare).toContain('TENTANG BAPAK BUDI');
      expect(bare).toContain('Usia 35 tahun');
      expect(bare).toMatch(/Jenis kelamin.*Laki-laki/);
      for (const absent of ['Status', 'Tanggungan', 'Pekerjaan', 'Kota', 'Yang dibahas']) expect(bare).not.toContain(absent);
      const full = flat((await built(FOUR())).pages[0].text);
      for (const present of ['Menikah', 'Istri, 1 anak (5 th)', 'Karyawan swasta', 'Tangerang Selatan', 'Yang dibahas:', 'Biaya rumah sakit', 'Dana masa depan / pensiun']) {
        expect(full).toContain(present);
      }
    });

    it('P19.14-T3 AC-3 Ringkasan comes with two products or more: the need tiles ✓ terlindungi / ✓ terencana, a discussed need with none grey', async () => {
      expect(flat((await built(ONE())).pages[0].text)).not.toContain('RINGKASAN');
      const page = flat((await built(FOUR())).pages[0].text);
      expect(page).toContain('RINGKASAN');
      for (const tile of ['Kesehatan ✓ terlindungi', 'Sakit kritis ✓ terlindungi', 'Pendidikan ✓ terencana', 'Masa depan ✓ terencana']) {
        expect(page).toContain(tile);
      }
      const open = pdfModelOf(input(proposal([SYARIAH, DOLLAR]))).summary!.tiles;
      expect(open.map((t) => [t.label, t.covered, t.state])).toEqual([
        ['Kesehatan', false, 'belum ada'], ['Sakit kritis', false, 'belum ada'], ['Keluarga', true, '✓ terlindungi'], ['Masa depan', true, '✓ terencana'],
      ]);
    });

    it('P19.14-T3 AC-3 totals only with Tampilkan total, only one cara bayar and one currency, never IDR and USD added', async () => {
      const items = [HEALTH, CRITICAL, EDUCATION, FUTURE];
      expect(totalOf(items, false)).toBeNull();
      expect(totalOf(items, true)).toEqual({
        label: 'Total per bulan',
        amount: moneyInFull(4_518_000_00, 'IDR'),
        lines: ['3 produk bayar bulanan.', 'PRUTahapan Cemerlang dibayar per tahun.'],
      });
      // One of each: no two share a cara bayar and a currency, so there is no total.
      expect(totalOf([HEALTH, { ...DOLLAR, payFrequency: 'monthly' }], true)).toBeNull();
      const usd = { ...DOLLAR, payFrequency: 'monthly' } as PdfItemSource;
      const mixed = totalOf([HEALTH, CRITICAL, usd, usd, usd], true)!;
      expect(mixed.amount).toBe(moneyInFull(750_000, 'USD'));
      expect(mixed.lines).toEqual(['3 produk bayar bulanan.', 'PRUWell Medical, PCB88 dibayar terpisah.']);
      const off = flat((await built(FOUR({ showTotal: false }))).pages[0].text);
      expect(off).not.toContain('Total per bulan');
      expect(flat((await built(FOUR())).pages[0].text)).toContain('Total per bulan Rp 4.518.000');
    });

    it('P19.14-T3 AC-3 Program yang ditawarkan: a card per product — category, name and plan, who, the premium, the period pill', async () => {
      const page = flat((await built(FOUR())).pages[0].text);
      for (const part of ['PROGRAM YANG DITAWARKAN', 'PENYAKIT KRITIS', 'PCB88', 'Untuk: Bapak Budi · UP Rp 500 juta', 'Rp 1.690.000', 'per bulan · 10 tahun',
        'PRUWell Medical · Silver A', 'Untuk: Raka (anak, 5 th)', 'per tahun · 10 tahun', 'PRUSmart Plan · 6-Pay']) {
        expect(page).toContain(part);
      }
      expect(page).toContain('Halaman 1 dari 2');
      expect(page).toContain('AgencyBoost · disiapkan oleh Rina Wijaya, 0812 3456 7890');
    });

    it('P19.14-T3 AC-3 one product: the large card, Perlindungan Anda, Yang perlu diketahui, the steps, the disclaimer and the agent on its one page', async () => {
      const page = flat((await built(ONE())).pages[0].text);
      for (const part of ['KESEHATAN', 'PRUWell Medical · Silver A', 'Rp 828.000', 'Premi dari ilustrasi resmi', 'Wilayah', 'Asia kec. JPN, HK, SGP',
        'PERLINDUNGAN ANDA', 'Limit per tahun', 'Rp4 miliar', 'YANG PERLU DIKETAHUI', 'Masa tunggu 30 hari', 'LANGKAH:', '1 · Diskusikan',
        'polis dari Prudential.', 'Rina Wijaya', 'Agen · Kode 80008 · 0812 3456 7890', 'Hubungi saya', 'Halaman 1 dari 1']) {
        expect(page).toContain(part);
      }
      expect(page).not.toContain('RINCIAN PROGRAM');
    });

    it('P19.14-T3 AC-3 page 2: RINCIAN PROGRAM, a box per product with its rows and the school timeline, the steps, the disclaimer naming the insurer, the agent', async () => {
      const page = flat((await built(FOUR())).pages[1].text);
      for (const part of ['RINCIAN PROGRAM', 'Bapak Budi Contoh', 'Uang pertanggungan Rp 500 juta', 'Lama bayar 10 tahun', 'Total dibayar Rp 202,8 juta',
        'Dana cair saat anak masuk:', 'SD', 'Kuliah', '10%', '50%', 'LANGKAH SELANJUTNYA', 'Diskusikan', 'Lengkapi data', 'Polis terbit',
        'Ringkasan ini bukan ilustrasi resmi dan bukan kontrak.', 'polis dari Prudential.', 'Rina Wijaya', 'Halaman 2 dari 2']) {
        expect(page).toContain(part);
      }
      // The insurer is named in the disclaimer alone.
      expect(flat(textOf(await built(FOUR()))).split('Prudential')).toHaveLength(2);
    });

    it('P19.14-T3 AC-3 a syariah product reads Santunan asuransi and Kontribusi; sentences for all say premi/kontribusi when mixed', async () => {
      const all = flat(textOf(await built(input(proposal([SYARIAH, CRITICAL])))));
      expect(all).toContain('Santunan asuransi Rp 250 juta');
      expect(all).toContain('Untuk: Bapak Budi · Santunan Rp 250 juta');
      expect(all).toContain('Kontribusi dari ilustrasi resmi');
      expect(all).toContain('premi/kontribusi final mengikuti');
      const only = flat(textOf(await built(input(proposal([SYARIAH])))));
      expect(only).toContain('kontribusi final mengikuti');
      expect(only).not.toMatch(/\bpremi\b/i);
    });

    it('P19.14-T3 AC-3 a typed premium reads “dari ilustrasi resmi”, a table’s “Tabel tarif berlaku {tanggal}”; USD stays USD, in full', async () => {
      const table = { ...HEALTH, rateTableVersionId: 'v1', rateTableEffectiveFrom: '2026-11-01' };
      expect(flat(textOf(await built(input(proposal([table])))))).toContain('Tabel tarif berlaku 1 November 2026');
      const usd = flat(textOf(await built(input(proposal([DOLLAR, HEALTH])))));
      expect(usd).toContain('USD 2.500,00');
      expect([usdInFull(125_000), moneyInWords(500_000_000_00, 'IDR'), moneyInWords(4_000_000_000_00, 'IDR')].map(flat))
        .toEqual(['USD 1.250,00', 'Rp 500 juta', 'Rp 4 miliar']);
      expect(flat(moneyInFull(828_000_00, 'IDR'))).toBe('Rp 828.000');
    });
  });

  describe('AC-4: the KPM’s branding, and AgencyBoost only without it', () => {
    it('P19.14-T3 AC-4 without branding: the 3-dot logo, AgencyBoost’s name, a navy band and an orange stripe', async () => {
      const pdf = await built(FOUR());
      const svg = pdf.layout.pages[0].svg;
      expect(svg).toContain(agencyBoostLogo());
      expect(svg).toContain(`fill="${AGENCYBOOST_COLOURS.secondary}"`);
      expect(svg).toContain(`fill="${AGENCYBOOST_COLOURS.primary}"`);
      expect(pdf.pages[0].text.split('\n')[0]).toBe('AgencyBoost');
      expect(pdf.info).toMatchObject({ Title: 'Proposal untuk Bapak Budi Contoh', Producer: 'AgencyBoost', Creator: 'AgencyBoost' });
      expect(pdf.bytes.toString('latin1')).not.toMatch(/\/Subtype \/Image/);
    });

    it('P19.14-T3 AC-4 with branding: the KPM’s name, logo and colours on both pages — and “AgencyBoost” nowhere in the file', async () => {
      for (const branding of [KPM_GREEN, await withLogo(KPM_GREEN)]) {
        for (const source of [input(proposal([HEALTH]), { branding }), input(proposal([HEALTH, CRITICAL, EDUCATION, FUTURE]), { branding })]) {
          const pdf = await built(source);
          const haystack = everything(pdf.bytes);
          expect(haystack).not.toMatch(/agencyboost/i);
          expect(haystack.toUpperCase()).not.toContain(utf16Hex('AgencyBoost'));
          // A UTF-16 literal string, its null bytes taken out, is searched too.
          expect(haystack.replace(/\0/g, '')).not.toMatch(/agencyboost/i);
          const info = Object.fromEntries(Object.entries(pdf.info).map(([k, v]) => [k, infoText(v)]));
          expect(Object.values(info).join(' ')).not.toMatch(/agencyboost/i);
          expect(info).toMatchObject({ Producer: 'KPM 0417 · BSD City', Creator: 'KPM 0417 · BSD City', Author: 'BSD City' });
          for (const page of pdf.pages) expect(flat(page.text)).toContain('KPM 0417 · BSD City');
          const band = coloursOf(KPM_GREEN.main, KPM_GREEN.second).band;
          for (const laid of pdf.layout.pages) {
            expect(laid.svg).toContain(`fill="${band}"`);
            expect(laid.svg).toContain(`fill="${KPM_GREEN.second.toLowerCase()}"`);
            expect(laid.svg).not.toContain(agencyBoostLogo());
          }
        }
      }
    });

    it('P19.14-T3 AC-4 the logo is the square one on a white circle; without one, the KPM’s initials; and the only image is the KPM’s', async () => {
      const logo = await built(input(proposal([HEALTH, CRITICAL]), { branding: await withLogo(KPM_GREEN) }));
      // One picture: its image and the soft mask its transparency is drawn with.
      const raw = logo.bytes.toString('latin1');
      expect((raw.match(/\/Subtype \/Image/g) ?? []).length - (raw.match(/\/SMask \d+ 0 R/g) ?? []).length).toBe(1);
      const pic = logo.layout.pages[0].pictures[0];
      expect(pic.w).toBe(pic.h);
      expect(logo.layout.pages[0].svg).toMatch(/<circle cx="[\d.]+" cy="[\d.]+" r="20" fill="#ffffff"\/>/);
      const initials = pdfModelOf(input(proposal([HEALTH]), { branding: KPM_GREEN }));
      expect(initials.brand.mark).toEqual({ kind: 'initials', text: 'BC' });
    });

    it('P19.14-T3 AC-4 maps the spec’s main colour to Warna kedua and its second to Warna utama, so AgencyBoost’s give navy and orange', () => {
      expect(AGENCYBOOST_PDF_BRANDING).toMatchObject({ branded: false, name: 'AgencyBoost', main: AGENCYBOOST_COLOURS.secondary, second: AGENCYBOOST_COLOURS.primary });
      expect(pdfBrandingOf({ name: 'KPM A', branded: true, logo: null, primary: '#5dcaa5', secondary: '#0f6e56' }))
        .toEqual({ branded: true, name: 'KPM A', logo: null, main: '#0f6e56', second: '#5dcaa5' });
      // A logo and no colours: the KPM's name and logo, AgencyBoost's colours.
      expect(pdfBrandingOf({ name: 'KPM A', branded: true, logo: null, primary: null, secondary: null }))
        .toMatchObject({ branded: true, name: 'KPM A', main: AGENCYBOOST_COLOURS.secondary, second: AGENCYBOOST_COLOURS.primary });
      expect(pdfBrandingOf({ name: 'KPM A', branded: false, logo: null, primary: null, secondary: null })).toBe(AGENCYBOOST_PDF_BRANDING);
      const navy = coloursOf(AGENCYBOOST_PDF_BRANDING.main, AGENCYBOOST_PDF_BRANDING.second);
      expect([navy.band, navy.second]).toEqual([AGENCYBOOST_COLOURS.secondary, AGENCYBOOST_COLOURS.primary]);
    });

    it('P19.14-T3 AC-4 a main colour too light for white words is drawn as its nearest darker shade that reads; tints 7 % and 14 %', () => {
      const c = coloursOf(KPM_LIGHT.main, KPM_LIGHT.second);
      expect(c.band).not.toBe(KPM_LIGHT.main.toLowerCase());
      expect(contrastRatio('#ffffff', c.band)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio('#ffffff', KPM_LIGHT.main)).toBeLessThan(4.5);
      // A colour that already reads keeps itself.
      expect(coloursOf('#0F6E56', '#5DCAA5').band).toBe('#0f6e56');
      expect([PROPOSAL.PDF_TINT_LIGHT, PROPOSAL.PDF_TINT_STRONG]).toEqual([0.07, 0.14]);
    });
  });

  describe('AC-5: the category illustrations recolour', () => {
    it('P19.14-T3 AC-5 draws every picture in the KPM’s two colours, their tints and white — nothing else', () => {
      const c = coloursOf(KPM_GREEN.main, KPM_GREEN.second);
      const allowed = new Set([c.art.a, c.art.b, c.art.a1, c.art.a2, c.art.b2, '#ffffff', 'none']);
      for (const kind of ['health', 'critical', 'family', 'education', 'growth'] as ArtKind[]) {
        const svg = artOf(kind, c.art);
        const colours = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]);
        expect(colours.length).toBeGreaterThan(3);
        for (const colour of colours) expect([kind, colour, allowed.has(colour)]).toEqual([kind, colour, true]);
        expect(svg).not.toMatch(/var\(|#f6c693/i);
      }
    });

    it('P19.14-T3 AC-5 heads one product with its category’s picture and more with the umbrella; each card and box has its own; an unknown category is the umbrella', () => {
      const c = coloursOf(KPM_GREEN.main, KPM_GREEN.second);
      const one = fitProposal(pdfModelOf(input(proposal([HEALTH]), { branding: KPM_GREEN })), ruler)!;
      expect(one.pages[0].svg).toContain(artOf('health', c.art));
      const four = fitProposal(pdfModelOf(input(proposal([HEALTH, CRITICAL, EDUCATION, FUTURE]), { branding: KPM_GREEN })), ruler)!;
      for (const kind of ['family', 'health', 'critical', 'education', 'growth'] as ArtKind[]) expect(four.pages[0].svg).toContain(artOf(kind, c.art));
      for (const kind of ['health', 'critical', 'education', 'growth'] as ArtKind[]) expect(four.pages[1].svg).toContain(artOf(kind, c.art));
      expect(artOfItem(item({ snapshot: { category: 'something-new', needTag: null } }))).toBe('family');
      expect(artOfItem(item({ snapshot: { category: 'something-new', needTag: 'EDUCATION' } }))).toBe('education');
    });
  });

  describe('AC-6: nothing sent, nothing linked', () => {
    it('P19.14-T3 AC-6 the file carries no link, no action and no WhatsApp address', async () => {
      for (const source of [ONE(), FOUR()]) {
        const all = everything((await built(source)).bytes);
        expect(all).not.toMatch(/\/URI|\/Annots|\/JavaScript|\/OpenAction|wa\.me|whatsapp/i);
      }
    });
  });

  describe('the words: the file name and the lines', () => {
    it.each([
      ['Ibu Siti Nur’aini', 'Proposal-Ibu-Siti-Nur-aini-2026-11-05.pdf', 'Proposal-Ibu-Siti-Nur-aini-2026-11-05.pdf'],
      ['Pak Bédi  Ñoviandi', 'Proposal-Pak-Bedi-Noviandi-2026-11-05.pdf', 'Proposal-Pak-Bedi-Noviandi-2026-11-05.pdf'],
      ['  — !!', 'Proposal-Klien-2026-11-05.pdf', 'Proposal-Klien-2026-11-05.pdf'],
      ['王小明', 'Proposal-王小明-2026-11-05.pdf', 'Proposal--2026-11-05.pdf'],
    ])('P19.14-T3 AC-6 still names the file of %p Proposal-{Nama}-{tanggal}.pdf (ADR-0222 §6)', (client, name, ascii) => {
      expect(proposalFileName(client, '2026-11-05')).toEqual({ name, ascii });
    });

    it(`P19.14-T3 AC-6 keeps at most ${PROPOSAL.FILE_NAME_CLIENT_MAX} characters of the name, answered as an attachment (RFC 6266)`, () => {
      expect(proposalFileName(`${'A'.repeat(59)} Budi`, '2026-11-05').name).toBe(`Proposal-${'A'.repeat(59)}-2026-11-05.pdf`);
      expect(dispositionOf(proposalFileName('Ibu Siti', '2026-11-05')))
        .toBe('attachment; filename="Proposal-Ibu-Siti-2026-11-05.pdf"; filename*=UTF-8\'\'Proposal-Ibu-Siti-2026-11-05.pdf');
    });

    it('P19.14-T3 AC-2 sets a text in its lines, broken between words, the last ended in … when it runs past them', () => {
      expect(inLines(ruler, 'PRUWell Medical', 'bold', 15, 300, 2)).toEqual(['PRUWell Medical']);
      const two = inLines(ruler, 'Kata '.repeat(60), 'regular', 12, 200, 2);
      expect(two).toHaveLength(2);
      expect(two[1].endsWith('…')).toBe(true);
      for (const line of two) expect(ruler.width(line, 'regular', 12)).toBeLessThanOrEqual(199);
      expect(inLines(ruler, 'W'.repeat(80), 'regular', 12, 100, 1)[0].endsWith('…')).toBe(true);
      expect(inLines(ruler, 'Total: Rp 150.000.000', 'regular', 12, 100, 2)).toEqual(['Total:', 'Rp 150.000.000']);
    });
  });

  describe('the rules, one by one (ADR-0256 §4, §6)', () => {
    it('P19.14-T3 AC-3 names the insured: the client, a spouse, a child, someone else — with or without a name and an age', () => {
      const who = (insured: PdfItemSource['insured']) => pdfModelOf(input(proposal([{ ...HEALTH, insured }]))).items[0].who;
      expect(who({ relation: 'client', name: null, age: null })).toBe('Untuk: Bapak Budi');
      expect(who({ relation: 'spouse', name: 'Sari', age: 33 })).toBe('Untuk: Sari (pasangan, 33 th)');
      expect(who({ relation: 'child', name: null, age: 5 })).toBe('Untuk: Anak (5 th)');
      expect(who({ relation: 'other', name: 'Pak Joko', age: null })).toBe('Untuk: Pak Joko');
      expect(who({ relation: 'other', name: null, age: null })).toBe('Untuk: Tertanggung');
      expect(addressOf('Ny. Rina', null).title).toBe('Ibu Rina');
    });

    it('P19.14-T3 AC-3 says the pay term in the pill and the rows: years, an age, a single payment, a field’s, or nothing', () => {
      const pill = (over: Partial<PdfItemSource>) => pdfModelOf(input(proposal([{ ...CRITICAL, ...over }]))).items[0];
      expect(pill({ payTerm: 't5' }).pill).toBe('per bulan · 5 tahun');
      const single = pill({ payTerm: 'single', payFrequency: 'single' });
      expect([single.pill, single.rows.find((r) => r.label === 'Lama bayar')?.value]).toEqual(['sekali bayar', 'Sekali bayar']);
      expect(single.rows.some((r) => r.label === 'Total dibayar')).toBe(false);
      expect(pill({ payTerm: null }).pill).toBe('per bulan');
      const byField = item({
        snapshot: { fields: [field({ key: 'masa', label: 'Masa bayar', type: 'fixed', options: [option('Bayar 10 th', 10)], paymentYears: true })] },
        premium: { amountMinor: 100_000_00, currency: 'IDR' },
      });
      const model = pdfModelOf(input(proposal([byField]))).items[0];
      expect(model.pill).toBe('per bulan · 10 tahun');
      expect(model.rows.map((r) => [r.label, flat(r.value)])).toEqual([['Masa bayar', 'Bayar 10 th'], ['Total dibayar', 'Rp 12 juta']]);
      const sentence = item({ snapshot: { payTerms: [{ key: 'k', label: 'Diperbarui tiap tahun', years: null, toAge: null, single: false }] }, payTerm: 'k' });
      expect(pdfModelOf(input(proposal([sentence]))).items[0].pill).toBe('per bulan');
    });

    it('P19.14-T3 AC-3 a lone other product is said by its cara bayar, its currency or its single payment', () => {
      const monthly = (i: PdfItemSource) => ({ ...i, payFrequency: 'monthly' }) as PdfItemSource;
      expect(totalOf([HEALTH, CRITICAL, { ...FUTURE, payFrequency: 'single' }], true)!.lines[1]).toBe('PRUSmart Plan sekali bayar.');
      expect(totalOf([HEALTH, CRITICAL, monthly(DOLLAR)], true)!.lines[1]).toBe('PRU Prosper dalam USD.');
      expect(totalOf([HEALTH, CRITICAL, { ...HEALTH, premium: null }], true)!.lines).toEqual(['2 produk bayar bulanan.', 'PRUWell Medical dibayar per bulan.']);
      expect(totalOf([HEALTH], true)).toBeNull();
    });

    it('P19.14-T3 AC-3 prints Lainnya’s own words, a single client’s status, and each tile only with a value', () => {
      const model = pdfModelOf(input(proposal([HEALTH], {
        client: { name: 'Sari', age: null, gender: 'female', details: { status: 'single', dependants: '  ', occupation: null, city: null, needs: ['OTHER', 'FAMILY'], needsOther: 'Dana haji' } },
      })));
      expect(model.client.tiles).toEqual([{ label: 'Jenis kelamin', value: 'Perempuan' }, { label: 'Status', value: 'Lajang' }]);
      expect(model.client.needs).toEqual(['Santunan keluarga', 'Dana haji']);
      const bare = pdfModelOf(input(proposal([HEALTH], { client: { name: 'Sari', age: null, gender: null, details: { needs: ['OTHER'] } } })));
      expect([bare.client.title, bare.client.tiles, bare.client.needs]).toEqual(['Bapak/Ibu Sari', [], ['Lainnya']]);
    });

    it('P19.14-T3 AC-2 leaves out what has no value: an exclusion is its label, a formula needs its amount, Nilai tunai says tidak dijamin', () => {
      const detail = item({
        snapshot: {
          fields: [field({ key: 'up', label: 'Uang pertanggungan', type: 'money' })],
          pdfDetail: [
            { block: 'pengecualian', rows: [{ label: 'Kondisi yang sudah ada', note: null, formula: null, text: null }] },
            { block: 'manfaat', rows: [{ label: 'Meninggal', note: null, formula: '100% × up', text: null }, { label: '', note: null, formula: null, text: 'x' }] },
            { block: 'nilai_tunai', rows: [{ label: 'Tahun ke-5', note: 'contoh', formula: null, text: 'Rp 1 juta' }], notGuaranteed: true },
          ],
        },
      });
      expect(rowsOfItem(detail, false).map((r) => [r.label, r.value])).toEqual([
        ['Kondisi yang sudah ada', 'tidak ditanggung'], ['Tahun ke-5 contoh (tidak dijamin)', 'Rp 1 juta'],
      ]);
      const filledUp = rowsOfItem({ ...detail, up: { amountMinor: 200_000_000_00, currency: 'IDR' } }, false);
      expect(filledUp.map((r) => [r.label, flat(r.value)]).slice(0, 2)).toEqual([['Uang pertanggungan', 'Rp 200 juta'], ['Meninggal', 'Rp 200 juta']]);
    });

    it('P19.14-T3 AC-4 a one-product page with no agent, no details and no premium still fits its page and prints no gap', async () => {
      const lone = { ...HEALTH, premium: null };
      const source = input(proposal([lone], { client: { name: 'Budi', age: null, gender: null, details: null } }), { agent: { name: null, code: null, phone: null }, insurer: '' });
      const model = pdfModelOf(source);
      expect([model.agent, model.footer.preparedBy]).toEqual([null, null]);
      expect(model.disclaimer).toContain('polis dari perusahaan asuransi.');
      const pdf = await built(source);
      expect(pdf.pages).toHaveLength(1);
      const text = flat(textOf(pdf));
      expect(text).not.toContain('TENTANG');
      expect(text).not.toContain('Hubungi saya');
      // Code and phone without a name: the line alone, no initials.
      const coded = pdfModelOf(input(proposal([HEALTH, CRITICAL]), { agent: { name: null, code: '80008', phone: null } }));
      expect(coded.agent).toEqual({ name: null, initials: '', line: 'Agen · Kode 80008', cta: ['Hubungi saya', 'untuk diskusi'] });
      expect((await built(input(proposal([HEALTH, CRITICAL]), { agent: { name: null, code: '80008', phone: null } }))).pages).toHaveLength(2);
    });
  });

  describe('ADR-0222 §3: at most two renders at once', () => {
    it(`P19.14-T3 AC-1 builds at most ${PROPOSAL.PDF_CONCURRENCY} files at once in one process; the others wait their turn`, async () => {
      const seen: number[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      class Slow extends ProposalPdfBuilder {
        protected override async render(_definition: TDocumentDefinitions): Promise<RenderedPdf> {
          seen.push(this.load.running);
          await gate;
          return { bytes: Buffer.from('%PDF-'), pages: 1 };
        }
      }
      const slow = new Slow();
      const model = pdfModelOf(input(proposal([HEALTH], { client: BUDI })));
      const all = Promise.all([0, 1, 2, 3].map(() => slow.build(model, NOW)));
      await new Promise((resolve) => setImmediate(resolve));
      expect(slow.load).toEqual({ running: 2, waiting: 2 });
      release();
      await all;
      expect(Math.max(...seen)).toBe(PROPOSAL.PDF_CONCURRENCY);
      expect(slow.load).toEqual({ running: 0, waiting: 0 });
    });
  });
});
