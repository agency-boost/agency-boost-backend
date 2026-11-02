import { englishAll, indonesianAll } from '../../../test/i18n';
import { campaignKindsProblems, defaultCampaignKinds } from './campaign-kinds-payload';

/**
 * **A company's rule set, refused in both languages** (P18.98-T5 AC-3; P5-T9 AC-4): `campaignKindsProblems` answers
 * sentences, each naming its place — *Rule 1, group 2, criterion 1* — in the reader's words (*Aturan 1, grup 2,
 * kriteria 1*). The English is the API's as it always was; `template-payloads.spec.ts` pins each rule's meaning.
 */
describe('P18.98-T5 AC-3 a campaign kinds payload’s problems, in both languages', () => {
  const rule = (over: Record<string, unknown> = {}) => ({
    kind: 'production_club',
    code: 'STAR_CLUB',
    name: 'Star Club',
    rank: 1,
    criteriaGroups: [{ mode: 'all', criteria: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 120_000_000_000 }] }],
    ...over,
  });

  it('P18.98-T5 AC-3 the platform tiers and MOC have none', () => {
    expect(campaignKindsProblems(defaultCampaignKinds())).toEqual([]);
  });

  it('P18.98-T5 AC-3 a payload that is not a list, an empty one, and a rule that is wrong in every way', () => {
    expect(indonesianAll(campaignKindsProblems({}))).toEqual(['rules harus berupa daftar.']);
    expect(indonesianAll(campaignKindsProblems({ rules: [] }))).toEqual([
      'Kumpulan aturan tanpa satu aturan pun membuat setiap KPM di perusahaan ini tidak memiliki syarat apa pun untuk dipenuhi.',
    ]);
    const problems = campaignKindsProblems({
      rules: [rule({ kind: undefined, code: '', name: ' ', rank: 0, groupMode: 'either', criteriaGroups: [] })],
    });
    expect(englishAll(problems)).toEqual([
      'Rule 1: (none) is not a rule kind. One of moc, production_club, promotion_path.',
      'Rule 1 has no code. A standing row names the code, never the label.',
      'Rule 1 has no name, so it would render as a blank row.',
      'Rule 1 needs a rank of 1 or more — it is the order the tiers are climbed in.',
      'Rule 1 asks for nothing, so everybody qualifies for it the day it publishes.',
      'Rule 1: groupMode must be all or any.',
    ]);
    expect(indonesianAll(problems)).toEqual([
      'Aturan 1: (tidak ada) bukan jenis aturan. Salah satu dari moc, production_club, promotion_path.',
      'Aturan 1 tidak memiliki kode. Baris hasil campaign menyebut kodenya, bukan labelnya.',
      'Aturan 1 tidak memiliki nama, sehingga akan tampil sebagai baris kosong.',
      'Aturan 1 memerlukan peringkat 1 atau lebih — peringkat adalah urutan tingkat yang dinaiki.',
      'Aturan 1 tidak meminta apa pun, sehingga semua orang memenuhi syaratnya pada hari aturan ini diterbitkan.',
      'Aturan 1: groupMode harus all atau any.',
    ]);
  });

  it('P18.98-T5 AC-3 a code twice, a rank shared, and a kind that is not one', () => {
    expect(indonesianAll(campaignKindsProblems({ rules: [rule(), rule({ rank: 2 })] })))
      .toEqual(['Kode STAR_CLUB dipakai dua kali di production_club, sehingga satu aturan akan memiliki dua nama.']);
    const shared = campaignKindsProblems({ rules: [rule(), rule({ code: 'ELITE' })] });
    expect(englishAll(shared)).toEqual(['Two production_club rules share rank 1, so which one is higher is undecidable.']);
    expect(indonesianAll(shared))
      .toEqual(['Dua aturan production_club berada di peringkat 1, jadi tidak dapat ditentukan mana yang lebih tinggi.']);
    expect(indonesianAll(campaignKindsProblems({ rules: [rule({ kind: 'bonus_scheme' })] })))
      .toEqual(['Aturan 1: bonus_scheme bukan jenis aturan. Salah satu dari moc, production_club, promotion_path.']);
  });

  it('P18.98-T5 AC-3 a group and its criteria, each named by its place', () => {
    const problems = campaignKindsProblems({
      rules: [rule({
        criteriaGroups: [
          { mode: 'some', criteria: [] },
          {
            mode: 'all',
            criteria: [
              { metricKey: '', comparator: 'about', value: 'a lot' },
              { metricKey: 'leaders_used', comparator: 'lte', value: 10 },
              { comparator: 'gte', value: 1 },
            ],
          },
        ],
      })],
    });
    expect(englishAll(problems)).toEqual([
      'Rule 1, group 1: mode must be all or any.',
      'Rule 1, group 1 asks for nothing, so it passes for everybody.',
      'Rule 1, group 2, criterion 1 names no metric.',
      'Rule 1, group 2, criterion 1: about is not a comparator. One of gte, gt, lte, lt, eq.',
      'Rule 1, group 2, criterion 1 has no number to compare against.',
      'Rule 1, group 2, criterion 2: Leaders used counts the office, not anybody’s work, so a rule cannot ask for it.',
      'Rule 1, group 2, criterion 3 names no metric.',
    ]);
    expect(indonesianAll(problems)).toEqual([
      'Aturan 1, grup 1: mode harus all atau any.',
      'Aturan 1, grup 1 tidak meminta apa pun, sehingga semua orang lolos.',
      'Aturan 1, grup 2, kriteria 1 tidak menyebut metrik apa pun.',
      'Aturan 1, grup 2, kriteria 1: about bukan pembanding. Salah satu dari gte, gt, lte, lt, eq.',
      'Aturan 1, grup 2, kriteria 1 tidak memiliki angka untuk dibandingkan.',
      'Aturan 1, grup 2, kriteria 2: Leaders used menghitung KPM, bukan hasil kerja seseorang, jadi aturan tidak dapat '
        + 'memintanya.',
      'Aturan 1, grup 2, kriteria 3 tidak menyebut metrik apa pun.',
    ]);
  });
});
