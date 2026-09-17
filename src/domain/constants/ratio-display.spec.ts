import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEED_RATIO_DEFINITIONS } from './activity-taxonomy';
import { defaultDisplayUnitFor, resolveDisplayUnit, RATIO_DISPLAY_UNITS } from './ratio-display';

/**
 * P4-T25. The rule every write of a ratio goes through, and the seed it starts from.
 *
 * The unit is pinned against `metrics-and-definitions.md` rather than restated here: the
 * registry already said "a percentage to one decimal" for two ratios and "two decimals" for
 * two more, and the screens printed `0.15` for all of them because nothing read it.
 */
describe('resolveDisplayUnit', () => {
  it('knows exactly three units', () => {
    expect(RATIO_DISPLAY_UNITS).toEqual(['percent', 'decimal', 'points']);
  });

  describe('a band ratio', () => {
    it('is always shown in points', () => {
      expect(resolveDisplayUnit('band')).toEqual({ unit: 'points' });
      expect(resolveDisplayUnit('band', 'points')).toEqual({ unit: 'points' });
    });

    it('refuses any other unit, because it is judged either side of an even split', () => {
      expect(resolveDisplayUnit('band', 'percent').refusal).toMatch(/percentage points/);
      expect(resolveDisplayUnit('band', 'decimal').refusal).toMatch(/percentage points/);
    });

    it('overrides a unit the row carried from before it was a band', () => {
      expect(resolveDisplayUnit('band', undefined, 'percent')).toEqual({ unit: 'points' });
    });
  });

  describe('an at-or-above ratio', () => {
    it('defaults to decimal, which writes the stored value unchanged', () => {
      expect(resolveDisplayUnit('gte')).toEqual({ unit: 'decimal' });
    });

    it('takes the unit it is asked for', () => {
      expect(resolveDisplayUnit('gte', 'percent')).toEqual({ unit: 'percent' });
    });

    it('keeps the unit it already had when only the rule is touched', () => {
      expect(resolveDisplayUnit('gte', undefined, 'percent')).toEqual({ unit: 'percent' });
    });

    it('drops points when it stops being a band, rather than keeping a unit that means nothing', () => {
      expect(resolveDisplayUnit('gte', undefined, 'points')).toEqual({ unit: 'decimal' });
    });

    it('refuses points', () => {
      expect(resolveDisplayUnit('gte', 'points').refusal).toMatch(/Points are for the balance rule/);
    });
  });

  it('refuses a unit that is not one, naming it', () => {
    expect(resolveDisplayUnit('gte', 'basis_points').refusal).toMatch(/^basis_points is not/);
  });
});

describe('defaultDisplayUnitFor', () => {
  it('gives each of the five its platform unit', () => {
    expect(Object.fromEntries(SEED_RATIO_DEFINITIONS.map((r) => [r.code, defaultDisplayUnitFor(r.code, r.comparison)])))
      .toEqual({
        SELLING_VS_RECRUITMENT: 'points',
        SELLING_SUCCESS_RATE: 'percent',
        RECRUITMENT_SUCCESS_RATE: 'percent',
        LEADS_PER_ACTIVITY: 'decimal',
        MEETING_PER_APPROACH: 'decimal',
      });
  });

  it('lets the row’s rule outrank its seed', () => {
    // An Owner may have turned a seeded ratio into a band since provisioning. The seed unit
    // is a starting point; the rule is a fact about the row.
    expect(defaultDisplayUnitFor('LEADS_PER_ACTIVITY', 'band')).toBe('points');
    expect(defaultDisplayUnitFor('SELLING_VS_RECRUITMENT', 'gte')).toBe('decimal');
  });

  it('takes the rule’s default for a code the platform did not seed', () => {
    expect(defaultDisplayUnitFor('REFERRAL_RATE', 'gte')).toBe('decimal');
    expect(defaultDisplayUnitFor('REFERRAL_BALANCE', 'band')).toBe('points');
  });
});

describe('the seeded units against the metric registry', () => {
  const registry = readFileSync(
    join(__dirname, '../../../../docs/00-product/metrics-and-definitions.md'),
    'utf8',
  );

  /** The `**Unit.**` sentence of one registry section. */
  const unitSentence = (id: string) => {
    const start = registry.indexOf(`### \`${id}\``);
    expect(start).toBeGreaterThan(-1);
    const section = registry.slice(start, registry.indexOf('\n---', start));
    return /\*\*Unit\.\*\*\s*([^\n]+)/.exec(section)?.[1] ?? '';
  };

  // The registry names the balance by its metric id; the seed names it by its ratio code.
  const SECTIONS: Record<string, string> = {
    SELLING_SUCCESS_RATE: 'SELLING_SUCCESS_RATE',
    RECRUITMENT_SUCCESS_RATE: 'RECRUITMENT_SUCCESS_RATE',
    LEADS_PER_ACTIVITY: 'LEADS_PER_ACTIVITY',
    MEETING_PER_APPROACH: 'MEETING_PER_APPROACH',
    SELLING_VS_RECRUITMENT: 'SELLING_RECRUITMENT_BALANCE',
  };

  it.each(SEED_RATIO_DEFINITIONS.map((r) => [r.code, r.displayUnit] as const))(
    '%s is shown the way the registry says (%s)',
    (code, unit) => {
      const sentence = unitSentence(SECTIONS[code]);
      const expected = /percentage points/i.test(sentence) ? 'points'
        : /as a percentage/i.test(sentence) ? 'percent'
          : /two decimals/i.test(sentence) ? 'decimal'
            : `unreadable: ${sentence}`;
      expect(unit).toBe(expected);
    },
  );
});
