import type { DomainException } from '@/common/errors/domain.exception';
import type { Sentence } from '@/common/i18n/sentence';
import { indonesian, indonesianAll } from '../../../test/i18n';
import { checkLead } from './lead-input';

/**
 * A lead's fields, read without a database (P7-T1).
 *
 * The shape-checking, which is cheaper to state directly than to reach through the service. The rule
 * it once served — a ground before the details — went on 2026-10-07 (ADR-0108 §1); what replaces it
 * is the absence pinned at the end.
 */
describe('reading a lead’s fields (P7-T1)', () => {
  const ok = { name: 'Pak Budi' };

  it('trims a name and refuses one too short to be one', () => {
    expect(checkLead({ name: '  Pak Budi  ' }).name).toBe('Pak Budi');
    expect(() => checkLead({ name: 'B' })).toThrow(/2–120/);
  });

  it('requires a name on create and leaves it alone on a patch', () => {
    expect(() => checkLead({})).toThrow(/name is required/);
    expect(checkLead({}, { partial: true })).toEqual({});
  });

  it('refuses a field nobody defined, rather than dropping it', () => {
    // `forbidNonWhitelisted`, for the path the pipe never sees. A misspelt field quietly ignored
    // is the hardest kind of bug to find.
    expect(() => checkLead({ ...ok, statusCode: 'FOLLOW_UP' }))
      .toThrow(/property statusCode should not exist/);
  });

  it('will not take a status, because a status is a move', () => {
    // P7-T3's, by ADR-0045. The same refusal as any other unknown field, and deliberately so.
    expect(() => checkLead({ ...ok, transitions: [] })).toThrow(/should not exist/);
  });

  describe('contact details', () => {
    it('lower-cases an email and trims a phone', () => {
      const read = checkLead({ ...ok, contact: { phone: ' 0812 ', email: ' Budi@Example.COM ' } });
      expect(read.contact).toEqual({ phone: '0812', email: 'budi@example.com' });
    });

    it('reads a blank string as nothing held', () => {
      // Blank and absent are the same fact about a phone number and should read alike.
      expect(checkLead({ ...ok, contact: { phone: '   ' } }).contact)
        .toEqual({ phone: null, email: null });
    });

    it('refuses something that is not an email address', () => {
      expect(() => checkLead({ ...ok, contact: { email: 'budi' } }))
        .toThrow(/contact.email must be an email address/);
    });

    it('refuses a field inside contact that nobody defined', () => {
      expect(() => checkLead({ ...ok, contact: { whatsapp: '0812' } }))
        .toThrow(/property contact.whatsapp should not exist/);
    });

    it('takes null as clearing both', () => {
      expect(checkLead({ ...ok, contact: null }).contact).toEqual({ phone: null, email: null });
    });

    it('refuses a contact that is not an object of fields', () => {
      expect(() => checkLead({ ...ok, contact: '0812' }))
        .toThrow(/contact must be an object/);
      expect(() => checkLead({ ...ok, contact: ['0812'] }))
        .toThrow(/contact must be an object/);
    });

    it('refuses a phone that is not text, rather than coercing a number', () => {
      // `081234` as a number loses its leading zero, which is most of an Indonesian mobile.
      expect(() => checkLead({ ...ok, contact: { phone: 81234567890 } }))
        .toThrow(/contact.phone must be text/);
    });

    it('refuses one longer than the field holds', () => {
      expect(() => checkLead({ ...ok, contact: { phone: '0'.repeat(40) } }))
        .toThrow(/contact.phone must be at most 32/);
    });

    it('P18.98-T5 AC-3 says every one of them in Indonesian, joined as the message, each field named as the API names it', () => {
      try {
        checkLead({
          ...ok, nextActionDate: '24/09/2026', thisMonth: 'yes', version: 0,
          contact: { phone: 81234567890, email: 'budi', whatsapp: '0812' },
        });
        throw new Error('should have refused');
      } catch (err) {
        const refusal = err as DomainException;
        const violations = [
          'nextActionDate harus berupa tanggal, dengan format YYYY-MM-DD.',
          'thisMonth harus true atau false.',
          'version harus berupa bilangan bulat, yaitu versi data saat dibaca.',
          'properti contact.whatsapp tidak dikenal',
          'contact.phone harus berupa teks.',
          'contact.email harus berupa alamat email.',
        ];
        expect(indonesianAll(refusal.givenDetails!.violations as Sentence[])).toEqual(violations);
        expect(indonesian(refusal.sentence)).toBe(violations.join('; '));
      }
      try {
        checkLead({ ...ok, contact: '0812' });
        throw new Error('should have refused');
      } catch (err) {
        expect(indonesian((err as DomainException).sentence)).toBe('contact harus berupa objek berisi phone dan email.');
      }
      try {
        checkLead({ ...ok, contact: { phone: '0'.repeat(40) } });
        throw new Error('should have refused');
      } catch (err) {
        expect(indonesian((err as DomainException).sentence)).toBe('contact.phone paling banyak 32 karakter.');
      }
    });
  });

  describe('the nullable enums', () => {
    it('reads null on type as a value, not as a violation', () => {
      // A lead may be saved before the agent picks a ladder. `oneOf` reads null as *not one of
      // these*, so the null is taken before the enum sees it.
      expect(checkLead({ ...ok, type: null })).toMatchObject({ type: null });
    });

    it('still refuses a value that is neither null nor one of the names', () => {
      expect(() => checkLead({ ...ok, type: 'referral' })).toThrow(/type/);
    });
  });

  it('refuses a next action date that is not a day', () => {
    expect(() => checkLead({ ...ok, nextActionDate: '24/09/2026' })).toThrow(/YYYY-MM-DD/);
    expect(() => checkLead({ ...ok, nextActionDate: 20261002 })).toThrow(/YYYY-MM-DD/);
    expect(checkLead({ ...ok, nextActionDate: null }).nextActionDate).toBeNull();
  });

  it('refuses a commitment that is not a yes or a no', () => {
    expect(() => checkLead({ ...ok, thisMonth: 'yes' })).toThrow(/true or false/);
  });

  describe('P13.1-T4 AC-1 — no ground is asked for (ADR-0108 §1)', () => {
    it('P13.1-T4 AC-1 takes a phone and an email with nothing beside them', () => {
      expect(checkLead({ ...ok, contact: { phone: '0812-1100-2200', email: 'budi@example.com' } }).contact)
        .toEqual({ phone: '0812-1100-2200', email: 'budi@example.com' });
    });

    it('P13.1-T4 AC-1 refuses lawfulBasis by name, as a field nobody defines any more', () => {
      // Refused rather than dropped: a client that believes it is recording a ground is told it is not.
      expect(() => checkLead({ ...ok, lawfulBasis: 'consent' })).toThrow(/property lawfulBasis should not exist/);
      expect(() => checkLead({ lawfulBasis: null }, { partial: true })).toThrow(/property lawfulBasis should not exist/);
    });

    it('P13.1-T4 AC-1 never hands the service a lawfulBasis to write', () => {
      expect(checkLead({ ...ok, contact: { phone: '0812' } })).not.toHaveProperty('lawfulBasis');
    });
  });
});
