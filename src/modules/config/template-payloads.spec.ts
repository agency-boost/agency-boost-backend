import {
  campaignKindsProblems, defaultCampaignKinds, qualificationRuleSeedDocuments,
} from '@/modules/campaigns/campaign-kinds-payload';
import {
  defaultEventTypes, eventTypeSeedDocuments, eventTypesProblems,
} from '@/modules/events/event-types-payload';

/**
 * What the two template kinds P5-T9 added refuse, one rule at a time (AC-4).
 *
 * **A checker is a list of refusals, and a refusal nobody has tested is a sentence nobody has
 * read.** These run against the same functions publishing and provisioning both call, so a rule
 * that passes here cannot be enforced differently in the two places that enforce it.
 */
describe('the event types payload (P5-T9)', () => {
  it('passes the platform defaults, which is what a template starts from', () => {
    expect(eventTypesProblems(defaultEventTypes())).toEqual([]);
    expect(defaultEventTypes().types).toHaveLength(5);
  });

  it('refuses a payload that is not a list at all, and stops there', () => {
    // Stops, rather than reporting five more problems about a thing that is not a list.
    expect(eventTypesProblems({})).toEqual(['types must be a list.']);
    expect(eventTypesProblems(null)).toEqual(['types must be a list.']);
    expect(eventTypesProblems({ types: 'TRAINING' })).toEqual(['types must be a list.']);
  });

  it('refuses an empty list: an office with no type cannot file an event', () => {
    expect(eventTypesProblems({ types: [] }))
      .toEqual([expect.stringContaining('nothing to file an event under')]);
  });

  it('refuses a row with no code, because an event stores the code', () => {
    expect(eventTypesProblems({ types: [{ label: 'Training' }] }))
      .toEqual([expect.stringContaining('Event type 1 has no code')]);
  });

  it('refuses a code used twice, which would be one type wearing two labels', () => {
    const problems = eventTypesProblems({
      types: [{ code: 'TRAINING', label: 'Training' }, { code: 'training', label: 'Latihan' }],
    });
    // Case-insensitively: codes are upper-cased on the way in, so these are one code.
    expect(problems).toEqual([expect.stringContaining('TRAINING is used twice')]);
  });

  it('refuses a code nothing could store', () => {
    expect(eventTypesProblems({ types: [{ code: '1ST-EVENT', label: 'First' }] }))
      .toEqual([expect.stringContaining('is not a usable code')]);
  });

  it('refuses a row with no label, which would render as a blank line', () => {
    expect(eventTypesProblems({ types: [{ code: 'TRAINING', label: '   ' }] }))
      .toEqual([expect.stringContaining('has no label')]);
  });

  it('refuses a colour nothing can parse, and accepts one that can', () => {
    expect(eventTypesProblems({ types: [{ code: 'A', label: 'A', color: 'blue' }] }))
      .toEqual([expect.stringContaining('is not a colour')]);
    expect(eventTypesProblems({ types: [{ code: 'A', label: 'A', color: '#2D9CDB' }] })).toEqual([]);
    // Absent is fine: a type without a colour simply has no swatch.
    expect(eventTypesProblems({ types: [{ code: 'A', label: 'A' }] })).toEqual([]);
  });

  it('collects every problem rather than stopping at the first', () => {
    // A payload half-fixed twice is worse than one refused once with the whole list.
    expect(eventTypesProblems({
      types: [{ code: '', label: '' }, { code: 'A', label: 'A', color: 'nope' }],
    })).toHaveLength(3);
  });

  it('numbers and normalises the rows an office starts with', () => {
    const rows = eventTypeSeedDocuments('kpm-1', {
      types: [
        { code: ' town_hall ', label: '  Town hall  ', description: '  ', emoji: '  ', color: '' },
        { code: 'ROADSHOW', label: 'Roadshow' },
      ],
    });

    expect(rows[0]).toMatchObject({
      kpmId: 'kpm-1', code: 'TOWN_HALL', label: 'Town hall', displayOrder: 1, status: 'active',
    });
    // Blank is not the same as set-to-blank: an empty optional comes back as null.
    expect(rows[0].description).toBeNull();
    expect(rows[0].emoji).toBeNull();
    expect(rows[0].color).toBeNull();
    expect(rows[1].displayOrder).toBe(2);
  });
});

