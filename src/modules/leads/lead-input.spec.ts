import { checkLead, requireLawfulBasis } from './lead-input';

/**
 * A lead's fields, read without a database (P7-T1).
 *
 * The service spec exercises the **rule** that matters — a ground before the details — end to end.
 * What is here is the shape-checking underneath it, which is cheaper to state directly and which a
 * service test would only reach by accident.
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
      // Blank and absent are the same fact about a phone number and should read alike — which
      // also means blanking one lifts the lawful-basis requirement rather than tripping it.
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
  });

  describe('the nullable enums', () => {
    it.each(['type', 'lawfulBasis'])('reads null on %s as a value, not as a violation', (field) => {
      // A lead may be saved before the agent picks a ladder, and a ground may be withdrawn.
      // `oneOf` reads null as *not one of these*, so the null is taken before the enum sees it.
      expect(checkLead({ ...ok, [field]: null })).toMatchObject({ [field]: null });
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

  describe('the ground for holding contact details', () => {
    const held = { phone: '0812', email: null };
    const none = { phone: null, email: null };

    it('says nothing when there is nothing to hold', () => {
      expect(() => requireLawfulBasis({ contact: none, lawfulBasis: null })).not.toThrow();
    });

    it('refuses details with no ground, and names the ones it would take', () => {
      try {
        requireLawfulBasis({ contact: held, lawfulBasis: null });
        throw new Error('should have refused');
      } catch (err) {
        const details = (err as { details?: { allowed?: string[] } }).details;
        expect(details?.allowed).toEqual(['consent', 'contract', 'legitimate_interest']);
      }
    });

    it('takes details once a ground is recorded', () => {
      expect(() => requireLawfulBasis({ contact: held, lawfulBasis: 'consent' })).not.toThrow();
    });
  });
});
