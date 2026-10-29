import { formatNumber } from '@/common/format/format';
import { messages } from '@/common/i18n/sentence';

/** A count in an Indonesian sentence: *1.000*, the same digits below a thousand. English keeps the number as it was. */
const n = (count: number) => formatNumber(count, undefined, 'id');

/** *all three must be met*: the prototype's words for a count, to ten. */
const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** *ketiganya harus terpenuhi* — *all three of them* — from two to ten; any other count is said with its figure. */
const ALL_OF_THEM = [
  '', '', 'keduanya', 'ketiganya', 'keempatnya', 'kelimanya', 'keenamnya', 'ketujuhnya', 'kedelapannya',
  'kesembilannya', 'kesepuluhnya',
];

/**
 * **What MOC's dialog and the column's tooltip say, in both languages** (P18.98-T5 AC-4; `KPM_Owner.html:1248`,
 * `:3302-3316`): the sentence about the paths, what is not uploaded, and the words that join a rule's criteria. The
 * criteria are the registry's names (*Net APE*, *Monthly2 AA*, *Rolling Persistency*, *Direct AB (AB on AB)*) and stay
 * English in both (the approved glossary's §A.4), as *MOC* does (§A.5); a rung is the company's code. *Not uploaded
 * yet* is §B.3's *Belum diunggah*.
 */
export const MOC_MESSAGES = messages('domain/moc-status', {
  standardPath: {
    en: 'Met via the standard three-criteria path.',
    id: 'Terpenuhi melalui jalur standar tiga kriteria.',
  },
  overridePath: {
    en: 'Met via the Direct AB (AB on AB) override path.',
    id: 'Terpenuhi melalui jalur alternatif Direct AB (AB on AB).',
  },
  needs: ({ reach }: { reach: number }) => ({
    en: `Needs to clear either the three standard criteria together, or reach ${reach} Direct ABs.`,
    id: `Perlu memenuhi ketiga kriteria standar sekaligus, atau mencapai ${n(reach)} Direct ABs.`,
  }),
  /** `rung`: the rung the rule applies to, or `null` for a rule naming none (*These requirements …*). */
  noAlternatePath: ({ rung, count }: { rung: string | null; count: number }) => ({
    en: `${rung ?? 'These'} requirements have no alternate path — all ${COUNT_WORDS[count] ?? String(count)} must be met.`,
    id: `${rung === null ? 'Syarat ini' : `Syarat ${rung}`} tidak memiliki jalur alternatif — `
      + `${ALL_OF_THEM[count] || `semua ${n(count)} syarat`} harus terpenuhi.`,
  }),
  /** The criteria whose input is not uploaded, by name. */
  missing: ({ labels }: { labels: readonly string[] }) => ({
    en: `Not uploaded yet: ${labels.join(', ')}.`,
    id: `Belum diunggah: ${labels.join(', ')}.`,
  }),
  /** Before an OR group's first criterion in the dialog: *— OR — Direct AB (AB on AB)*. */
  orBefore: { en: '— OR — ', id: '— ATAU — ' },
  /** Between a rule's criteria and groups in the tooltip. */
  and: { en: ' AND ', id: ' DAN ' },
  or: { en: ' OR ', id: ' ATAU ' },
});
