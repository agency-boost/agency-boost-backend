import { BINDING_CODES_MAX } from '@/domain/constants';
import { bindingProblems, defaultBinding } from './activity-binding';

/** `bindingProblems`, the one checker (ADR-0163 §1): the limit on a stage's list, pinned at its edge. */
describe('ADR-0163 — a cascade stage binds at most BINDING_CODES_MAX codes', () => {
  const codes = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}_${i + 1}`);
  const known = (...lists: string[][]) => new Set(lists.flat());

  it('the default binding is valid', () => {
    const d = defaultBinding();
    expect(bindingProblems(d, known(d.leads, d.appointments, d.closings))).toEqual([]);
  });

  it(`a stage of ${BINDING_CODES_MAX} codes is accepted`, () => {
    const binding = { leads: codes(BINDING_CODES_MAX, 'LEAD'), appointments: ['MEET'], closings: ['CLOSE'] };
    expect(bindingProblems(binding, known(binding.leads, ['MEET', 'CLOSE']))).toEqual([]);
  });

  it(`a stage of ${BINDING_CODES_MAX + 1} is refused, and says the limit`, () => {
    const binding = { leads: ['LEAD'], appointments: codes(BINDING_CODES_MAX + 1, 'MEET'), closings: ['CLOSE'] };
    expect(bindingProblems(binding, known(['LEAD', 'CLOSE'], binding.appointments))).toEqual([
      `Sales meeting names ${BINDING_CODES_MAX + 1} activity types; at most ${BINDING_CODES_MAX}.`,
    ]);
  });
});
