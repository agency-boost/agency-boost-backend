import { messages } from '@/common/i18n/sentence';
import { UNIT_DASHBOARD_CORRECTION_REASON } from './unit-dashboard';

/**
 * **The reason a leader's *Update production* stores on every cell it changes, in both languages** (P18.10-T5 AC-6;
 * OD-137, ADR-0121). The API writes it for the leader — the dialog asks for none — so it is **stored in the language of
 * the leader who saved**, as text (`ProductionCorrections.correctApe` writes it for `ctx.reader`), and shown as stored:
 * the month table, the next import's preview and the audit log read the words that were written. The English is
 * `UNIT_DASHBOARD_CORRECTION_REASON`, byte for byte — what every cell saved before the phase holds.
 */
export const UNIT_DASHBOARD_MESSAGES = messages('domain/unit-dashboard', {
  correctionReason: {
    en: UNIT_DASHBOARD_CORRECTION_REASON,
    id: 'Diperbarui di Unit Dashboard dari laporan perusahaan.',
  },
});
