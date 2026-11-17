import { DomainException } from '@/common/errors/domain.exception';
import { checkClientDetails, clientAfter, clientPrefillOf, detailsOf, EMPTY_CLIENT_DETAILS } from './proposal-client';

const refusal = (fn: () => unknown) => {
  try { fn(); } catch (e) { return { code: (e as DomainException).code, status: (e as DomainException).getStatus(), details: (e as DomainException).details }; }
  throw new Error('not refused');
};

const TODAY = '2026-11-12';

/**
 * **P19.14-T1 AC-3, AC-5 — the client, on the proposal and nowhere else** (ADR-0254 §1–§4): the age and the gender
 * required, the details optional and checked, the age dated, and a later proposal's prefill with the age moved up.
 */
describe('P19.14-T1 the proposal’s client (proposal-client.ts)', () => {
  it('P19.14-T1 AC-3 takes the age and the gender, dates the age today, and starts with empty details', () => {
    expect(clientAfter(null, { age: 36, gender: 'male' }, 'Pak Budi', TODAY)).toEqual({
      name: 'Pak Budi', age: 36, ageSetOn: TODAY, gender: 'male', details: EMPTY_CLIENT_DETAILS,
    });
  });

  it('P19.14-T1 AC-3 Lanjut needs the age and the gender: either missing is 400 naming it', () => {
    expect(refusal(() => clientAfter(null, { gender: 'female' }, 'A', TODAY))).toMatchObject({ status: 400, details: { field: 'client.age' } });
    expect(refusal(() => clientAfter(null, { age: 30 }, 'A', TODAY))).toMatchObject({ status: 400, details: { field: 'client.gender' } });
    expect(refusal(() => clientAfter(null, { age: 30, gender: 'x' }, 'A', TODAY))).toMatchObject({ details: { field: 'client.gender' } });
  });

  it('P19.14-T1 AC-3 an age outside 1–100 is 422 LEAD_AGE_OUT_OF_RANGE naming client.age; a fraction 400', () => {
    expect(refusal(() => clientAfter(null, { age: 0, gender: 'male' }, 'A', TODAY)))
      .toMatchObject({ code: 'LEAD_AGE_OUT_OF_RANGE', status: 422, details: { min: 1, max: 100, field: 'client.age' } });
    expect(refusal(() => clientAfter(null, { age: 35.5, gender: 'male' }, 'A', TODAY))).toMatchObject({ status: 400 });
  });

  it('P19.14-T1 AC-3 lays what is sent over what is stored: an unchanged age keeps its day, a new one is dated today', () => {
    const stored = clientAfter(null, { age: 36, gender: 'male', details: { city: 'Bandung' } }, 'A', '2026-01-01');
    expect(clientAfter(stored, { age: 36 }, 'A', TODAY)).toMatchObject({ age: 36, ageSetOn: '2026-01-01', details: { city: 'Bandung' } });
    expect(clientAfter(stored, { age: 37 }, 'A', TODAY)).toMatchObject({ age: 37, ageSetOn: TODAY });
    expect(clientAfter(stored, { gender: 'female' }, 'B', TODAY)).toMatchObject({ name: 'B', gender: 'female', age: 36 });
    expect(clientAfter(stored, { details: { occupation: 'Guru' } }, 'A', TODAY).details).toEqual({ ...EMPTY_CLIENT_DETAILS, occupation: 'Guru' });
  });

  it('P19.14-T1 AC-3 the details: status, the texts one line and trimmed, the needs once each in order, Lainnya only with OTHER', () => {
    expect(checkClientDetails({
      status: 'married', dependants: '  Istri, <b>2</b> anak ', occupation: '', city: 'Bandung',
      needs: ['EDUCATION', 'HOSPITAL', 'EDUCATION', 'OTHER'], needsOther: 'Warisan',
    })).toEqual({
      status: 'married', dependants: 'Istri, 2 anak', occupation: null, city: 'Bandung',
      needs: ['HOSPITAL', 'EDUCATION', 'OTHER'], needsOther: 'Warisan',
    });
    expect(checkClientDetails({ needs: ['FAMILY'], needsOther: 'Dropped' })).toMatchObject({ needs: ['FAMILY'], needsOther: null });
    expect(checkClientDetails(null)).toEqual(EMPTY_CLIENT_DETAILS);
  });

  it.each([
    [{ status: 'divorced' }, 'client.details.status'],
    [{ needs: ['NOPE'] }, 'client.details.needs'],
    [{ needs: 'HOSPITAL' }, 'client.details.needs'],
    [{ city: 5 }, 'client.details.city'],
    [{ city: 'x'.repeat(61) }, 'client.details.city'],
    [{ birthDate: '1991-05-01' }, 'client.details.birthDate'],
    ['text', 'client.details'],
  ])('P19.14-T1 AC-3 refuses details %p with 400 naming %s', (details, field) => {
    expect(refusal(() => checkClientDetails(details))).toMatchObject({ status: 400, details: { field } });
  });

  it('P19.14-T1 AC-5 a later proposal starts from the last: the age moved up a year after each anniversary of its day', () => {
    const last = { age: 35, ageSetOn: '2025-11-13', gender: 'female' as const, details: { ...EMPTY_CLIENT_DETAILS, city: 'Bandung' } };
    expect(clientPrefillOf(last, '2026-11-12')).toEqual({ age: 35, gender: 'female', details: last.details });
    expect(clientPrefillOf(last, '2026-11-13').age).toBe(36);
    expect(clientPrefillOf({ ...last, ageSetOn: '2020-01-01', age: 99 }, TODAY).age).toBe(100);
    expect(clientPrefillOf({ age: null, ageSetOn: null, gender: null, details: undefined as never }, TODAY))
      .toEqual({ age: null, gender: null, details: EMPTY_CLIENT_DETAILS });
  });

  it('P19.14-T1 AC-3 a proposal made before P19.14 reads empty details', () => {
    expect(detailsOf(undefined)).toEqual(EMPTY_CLIENT_DETAILS);
    expect(detailsOf({ city: 'Solo' })).toEqual({ ...EMPTY_CLIENT_DETAILS, city: 'Solo' });
  });
});
