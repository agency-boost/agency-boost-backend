import { refusals } from '@/common/i18n/sentence';

/**
 * **The monthly targets per AB group's refusals, in both languages** (P19.17-T4; ADR-0270 §4). *Target* stays English
 * (§A.6); the office is *KPM* (§B.9).
 */
export const AB_GROUP_TARGET_REFUSALS = refusals('modules/reporting/ab-group-targets', {
  AB_GROUP_TARGET_MONTH_CLOSED: {
    closed: {
      en: 'A target can be set from January 2024 to a year ahead.',
      id: 'Target bisa diatur dari Januari 2024 sampai setahun ke depan.',
    },
  },
  VALIDATION_FAILED: {
    /** `AbGroupTargetsQueryDto.month`, `SetAbGroupTargetDto.month` (`field`). */
    monthShape: {
      en: 'month must be YYYY-MM',
      id: 'month harus dengan format YYYY-MM',
    },
  },
});
