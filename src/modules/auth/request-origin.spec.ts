import { isForeignOrigin, ownOriginOf } from './request-origin';

const ALLOWED = ['https://agencyboost.id'];

describe('a foreign origin on the refresh cookie (P18.7-T1)', () => {
  it('P18.7-T1 lets a listed origin through', () => {
    expect(isForeignOrigin('https://agencyboost.id', ALLOWED)).toBe(false);
  });

  it.each([
    'https://staging.agencyboost.id', // same site as api.agencyboost.id: the case this exists for
    'https://evil.example',
    'http://agencyboost.id', // another scheme is another origin
    'https://agencyboost.id:8443',
    'null', // a sandboxed frame or an opaque redirect
  ])('P18.7-T1 refuses %s', (origin) => {
    expect(isForeignOrigin(origin, ALLOWED)).toBe(true);
  });

  it('P18.7-T1 lets a request with no Origin through: no page sent it', () => {
    expect(isForeignOrigin(undefined, ALLOWED)).toBe(false);
    expect(isForeignOrigin(undefined, [])).toBe(false);
  });

  it('P18.7-T1 refuses every Origin when CORS_ORIGINS lists none', () => {
    expect(isForeignOrigin('https://agencyboost.id', [])).toBe(true);
  });
});

describe('the API\'s own origin (P18.7-T1)', () => {
  const req = (protocol: string, host?: string) => ({ protocol, get: (header: string) => (header === 'host' ? host : undefined) });

  it('P18.7-T1 is the scheme Express read and the Host the browser sent', () => {
    expect(ownOriginOf(req('https', 'staging-api.agencyboost.id'))).toBe('https://staging-api.agencyboost.id');
    expect(ownOriginOf(req('http', 'localhost:3001'))).toBe('http://localhost:3001');
  });

  it('P18.7-T1 is nothing without a Host header, so nothing extra is allowed', () => {
    expect(ownOriginOf(req('https'))).toBeNull();
  });
});
