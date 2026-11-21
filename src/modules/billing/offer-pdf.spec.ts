import { breakdownLines, offerDocument, offerFileName, policies } from './offer-pdf';
import { priceOffer } from './price-offer';

const rp = (major: number) => major * 100;

/** Every string a document definition holds, flattened, so its words can be read without rendering it. */
function words(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (Array.isArray(node)) return node.flatMap(words);
  if (node && typeof node === 'object') return Object.values(node as Record<string, unknown>).flatMap(words);
  return [];
}

/** Frame 45: 22 leaders and 80 agents, Tahunan, Rp 350.000. */
const FRAME_45 = priceOffer({
  leaders: 22, agents: 80, plan: 'annual', price: { mode: 'per_leader', rateMinor: rp(350_000) }, bulk: null,
});

describe('the offer’s PDF (P19.23-T5 AC-2; ADR-0279 §7)', () => {
  it('P19.23-T5 AC-2 Balik modal writes one decimal below ten policies and a whole number from ten', () => {
    expect([policies(80), policies(7), policies(9), policies(110), policies(105), policies(0)])
      .toEqual(['8,0', '0,7', '0,9', '11', '11', '0,0']);
  });

  it('P19.23-T5 AC-2 the breakdown reads as the result card: Harga normal → Diskon harga → Hemat tahunan 5%', () => {
    expect(breakdownLines(FRAME_45)).toEqual([
      { label: 'Harga normal (22 × Rp 450.000 × 12)', value: 'Rp 118.800.000' },
      { label: 'Diskon harga → Rp 350.000', value: 'Rp 26.400.000', minus: true },
      { label: 'Hemat tahunan 5%', value: 'Rp 4.620.000', minus: true },
    ]);
  });

  it('P19.23-T5 AC-3 Harga khusus, and a price above the standard, start from leaders × price × months', () => {
    const custom = priceOffer({ leaders: 120, agents: null, plan: 'six_months', price: { mode: 'per_leader', rateMinor: rp(250_000) }, bulk: { type: 'percent', percent: 10 } });
    expect(breakdownLines(custom)).toEqual([
      { label: '120 leader × Rp 250.000 × 6 bln', value: 'Rp 180.000.000' },
      { label: 'Diskon bulk order', value: 'Rp 18.000.000', minus: true },
    ]);
  });

  it('P19.23-T5 AC-2 the document carries the total, the per-day figures, Hemat, Balik modal, the note and the number', () => {
    const doc = offerDocument({
      pricing: FRAME_45, kpmName: 'BSD City Branch', companyName: 'Prudential', startDate: '2026-11-20',
      endDate: '2027-11-19', note: 'KPM baru, komitmen 1 tahun', today: '2026-11-20', whatsappNumber: '0811 2000 300',
    });
    const text = words(doc.content).join(' | ');
    for (const expected of [
      'Penawaran langganan AgencyBoost', 'BSD City Branch', ' · Prudential', 'Tahunan', '20 Nov 2026 – 19 Nov 2027',
      '80 (tidak ditagih)', 'Rp 87.780.000', 'Hemat Rp 31.020.000 (26%) dari harga standar', 'Rp 7.315.000',
      'per leader / hari', 'Rp 11.100', 'Rp 3.000', '11 polis / tahun  ·  0,9 polis / bulan',
      '= Rp 8.000.000', 'KPM baru, komitmen 1 tahun',
    ]) expect(text).toContain(expected);
    const footer = (doc.footer as (current: number, count: number) => unknown)(1, 1);
    expect(words(footer).join(' ')).toContain('AgencyBoost · WhatsApp 0811 2000 300');
  });

  it('P19.23-T5 AC-2 without agents, a number or a note the PDF says nothing of them', () => {
    const plain = priceOffer({ leaders: 11, agents: null, plan: 'six_months', price: { mode: 'total', totalMinor: rp(24_750_000) }, bulk: null });
    const doc = offerDocument({
      pricing: plain, kpmName: 'Serpong Branch', companyName: null, startDate: '2026-11-20', endDate: '2027-05-19',
      note: null, today: '2026-11-20', whatsappNumber: null,
    });
    const text = words(doc.content).join(' | ');
    expect(text).not.toContain('agent / hari');
    expect(text).not.toContain('Catatan');
    expect(text).toContain('3,1 polis / 6 bulan');
    expect(words((doc.footer as (c: number, n: number) => unknown)(1, 1)).join(' ')).not.toContain('WhatsApp');
  });

  it('names the file for the KPM and the day', () => {
    expect(offerFileName('BSD City Branch', '2026-11-20').name).toBe('Penawaran-BSD-City-Branch-2026-11-20.pdf');
  });
});