describe('the campaign kinds payload (P5-T9)', () => {
  const rule = (over: Record<string, unknown> = {}) => ({
    kind: 'production_club',
    code: 'STAR_CLUB',
    name: 'Star Club',
    rank: 1,
    criteriaGroups: [{
      mode: 'all',
      criteria: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 120_000_000_000 }],
    }],
    ...over,
  });

  it('passes the platform tiers and MOC, which is what a template starts from', () => {
    expect(campaignKindsProblems(defaultCampaignKinds())).toEqual([]);
    // Three tiers and two MOC rules, from one list keyed by `kind`.
    expect(defaultCampaignKinds().rules).toHaveLength(5);
  });

  it('refuses a payload that is not a list at all, and stops there', () => {
    expect(campaignKindsProblems({})).toEqual(['rules must be a list.']);
  });

  it('refuses an empty list: nothing to qualify for', () => {
    expect(campaignKindsProblems({ rules: [] }))
      .toEqual([expect.stringContaining('nothing to qualify for')]);
  });

  it('refuses a kind that is not one of the three', () => {
    expect(campaignKindsProblems({ rules: [rule({ kind: 'bonus_scheme' })] }))
      .toEqual([expect.stringContaining('is not a rule kind')]);
    expect(campaignKindsProblems({ rules: [rule({ kind: undefined })] }))
      .toEqual([expect.stringContaining('(none) is not a rule kind')]);
  });

  it('refuses a missing code and a missing name', () => {
    expect(campaignKindsProblems({ rules: [rule({ code: '' })] }))
      .toEqual([expect.stringContaining('has no code')]);
    expect(campaignKindsProblems({ rules: [rule({ name: '  ' })] }))
      .toEqual([expect.stringContaining('has no name')]);
  });

  it('scopes a duplicate code to its kind, so two kinds may share a name', () => {
    expect(campaignKindsProblems({ rules: [rule(), rule({ rank: 2 })] }))
      .toEqual([expect.stringContaining('STAR_CLUB is used twice in production_club')]);
    // The same code under a different kind is fine: a code is unique within its own list.
    expect(campaignKindsProblems({ rules: [rule(), rule({ kind: 'moc' })] })).toEqual([]);
  });

  it('refuses a rank that is not a rank, and two rules sharing one', () => {
    expect(campaignKindsProblems({ rules: [rule({ rank: 0 })] }))
      .toEqual([expect.stringContaining('needs a rank of 1 or more')]);
    expect(campaignKindsProblems({ rules: [rule({ rank: 1.5 })] }))
      .toEqual([expect.stringContaining('needs a rank of 1 or more')]);
    // Two tiers at one rank make "the highest reached" a question with no answer.
    expect(campaignKindsProblems({ rules: [rule(), rule({ code: 'ELITE' })] }))
      .toEqual([expect.stringContaining('share rank 1')]);
  });

  it('refuses a rule everybody qualifies for on the day it publishes', () => {
    expect(campaignKindsProblems({ rules: [rule({ criteriaGroups: [] })] }))
      .toEqual([expect.stringContaining('asks for nothing')]);
    expect(campaignKindsProblems({
      rules: [rule({ criteriaGroups: [{ mode: 'all', criteria: [] }] })],
    })).toEqual([expect.stringContaining('group 1 asks for nothing')]);
  });

  it('refuses a mode and a groupMode that are not one', () => {
    expect(campaignKindsProblems({ rules: [rule({ groupMode: 'either' })] }))
      .toEqual([expect.stringContaining('groupMode must be all or any')]);
    expect(campaignKindsProblems({
      rules: [rule({ criteriaGroups: [{ mode: 'some', criteria: [{ metricKey: 'A', comparator: 'gte', value: 1 }] }] })],
    })).toEqual([expect.stringContaining('mode must be all or any')]);
    // Omitted `groupMode` is fine — the seed resolves one.
    expect(campaignKindsProblems({ rules: [rule({ groupMode: undefined })] })).toEqual([]);
  });

  it('refuses a criterion with no metric, no comparator or no number', () => {
    const criteria = (over: Record<string, unknown>) => ({
      criteriaGroups: [{
        mode: 'all',
        criteria: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 1, ...over }],
      }],
    });
    expect(campaignKindsProblems({ rules: [rule(criteria({ metricKey: '' }))] }))
      .toEqual([expect.stringContaining('names no metric')]);
    expect(campaignKindsProblems({ rules: [rule(criteria({ comparator: 'about' }))] }))
      .toEqual([expect.stringContaining('is not a comparator')]);
    expect(campaignKindsProblems({ rules: [rule(criteria({ value: 'a lot' }))] }))
      .toEqual([expect.stringContaining('no number to compare against')]);
  });

  it('refuses a criteriaGroups that is not a list, saying what it is missing', () => {
    expect(campaignKindsProblems({ rules: [rule({ criteriaGroups: 'all of them' })] }))
      .toEqual([expect.stringContaining('asks for nothing')]);
  });

  it('takes the unit from the registry, never from the payload (invariant 7)', () => {
    const [row] = qualificationRuleSeedDocuments('c1', {
      rules: [rule({
        criteriaGroups: [{
          mode: 'all',
          criteria: [{ metricKey: 'APE_ACHIEVED', comparator: 'gte', value: 120_000_000_000 }],
        }],
      })] as never,
    });

    expect(row.criteriaGroups[0].criteria[0].unit).toBe('idr_minor');
    expect(row).toMatchObject({ companyId: 'c1', scope: 'company', code: 'STAR_CLUB' });
    // Nothing is waiting: the registry defines this one.
    expect(row.waitingOnMetrics).toEqual([]);
  });

  it('records a metric the registry does not define rather than dropping it', () => {
    /*
     * ADR-0035: a rule whose inputs do not exist can never pass, and a screen showing it as an
     * ordinary rule would tell somebody they had failed something this product cannot measure.
     * The carrier's own documents name metrics we do not compute yet, so this is a real case.
     */
    const [row] = qualificationRuleSeedDocuments('c1', {
      rules: [rule({
        criteriaGroups: [{
          mode: 'all',
          criteria: [
            { metricKey: 'NOT_A_METRIC', comparator: 'gte', value: 4 },
            { metricKey: 'ALSO_NOT', comparator: 'gte', value: 2_000_000 },
          ],
        }],
      })] as never,
    });

    expect(row.waitingOnMetrics).toEqual(['NOT_A_METRIC', 'ALSO_NOT']);
    // The unit the carrier states, where the registry has none: a count below the money line,
    // minor units above it.
    expect(row.criteriaGroups[0].criteria.map((c) => c.unit)).toEqual(['count', 'idr_minor']);
  });

  it('defaults what a payload may leave out', () => {
    const [row] = qualificationRuleSeedDocuments('c1', {
      rules: [rule({ appliesToOrgLevelCodes: undefined, groupMode: undefined, reward: undefined })] as never,
    });

    expect(row).toMatchObject({ appliesToOrgLevelCodes: [], groupMode: 'all', reward: '' });
  });
});
