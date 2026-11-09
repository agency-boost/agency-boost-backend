import { englishAll, indonesianAll } from '../../../test/i18n';
import { defaultEventTypes, eventTypesProblems } from './event-types-payload';

/**
 * **A template's event types, refused in both languages** (P18.10-T5 AC-3; P5-T9 AC-4): `eventTypesProblems` answers
 * sentences, which publishing and provisioning write for their reader. The English is the API's as it always was —
 * `template-payloads.spec.ts` pins each rule — and every one of them reads in Bahasa Indonesia.
 */
describe('P18.10-T5 AC-3 an event types payload’s problems, in both languages', () => {
  it('P18.10-T5 AC-3 the platform defaults have none', () => {
    expect(eventTypesProblems(defaultEventTypes())).toEqual([]);
  });

  it('P18.10-T5 AC-3 a payload that is not a list, and an empty one', () => {
    expect(englishAll(eventTypesProblems({}))).toEqual(['types must be a list.']);
    expect(indonesianAll(eventTypesProblems(null))).toEqual(['types harus berupa daftar.']);
    expect(englishAll(eventTypesProblems({ types: [] })))
      .toEqual(['An event type list with no types gives every new office nothing to file an event under.']);
    expect(indonesianAll(eventTypesProblems({ types: [] })))
      .toEqual(['Daftar jenis event tanpa satu jenis pun membuat setiap KPM baru tidak punya jenis untuk mencatat event.']);
  });

  it('P18.10-T5 AC-3 every rule a row can break, each named by its place in the list', () => {
    const problems = eventTypesProblems({
      types: [
        { label: 'Training' },
        { code: 'TRAINING', label: 'Training' },
        { code: 'training', label: 'Latihan' },
        { code: '1ST-EVENT', label: 'First' },
        { code: 'BLANK', label: '   ' },
        { code: 'BLUE', label: 'Blue', color: 'blue' },
      ],
    });
    expect(englishAll(problems)).toEqual([
      'Event type 1 has no code. An event stores the code, so a rename never orphans one.',
      'The code TRAINING is used twice, so one type would wear two labels.',
      'Event type 4: 1ST-EVENT is not a usable code. Letters, digits and underscores, starting with a letter.',
      'Event type 5 has no label, so it would render as a blank row on the Events screen.',
      'Event type 6: blue is not a colour. Use a six-digit hex value such as #2D9CDB.',
    ]);
    expect(indonesianAll(problems)).toEqual([
      'Jenis event 1 tidak memiliki kode. Event menyimpan kodenya, jadi mengganti nama tidak pernah membuat event '
        + 'kehilangan jenisnya.',
      'Kode TRAINING dipakai dua kali, sehingga satu jenis akan memiliki dua label.',
      'Jenis event 4: 1ST-EVENT bukan kode yang dapat dipakai. Gunakan huruf, angka, dan garis bawah, diawali huruf.',
      'Jenis event 5 tidak memiliki label, sehingga akan tampil sebagai baris kosong di layar Events.',
      'Jenis event 6: blue bukan warna. Gunakan nilai hex enam digit, misalnya #2D9CDB.',
    ]);
  });
});
