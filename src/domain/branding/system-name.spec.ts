import { BRANDING } from '@/domain/constants/branding';
import { checkSystemName, withSystemName } from './system-name';

/** ***Nama sistem*** (P19.21-T4 AC-1; ADR-0274): the check *Simpan* makes, and the replacement emails take. */
describe('P19.21-T4 AC-1 the system name', () => {
  it('P19.21-T4 AC-1 pins its bounds: at most 40 characters, AgencyBoost by default, read again after 60 s', () => {
    expect(BRANDING.SYSTEM_NAME_MAX_LENGTH).toBe(40);
    expect(BRANDING.DEFAULT_SYSTEM_NAME).toBe('AgencyBoost');
    expect(BRANDING.SYSTEM_NAME_CACHE_SECONDS).toBe(60);
  });

  it('P19.21-T4 AC-1 keeps a name trimmed, and null as cleared', () => {
    expect(checkSystemName('  Dynamic Smart System ')).toEqual({ ok: true, value: 'Dynamic Smart System' });
    expect(checkSystemName(null)).toEqual({ ok: true, value: null });
    expect(checkSystemName('x'.repeat(40))).toEqual({ ok: true, value: 'x'.repeat(40) });
    // Counted as characters a person sees, not UTF-16 units.
    expect(checkSystemName('é'.repeat(40))).toMatchObject({ ok: true });
  });

  it('P19.21-T4 AC-1 refuses a blank, a name over 40 characters, a control character or anything not text', () => {
    expect(checkSystemName('   ')).toEqual({ ok: false, problem: 'systemNameBlank' });
    expect(checkSystemName('')).toEqual({ ok: false, problem: 'systemNameBlank' });
    expect(checkSystemName(42)).toEqual({ ok: false, problem: 'systemNameBlank' });
    expect(checkSystemName(undefined)).toEqual({ ok: false, problem: 'systemNameBlank' });
    expect(checkSystemName('x'.repeat(41))).toEqual({ ok: false, problem: 'systemNameTooLong' });
    expect(checkSystemName('Dynamic\nSmart')).toEqual({ ok: false, problem: 'systemNameControl' });
    expect(checkSystemName('Dynamic\tSmart')).toEqual({ ok: false, problem: 'systemNameControl' });
    expect(checkSystemName('Dynamic\u0085Smart')).toEqual({ ok: false, problem: 'systemNameControl' });
  });

  it('P19.21-T4 AC-1 writes every AgencyBoost as the name, and leaves the text alone without one', () => {
    expect(withSystemName('[AgencyBoost] Peran Anda berubah\n— AgencyBoost', 'DSS')).toBe('[DSS] Peran Anda berubah\n— DSS');
    expect(withSystemName('Selamat datang di AgencyBoost', null)).toBe('Selamat datang di AgencyBoost');
    expect(withSystemName('AgencyBoost', 'AgencyBoost')).toBe('AgencyBoost');
    expect(withSystemName('agencyboost.id', 'DSS')).toBe('agencyboost.id');
  });
});
