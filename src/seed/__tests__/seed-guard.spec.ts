import { planSeed } from '../seed-guard';

const LOCAL = { MONGODB_URI: 'mongodb://app:s3cret@mongo:27017/?authSource=agencyboost', MONGODB_DB_NAME: 'agencyboost' };

describe('the demo seed\'s guard (P18.7-T1)', () => {
  it.each(['production', 'Production', ' production '])('P18.7-T1 refuses NODE_ENV=%j, whatever else is set', (nodeEnv) => {
    const plan = planSeed({ ...LOCAL, NODE_ENV: nodeEnv }, true);
    expect(plan).toEqual({ refusal: expect.stringMatching(/^Refusing to seed: NODE_ENV is "production"/) });
  });

  it.each([undefined, 'development', 'staging', 'test'])('P18.7-T1 seeds with NODE_ENV=%j', (nodeEnv) => {
    expect(planSeed({ ...LOCAL, NODE_ENV: nodeEnv }, false)).toHaveProperty('target');
  });

  it('P18.7-T1 refuses with the way out when MONGODB_URI is not set', () => {
    expect(planSeed({ NODE_ENV: 'development' }, false)).toEqual({
      refusal: 'MONGODB_URI is not set. Copy .env.example to .env and fill in your connection string.',
    });
  });

  it('P18.7-T1 names the database and its host before a --reset, and never the credentials', () => {
    const plan = planSeed({ ...LOCAL, NODE_ENV: 'staging' }, true);
    if (!('banner' in plan)) throw new Error('expected a plan to seed');
    expect(plan.banner).toBe('--reset: emptying the demo\'s collections in database "agencyboost" on mongo:27017, then seeding it');
    expect(plan.banner).not.toMatch(/s3cret|app:/);
    expect(plan.target).toEqual({ uri: LOCAL.MONGODB_URI, dbName: 'agencyboost', hosts: 'mongo:27017' });
  });

  it('P18.7-T1 names the target on an ordinary run too', () => {
    const plan = planSeed({ MONGODB_URI: 'mongodb://localhost:27017' }, false);
    expect(plan).toMatchObject({ banner: 'Seeding database "agencyboost" on localhost:27017' });
  });
});
