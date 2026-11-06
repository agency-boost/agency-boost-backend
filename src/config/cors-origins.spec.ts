import { corsOriginsOf } from './cors-origins';

describe('CORS_ORIGINS, as CORS and the refresh-origin check read it (P18.4-T1)', () => {
  it('P18.4-T1 splits on commas and trims each entry', () => {
    expect(corsOriginsOf('https://agencyboost.id, https://staging.agencyboost.id'))
      .toEqual(['https://agencyboost.id', 'https://staging.agencyboost.id']);
  });

  it('P18.4-T1 lists nothing for an unset or empty value, and drops empty entries', () => {
    expect(corsOriginsOf(undefined)).toEqual([]);
    expect(corsOriginsOf(null)).toEqual([]);
    expect(corsOriginsOf('')).toEqual([]);
    expect(corsOriginsOf(' , https://agencyboost.id,')).toEqual(['https://agencyboost.id']);
  });
});
