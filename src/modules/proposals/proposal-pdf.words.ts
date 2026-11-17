/**
 * **Every word the proposal's PDF prints that is not the catalogue's or the agent's** (P19.14-T3; ADR-0256 §6; the 11 Nov
 * spec's *The PDF design*). **Indonesian only, whatever language the agent reads the app in**: the file is the client's
 * document (ADR-0223 §8, kept). *Proposal* stays English (glossary §A).
 *
 * **A syariah product speaks its own words** (P19.14-T2 AC-1; ADR-0255 §1): *Kontribusi* for *Premi*, *Santunan
 * asuransi* for *Uang pertanggungan*. There is no proposal-wide channel any more, so a sentence that speaks of every
 * product at once — the disclaimer, the first step — says *kontribusi* when every product is syariah, *premi* when none
 * is, and *premi/kontribusi* when they are mixed.
 *
 * **No word here is a placeholder.** The mockups' *"Rp ●●●"*, *"dari ilustrasi"* and *"dari tabel tarif"* mark values the
 * file never prints: a row whose value is not known is left out (ADR-0256 §4).
 */

/** How a sentence speaks of what the client pays, from the products' syariah flags. */
export type PremiumWord = 'premi' | 'kontribusi' | 'premi/kontribusi';

/** Indonesian month names in full: the header's date reads *11 November 2026*, as the mockups do. */
const MONTHS = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
] as const;

