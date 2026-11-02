import { refusals } from '@/common/i18n/sentence';

/**
 * **Why a ratio cannot have the unit asked for, in both languages** (P18.98-T5 AC-2; P4-T25) — worded once, by
 * `resolveDisplayUnit`, and refused under `CONFIG_RATIO_UNIT_MISMATCH` (or, where a caller refuses a whole template,
 * re-filed under its own code). *Ratio*, *benchmark* and *points* stay as the glossary keeps them (§A.6, §B.7 *poin*).
 */
export const RATIO_DISPLAY_REFUSALS = refusals('domain/ratio-display', {
  CONFIG_RATIO_UNIT_MISMATCH: {
    unknownUnit: ({ requested }: { requested: string }) => ({
      en: `${requested} is not a way to show a benchmark. Use percent, decimal or points.`,
      id: `${requested} bukan cara menampilkan benchmark. Gunakan percent, decimal, atau points.`,
    }),
    balanceIsPoints: {
      en: 'A balance ratio is judged in percentage points either side of an even split, '
        + 'so its benchmark is shown in points.',
      id: 'Ratio keseimbangan dinilai dalam poin persentase di kedua sisi pembagian rata, '
        + 'jadi benchmark-nya ditampilkan dalam poin.',
    },
    pointsAreForBalance: {
      en: 'Points are for the balance rule, which is judged either side of an even split. '
        + 'A ratio judged at or above its benchmark is shown as a percentage or as a number.',
      id: 'Poin hanya untuk aturan keseimbangan, yang dinilai di kedua sisi pembagian rata. '
        + 'Ratio yang dinilai mencapai atau melampaui benchmark-nya ditampilkan sebagai persentase atau angka.',
    },
  },
});
