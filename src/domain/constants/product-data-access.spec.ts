import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PREMIUM_TABLE_NOTICES, PRODUCT_DATA_CHANGES } from './index';

/** `metrics-and-definitions.md` §B.41: *Perubahan oleh pengelola*'s page and the two notices' days and time. */
describe('Kelola data produk and the premium table notices (§B.41)', () => {
  it('P19.15-T4 AC-2 pins 50 changes a page', () => {
    expect(PRODUCT_DATA_CHANGES).toEqual({ PAGE_SIZE: 50 });
  });

  it('P19.15-T4 AC-4 pins the notice 15 days ahead and the daily run at 00:10 office time', () => {
    expect(PREMIUM_TABLE_NOTICES).toEqual({ EXPIRY_NOTICE_DAYS: 15, DAILY_RUN_AT: '00:10' });
  });

  it('P19.15-T4 AC-4: the timer starts the run at that time, in Asia/Jakarta', () => {
    const timer = readFileSync(join(__dirname, '../../../deploy/systemd/agencyboost-daily.timer'), 'utf8');
    expect(timer).toMatch(new RegExp(`^OnCalendar=\\*-\\*-\\* ${PREMIUM_TABLE_NOTICES.DAILY_RUN_AT}:00 Asia/Jakarta$`, 'm'));
  });

  it('is frozen, so no caller can move a number at run time', () => {
    expect(Object.isFrozen(PRODUCT_DATA_CHANGES)).toBe(true);
    expect(Object.isFrozen(PREMIUM_TABLE_NOTICES)).toBe(true);
  });
});
