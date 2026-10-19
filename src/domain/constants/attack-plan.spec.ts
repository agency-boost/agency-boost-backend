import {
  ATTACK_PLAN, PRODUCT_CATEGORIES, PRODUCT_CATEGORY_LABELS, PRODUCT_CHANNEL_LABELS, PRODUCT_CHANNELS, PRODUCT_NEED_LABELS,
  PRODUCT_NEEDS, PRODUCT_RUN_OFF_NOTE,
} from './index';

/**
 * **The Sales Attack Plan's numbers, pinned** (D-scoring; `metrics-and-definitions.md`, *Sales Attack
 * Plan*). Each is the prototype's own (`Overall.html:9599-9611`, `:9697-9699`), and a change to one is a
 * change to every recommendation an agent is shown — so it starts by failing here.
 */
describe('ATTACK_PLAN (Overall.html:9599-9611)', () => {
  it('scores an eligible age band 1 (`:9605`)', () => {
    expect(ATTACK_PLAN.AGE_WEIGHT).toBe(1);
  });

  it('scores an eligible budget band 2, twice the age band (`:9606`)', () => {
    expect(ATTACK_PLAN.BUDGET_WEIGHT).toBe(2);
    expect(ATTACK_PLAN.BUDGET_WEIGHT).toBe(2 * ATTACK_PLAN.AGE_WEIGHT);
  });

  it('draws four alternatives before the *more* line (`:9698-9699`)', () => {
    expect(ATTACK_PLAN.ALTERNATIVES_SHOWN).toBe(4);
  });

  it('holds exactly these three numbers, so a fourth cannot arrive unpinned', () => {
    expect(ATTACK_PLAN).toEqual({ AGE_WEIGHT: 1, BUDGET_WEIGHT: 2, ALTERNATIVES_SHOWN: 4 });
  });
});

describe('the words the two sales screens print (Overall.html)', () => {
  it('names every need as the brief’s chips do (`:3803-3810`), and no other', () => {
    expect(Object.keys(PRODUCT_NEED_LABELS)).toEqual([...PRODUCT_NEEDS]);
    expect(PRODUCT_NEED_LABELS).toEqual({
      'life-protection': 'Life protection', health: 'Health', ci: 'Critical illness', accident: 'Accident-only',
      education: 'Education', investment: 'Investment', retirement: 'Retirement income', legacy: 'Legacy / inheritance',
    });
  });

  it('names every category as the catalog’s tabs do, in their order (`:10116-10122`)', () => {
    expect(Object.keys(PRODUCT_CATEGORY_LABELS)).toEqual([...PRODUCT_CATEGORIES]);
    expect(Object.values(PRODUCT_CATEGORY_LABELS)).toEqual([
      'Life', 'Health', 'Critical illness', 'Education', 'Investment-linked',
    ]);
  });

  it('names both channels (`:9534`)', () => {
    expect(Object.keys(PRODUCT_CHANNEL_LABELS)).toEqual([...PRODUCT_CHANNELS]);
    expect(PRODUCT_CHANNEL_LABELS).toEqual({ conventional: 'Conventional', syariah: 'Syariah' });
  });

  it('carries the drawer’s run-off note verbatim (`:10240`)', () => {
    expect(PRODUCT_RUN_OFF_NOTE).toBe(
      'In run-off — not actively issued to new applicants. Shown for reference only; not part of the current sales shelf.',
    );
  });
});