export const PDF_WORDS = {
  /** *"Proposal perlindungan keluarga"*: the header's tagline, before the date. */
  tagline: 'Proposal perlindungan keluarga',
  /** The header's kicker over the client's name. */
  preparedFor: 'DISIAPKAN KHUSUS UNTUK',
  /** *Bapak*, *Ibu*, or *Bapak/Ibu* where the proposal holds no gender. */
  honorific: (gender: 'male' | 'female' | null) => (gender === 'male' ? 'Bapak' : gender === 'female' ? 'Ibu' : 'Bapak/Ibu'),
  /** The file's title (`info.title`): *"Proposal untuk Bapak Budi Contoh"*. */
  title: (client: string) => `Proposal untuk ${client}`,

  // ---- page 1
  about: (short: string) => `Tentang ${short}`,
  age: 'Usia',
  years: (n: number) => `${n} tahun`,
  gender: 'Jenis kelamin',
  genders: { male: 'Laki-laki', female: 'Perempuan' } as const,
  status: 'Status',
  statuses: { single: 'Lajang', married: 'Menikah' } as const,
  dependants: 'Tanggungan',
  occupation: 'Pekerjaan',
  city: 'Kota',
  discussed: 'Yang dibahas:',
  /** *Yang dibahas*, as step 1's chips read them (ADR-0254 §3); *Lainnya* prints the agent's own words. */
  needs: {
    HOSPITAL: 'Biaya rumah sakit',
    CRITICAL_INCOME: 'Penghasilan saat sakit kritis',
    FAMILY: 'Santunan keluarga',
    EDUCATION: 'Dana pendidikan',
    FUTURE: 'Dana masa depan / pensiun',
    OTHER: 'Lainnya',
  } as const,
  summary: 'Ringkasan',
  /** *"Total per bulan"*: the total block's label, by the group's *Cara bayar*. */
  totalPer: (per: string) => `Total ${per}`,
  /** *"3 produk bayar bulanan."* */
  groupLine: (count: number, adverb: string) => `${count} produk bayar ${adverb}.`,
  /** *"PRUTahapan dibayar per tahun."*, *"PRU Prosper dalam USD."*, *"PCB88 sekali bayar."* */
  otherPer: (name: string, per: string) => `${name} dibayar ${per}.`,
  otherCurrency: (name: string, currency: string) => `${name} dalam ${currency}.`,
  otherSingle: (name: string) => `${name} sekali bayar.`,
  othersApart: (names: string) => `${names} dibayar terpisah.`,
  /** The need tiles: one per need, in the spec's order; *✓ terlindungi* or *✓ terencana* when a product covers it. */
  needTiles: {
    HOSPITAL: 'Kesehatan',
    CRITICAL_INCOME: 'Sakit kritis',
    FAMILY: 'Keluarga',
    EDUCATION: 'Pendidikan',
    FUTURE: 'Masa depan',
  } as const,
  protectedState: '✓ terlindungi',
  plannedState: '✓ terencana',
  /** A need the client discussed and no product covers: the grey tile. */
  openState: 'belum ada',
  programs: 'Program yang ditawarkan',
  /** *"Untuk: Bapak Budi"*, *"Untuk: Raka (anak, 8 th)"*. */
  forWhom: (who: string) => `Untuk: ${who}`,
  insuredOf: (relation: 'spouse' | 'child' | 'other', name: string | null, age: number | null) => {
    const role = relation === 'spouse' ? 'pasangan' : relation === 'child' ? 'anak' : null;
    const tail = [role, age === null ? null : `${age} th`].filter((part): part is string => part !== null).join(', ');
    if (!name) return `${role ? role[0].toUpperCase() + role.slice(1) : 'Tertanggung'}${age === null ? '' : ` (${age} th)`}`;
    return tail ? `${name} (${tail})` : name;
  },
  /** The sum assured in a card's line: *"UP Rp 500 juta"*, a syariah product's *"Santunan Rp 500 juta"*. */
  upShort: (syariah: boolean) => (syariah ? 'Santunan' : 'UP'),
  upLabel: (syariah: boolean) => (syariah ? 'Santunan asuransi' : 'Uang pertanggungan'),
  /** *per bulan*, *per kuartal*, *per semester*, *per tahun*, *sekali bayar*. */
  per: {
    monthly: 'per bulan', quarterly: 'per kuartal', semiannual: 'per semester', annual: 'per tahun', single: 'sekali bayar',
  } as const,
  /** *"3 produk bayar bulanan."* */
  adverb: { monthly: 'bulanan', quarterly: 'kuartalan', semiannual: 'semesteran', annual: 'tahunan', single: 'sekali' } as const,
  /** The pay term in a pill: *"10 tahun"*, *"s/d usia 60"*. */
  payYears: (n: number) => `${n} tahun`,
  payToAge: (age: number) => `s/d usia ${age}`,
  payTerm: 'Lama bayar',
  totalPaid: 'Total dibayar',
  /** **Where an item's premium comes from** (the spec's *Premium and UP*): the premium table's date, or the illustration. */
  fromTable: (date: string) => `Tabel tarif berlaku ${date}`,
  fromIllustration: (syariah: boolean) => `${syariah ? 'Kontribusi' : 'Premi'} dari ilustrasi resmi`,
  /** *Nilai tunai*'s row says *tidak dijamin* where its source does. */
  notGuaranteed: 'tidak dijamin',
  /** An exclusion whose row gives no value of its own. */
  notCovered: 'tidak ditanggung',
  protection: 'Perlindungan Anda',
  goodToKnow: 'Yang perlu diketahui',
  stepsLabel: 'LANGKAH:',
  /** *Langkah selanjutnya*: the three cards of page 2, the line of a one-page file. */
  nextSteps: 'Langkah selanjutnya',
  steps: (word: PremiumWord) => [
    { title: 'Diskusikan', text: `Pastikan manfaat dan ${word} sesuai` },
    { title: 'Lengkapi data', text: 'Formulir, periksa kesehatan bila perlu' },
    { title: 'Polis terbit', text: 'Perlindungan resmi berlaku' },
  ],

  // ---- page 2
  details: 'RINCIAN PROGRAM',
  /** The education timeline's line, above *SD → SMP → SMA → Kuliah*. */
  timeline: 'Dana cair saat anak masuk:',
  /** **The disclaimer, naming the insurer** — the one place the insurer is named (decision 5, kept). */
  disclaimer: (insurer: string, word: PremiumWord) =>
    `Ringkasan ini bukan ilustrasi resmi dan bukan kontrak. Manfaat, ketentuan dan ${word} final mengikuti Ilustrasi `
    + `Resmi serta polis dari ${insurer || 'perusahaan asuransi'}.`,
  agent: 'Agen',
  agentCode: (code: string) => `Kode ${code}`,
  callMe: ['Hubungi saya', 'untuk diskusi'] as const,
  /** The footer of a page without the agent block: *"disiapkan oleh Rina Wijaya, 0812 …"*. */
  preparedBy: (parts: string) => `disiapkan oleh ${parts}`,
  page: (at: number, of: number) => `Halaman ${at} dari ${of}`,

  /**
   * **AgencyBoost's name, where the KPM shows no branding** (ADR-0256 §5): the header, page 2's band, the footer and the
   * file's producer. **With branding it is printed nowhere** — the KPM's name stands in each place.
   */
  agencyBoost: 'AgencyBoost',

  /** *11 November 2026*, from `YYYY-MM-DD`. */
  longDate: (day: string): string => {
    const [y, m, d] = day.split('-').map(Number);
    return `${d} ${MONTHS[m - 1] ?? ''} ${y}`;
  },
} as const;

/** How every product's sentence speaks of the premium: *kontribusi* when all are syariah, *premi* when none are. */
export function premiumWordOf(syariah: readonly boolean[]): PremiumWord {
  if (syariah.length > 0 && syariah.every(Boolean)) return 'kontribusi';
  return syariah.some(Boolean) ? 'premi/kontribusi' : 'premi';
}
