import { HttpStatus } from '@nestjs/common';
import { readerIn } from '@/common/i18n/reader';
import { DomainException } from '@/common/errors/domain.exception';
import { hasVerifiedAddress, refuseUnverifiedAddress } from './verified-address';

/**
 * **What still needs a proven address** (P19-T1 AC-4; UI-163, ADR-0190 §4): an account signs in before its address is
 * verified, so being made a KPM's Owner asks for one itself. The rule is pure; where an Owner is assigned calls it.
 */
describe('P19-T1 AC-4 a proven address, where one is still needed', () => {
  const refusalOf = (user: Parameters<typeof refuseUnverifiedAddress>[0]): DomainException => {
    try {
      refuseUnverifiedAddress(user);
    } catch (err) {
      return err as DomainException;
    }
    throw new Error('expected a refusal');
  };

  it('P19-T1 AC-4 lets a verified address through', () => {
    expect(() => refuseUnverifiedAddress({ email: 'victor@kpm.test', emailVerifiedAt: new Date('2026-11-01T00:00:00Z') }))
      .not.toThrow();
    expect(hasVerifiedAddress({ emailVerifiedAt: new Date() })).toBe(true);
  });

  it.each([
    ['null', null],
    ['absent', undefined],
  ])('P19-T1 AC-4 refuses making an address that is %s a KPM’s Owner: 409 AUTH_EMAIL_NOT_VERIFIED naming it', (_what, at) => {
    const refused = refusalOf({ email: 'victor@kpm.test', emailVerifiedAt: at, _id: 'u-victor' });
    expect(refused.code).toBe('AUTH_EMAIL_NOT_VERIFIED');
    expect(refused.getStatus()).toBe(HttpStatus.CONFLICT);
    expect(refused.details).toEqual({ userId: 'u-victor' });
    expect(refused.message).toBe(
      'victor@kpm.test has not been verified yet. They verify it from the link in their email, or with Send again on '
        + 'the banner once they sign in, and can then be made the Owner.',
    );
    expect(hasVerifiedAddress({ emailVerifiedAt: at })).toBe(false);
  });

  it('P19-T1 AC-4 says it in Indonesian to an Indonesian reader', () => {
    const refused = refusalOf({ email: 'victor@kpm.test', emailVerifiedAt: null, id: 'u-victor' });
    expect(refused.messageFor(readerIn('id'))).toBe(
      'victor@kpm.test belum diverifikasi. Pemilik alamat itu memverifikasinya lewat tautan di emailnya, atau lewat Kirim '
        + 'ulang pada banner setelah masuk, lalu baru dapat dijadikan Owner.',
    );
  });
});
