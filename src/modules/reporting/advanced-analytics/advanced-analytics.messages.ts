import { refusals } from '@/common/i18n/sentence';

/**
 * **The KPM's *Advanced analytics* page's refusals, in both languages** (P19.5-T3; ADR-0215). A field is named as the API
 * names it (`month`, `year`, `periodEnd`, `ab`, `row`, `value`, `aaTarget`, `recTarget`, `section`).
 */
export const ADVANCED_ANALYTICS_REFUSALS = refusals('modules/reporting/advanced-analytics', {
  VALIDATION_FAILED: {
    monthShape: {
      en: 'month must be a month, YYYY-MM, no later than this one',
      id: 'month harus berupa bulan, dengan format YYYY-MM, paling lambat bulan ini',
    },
    yearShape: {
      en: 'year must be a year, YYYY, no later than this one',
      id: 'year harus berupa tahun, dengan format YYYY, paling lambat tahun ini',
    },
    periodEndShape: {
      en: 'periodEnd must be the June or December of a run, YYYY-06 or YYYY-12, that has ended',
      id: 'periodEnd harus Juni atau Desember sebuah periode, YYYY-06 atau YYYY-12, yang sudah berakhir',
    },
    rowShape: ({ rows }: { rows: readonly string[] }) => ({
      en: `row must be one of ${rows.join(', ')}: the rows a target is typed for`,
      id: `row harus salah satu dari ${rows.join(', ')}: baris yang targetnya diketik`,
    }),
    valueShape: {
      en: 'value must be a whole number from 0, or null to clear the target',
      id: 'value harus bilangan bulat mulai dari 0, atau null untuk mengosongkan target',
    },
    targetShape: {
      en: 'aaTarget and recTarget must each be a whole number from 0 to 1000',
      id: 'aaTarget dan recTarget masing-masing harus bilangan bulat dari 0 sampai 1000',
    },
    sectionShape: ({ sections }: { sections: readonly string[] }) => ({
      en: `section must be one of ${sections.join(', ')}`,
      id: `section harus salah satu dari ${sections.join(', ')}`,
    }),
  },
});
