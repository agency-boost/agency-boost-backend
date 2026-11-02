import { hostsOf, MONGODB_DB_NAME_DEFAULT, mongoTargetFrom } from './mongo-target';

describe('where the commands connect (P18.7-T1)', () => {
  it('P18.7-T1 is nothing without MONGODB_URI, so each command can say so', () => {
    expect(mongoTargetFrom({})).toBeNull();
    expect(mongoTargetFrom({ MONGODB_URI: '  ' })).toBeNull();
  });

  it('P18.7-T1 reads MONGODB_DB_NAME, and defaults to the API\'s database without it', () => {
    expect(mongoTargetFrom({ MONGODB_URI: 'mongodb://localhost:27017', MONGODB_DB_NAME: 'agencyboost_dev' }))
      .toEqual({ uri: 'mongodb://localhost:27017', dbName: 'agencyboost_dev', hosts: 'localhost:27017' });
    expect(mongoTargetFrom({ MONGODB_URI: 'mongodb://localhost:27017' })?.dbName).toBe(MONGODB_DB_NAME_DEFAULT);
    expect(mongoTargetFrom({ MONGODB_URI: 'mongodb://localhost:27017', MONGODB_DB_NAME: '' })?.dbName)
      .toBe('agencyboost');
  });

  it.each([
    ['mongodb://localhost:27017', 'localhost:27017'],
    ['mongodb://app:s3cret@mongo:27017/agencyboost?authSource=agencyboost', 'mongo:27017'],
    ['mongodb+srv://user:pass@cluster0.abcde.mongodb.net/?retryWrites=true', 'cluster0.abcde.mongodb.net'],
    ['mongodb://u:p@a.example:27017,b.example:27017/db', 'a.example:27017,b.example:27017'],
    // A password written by hand with a `/` and an `@` in it, unencoded: none of it is printed.
    ['mongodb://app:pa/ss@word@mongo:27017/agencyboost', 'mongo:27017'],
  ])('P18.7-T1 prints %s as %s, with no credentials', (uri, hosts) => {
    expect(hostsOf(uri)).toBe(hosts);
    expect(hostsOf(uri)).not.toMatch(/s3cret|pass|pa\/ss|word|app:|user:|u:p/);
  });
});
