import type { Reader } from '@/common/i18n/reader';
import { SEED_RECRUITMENT_PLAYBOOK, type RecruitmentPlaybookBody } from '@/domain/constants/recruitment';
import { SEED_RECRUITMENT_PLAYBOOK_ID } from '@/domain/constants/recruitment-words-id';
import { recruitmentPlanFor } from './recruitment-plan';
import { defaultPlaybookBody } from './recruitment-playbook-defaults';
import { playbookFor } from './recruitment-words';

const ID: Reader = { language: 'id', figures: 'id' };
const EN: Reader = { language: 'en', figures: 'en' };

/** Every string of a playbook, by its path. */
function stringsOf(value: unknown, path = ''): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringsOf(v, `${path}.${i}`));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => stringsOf(v, path ? `${path}.${k}` : k));
  }
  return [];
}

describe('UI-107 the seed recruitment playbook in Bahasa Indonesia', () => {
  it('UI-107 path for path the seed’s: 72 strings, every one translated', () => {
    const en = stringsOf(SEED_RECRUITMENT_PLAYBOOK);
    const id = stringsOf(SEED_RECRUITMENT_PLAYBOOK_ID);
    expect(id.map(([path]) => path)).toEqual(en.map(([path]) => path));
    expect(en).toHaveLength(72);
    const same = id.filter(([, text], i) => text === '' || text === en[i][1]).map(([path]) => path);
    expect(same).toEqual([]);
  });

  it('UI-107 the profiles are named as the chips name them', () => {
    expect(Object.values(SEED_RECRUITMENT_PLAYBOOK_ID.profiles).map((p) => p.label))
      .toEqual(['Lulusan baru', 'Pindah karier', 'Pemilik usaha', 'Pensiunan', 'Agent (asuransi lain)']);
  });
});

describe('UI-107 playbookFor — the platform’s words translated, a company’s as typed', () => {
  it('UI-107 an Indonesian reader reads the untouched seed in Indonesian', () => {
    expect(playbookFor(defaultPlaybookBody(), ID)).toEqual(SEED_RECRUITMENT_PLAYBOOK_ID);
  });

  it('UI-107 an English reader reads the playbook as stored', () => {
    const body = defaultPlaybookBody();
    expect(playbookFor(body, EN)).toBe(body);
  });

  it('UI-107 a word the company reworded is shown as typed; its neighbours still translate', () => {
    const body = defaultPlaybookBody() as { -readonly [K in keyof RecruitmentPlaybookBody]: RecruitmentPlaybookBody[K] };
    body.nextAction = 'Call them back on Friday.';
    const ours = JSON.parse(JSON.stringify(body)) as RecruitmentPlaybookBody;
    const read = playbookFor(ours, ID);
    expect(read.nextAction).toBe('Call them back on Friday.');
    expect(read.profiles['career-switch'].tagline).toBe(SEED_RECRUITMENT_PLAYBOOK_ID.profiles['career-switch'].tagline);
  });

  it('UI-107 the plan an Indonesian reader is built reads as the owner’s worked example (Pindah karier)', () => {
    const plan = recruitmentPlanFor(
      playbookFor(defaultPlaybookBody(), ID),
      { type: 'career-switch', motivations: ['side-income'], hesitations: ['no-network'] },
      ID,
    );
    expect(plan.profile.label).toBe('Pindah karier');
    expect(plan.openings[0].text)
      .toBe('Bagaimana kalau dicoba dulu sambil tetap bekerja, sebelum mengambil keputusan yang lebih besar?');
    expect(plan.objections[0]).toMatchObject({ theySay: 'Saya tidak punya jaringan untuk dijual.' });
    expect(plan.nextAction).toMatch(/^Kirim Opportunity Overview dari Pitch Materials/);
  });
});
