import { BINDING_CODES_MAX } from '@/domain/constants';
import { bindingProblems, defaultBinding } from './activity-binding';
import { englishAll, indonesianAll } from '../../../test/i18n';

/** `bindingProblems`, the one checker (ADR-0163 §1): the limit on a stage's list, pinned at its edge. */
describe('ADR-0163 — a cascade stage binds at most BINDING_CODES_MAX codes', () => {
  const codes = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}_${i + 1}`);
  const known = (...lists: string[][]) => new Set(lists.flat());

  it('the default binding is valid', () => {
    const d = defaultBinding();
    expect(englishAll(bindingProblems(d, known(d.leads, d.appointments, d.closings)))).toEqual([]);
  });

  it(`a stage of ${BINDING_CODES_MAX} codes is accepted`, () => {
    const binding = { leads: codes(BINDING_CODES_MAX, 'LEAD'), appointments: ['MEET'], closings: ['CLOSE'] };
    expect(englishAll(bindingProblems(binding, known(binding.leads, ['MEET', 'CLOSE'])))).toEqual([]);
  });

  it(`a stage of ${BINDING_CODES_MAX + 1} is refused, and says the limit`, () => {
    const binding = { leads: ['LEAD'], appointments: codes(BINDING_CODES_MAX + 1, 'MEET'), closings: ['CLOSE'] };
    expect(englishAll(bindingProblems(binding, known(['LEAD', 'CLOSE'], binding.appointments)))).toEqual([
      `Sales meeting names ${BINDING_CODES_MAX + 1} activity types; at most ${BINDING_CODES_MAX}.`,
    ]);
  });

  it('P18.10-T5 AC-3 says each problem in Indonesian too, the cascade’s three activities as the client names them', () => {
    const binding = { leads: ['LEAD', 'LEAD'], appointments: ['LEAD', 'GHOST'], closings: [] };
    expect(indonesianAll(bindingProblems(binding, known(['LEAD'])))).toEqual([
      'Set appointment menyebut LEAD dua kali.',
      'LEAD dikaitkan ke Set appointment sekaligus Sales meeting. Satu aktivitas dihitung di satu tempat saja.',
      'Sales meeting menyebut GHOST, yang bukan jenis aktivitas di sini.',
      'Submission polis tidak menghitung jenis aktivitas apa pun. Kaitkan paling sedikit satu, atau ringkasan tidak akan '
        + 'menghitung apa pun untuknya.',
    ]);
    expect(indonesianAll(bindingProblems(null, known()))).toEqual([
      'Pengaitan aktivitas harus menyebutkan kode untuk Set appointment, Sales meeting, dan Submission polis.',
    ]);
  });
});
