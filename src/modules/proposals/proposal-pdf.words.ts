import type { PdfDetailBlockKind, ProposalChannel, ProposalInsuredRelation, ProposalPayFrequency } from '@/domain/constants';

/**
 * **Every word the proposal's PDF prints that is not the catalogue's** (P19.7-T3; ADR-0223 §3, §4, §8; the proposal
 * spec's *The PDF*). **Indonesian only, whatever language the agent reads the app in**: the file is the client's
 * document, and every word on it is the spec's or the catalogue's (ADR-0223 §8). *Proposal* stays English (glossary §A).
 *
 * On a *Syariah* proposal *Premi* is *Kontribusi* everywhere, the disclaimer included (ADR-0221 §9).
 */
export const PDF_WORDS = {
  /** The title: *"Proposal untuk Bapak/Ibu {Nama}"*, verbatim (ADR-0223 §3). */
  title: (name: string) => `Proposal untuk Bapak/Ibu ${name}`,
  /** The line under it: *"Umur {n} (ulang tahun berikutnya) · {Konvensional | Syariah} · {cara bayar}"*. */
  subtitle: (age: number, channel: ProposalChannel, pay: ProposalPayFrequency) =>
    `Umur ${age} (ulang tahun berikutnya) · ${CHANNEL[channel]} · ${PAY[pay]}`,
  /** *Premi* or *Kontribusi* (ADR-0221 §9). */
  premiumWord: (channel: ProposalChannel) => (channel === 'syariah' ? 'Kontribusi' : 'Premi'),
  /** ***{Premi | Kontribusi} per {bulan | kuartal | semester | tahun}*** (ADR-0223 §3). */
  premiumPer: (channel: ProposalChannel, pay: ProposalPayFrequency) =>
    `${PDF_WORDS.premiumWord(channel)} per ${PER[pay]}`,
  /** *"Total dibayar selama {N} tahun: {amount}"*. */
  totalPaid: (years: number, amount: string) => `Total dibayar selama ${years} tahun: ${amount}`,
  /** ***Total premi*** (*Total kontribusi*) per the proposal's *cara bayar*: one line per currency, never summed. */
  totalPremium: (channel: ProposalChannel, pay: ProposalPayFrequency) =>
    `Total ${PDF_WORDS.premiumWord(channel).toLowerCase()} per ${PER[pay]}`,
  /** *Tertanggung* and who: *Klien*, *Pasangan {name}, {age} th*, *Anak …*, or the name alone for *Orang lain*. */
  insuredLabel: 'Tertanggung',
  insured: (relation: ProposalInsuredRelation, name: string | null, age: number | null) => {
    if (relation === 'client') return 'Klien';
    const who = [name ?? '–', age === null ? null : `${age} th`].filter((part) => part !== null).join(', ');
    return relation === 'spouse' ? `Pasangan ${who}` : relation === 'child' ? `Anak ${who}` : who;
  },
  /** The agent, as text with no button (ADR-0223 §3): their name, *"Kode agen {code}"*, their phone. */
  agentCode: (code: string) => `Kode agen ${code}`,
  /** Page 2's heading: the page the spec calls *Rincian*. */
  details: 'Rincian',
  /** Page 2's benefits, from the catalogue (up to four). */
  benefits: 'Manfaat',
  /** A `pdfDetail` block's heading, in the spec's words; *Nilai tunai* says *tidak dijamin* where its source does. */
  block: (block: PdfDetailBlockKind, notGuaranteed: boolean) =>
    block === 'nilai_tunai' && notGuaranteed ? `${BLOCK[block]} — tidak dijamin` : BLOCK[block],
  /** Levels C and D, once above the disclaimer (ADR-0223 §5). */
  fullDetails: 'Rincian lengkap di Ilustrasi Resmi',
  /** The disclaimer, with the insurer's name — **the one place the insurer is named** (decision 5). */
  disclaimer: (insurer: string, channel: ProposalChannel) =>
    `Ringkasan ini bukan ilustrasi resmi. Manfaat dan ${PDF_WORDS.premiumWord(channel).toLowerCase()} mengikuti `
    + `Ilustrasi Resmi dan polis dari ${insurer}.`,
  /** ***Langkah selanjutnya***: *Diskusikan → Lengkapi data → Polis terbit*, on one line. */
  nextSteps: 'Langkah selanjutnya',
  steps: 'Diskusikan → Lengkapi data → Polis terbit',
  /** Both pages' footer, small and grey. */
  footer: 'Dibuat dengan AgencyBoost',
  /** AgencyBoost's wordmark, where the KPM shows no logo of its own. The product's name stays English (§A.5). */
  wordmark: 'AgencyBoost',
  /** A figure that cannot be worked out, or a value left empty: never zero (ADR-0223 §4). */
  none: '–',
  /** The file's own producer (ADR-0222 §6). */
  producer: 'AgencyBoost',
} as const;

const CHANNEL: Record<ProposalChannel, string> = { conventional: 'Konvensional', syariah: 'Syariah' };

const PAY: Record<ProposalPayFrequency, string> = {
  monthly: 'Bulanan', quarterly: 'Kuartalan', semiannual: 'Semesteran', annual: 'Tahunan',
};

const PER: Record<ProposalPayFrequency, string> = {
  monthly: 'bulan', quarterly: 'kuartal', semiannual: 'semester', annual: 'tahun',
};

const BLOCK: Record<PdfDetailBlockKind, string> = {
  manfaat: 'Manfaat utama',
  jadwal: 'Jadwal',
  masa: 'Masa tunggu / berlaku',
  pengecualian: 'Yang tidak ditanggung',
  nilai_tunai: 'Nilai tunai (contoh)',
};
