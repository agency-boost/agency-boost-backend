import { displayNameOf, preferredNameOf } from './display-name';

describe('a blank preferred name is no name (UI-005)', () => {
  it('reads an empty or blank preferred name as none', () => {
    expect(preferredNameOf('')).toBeNull();
    expect(preferredNameOf('   ')).toBeNull();
    expect(preferredNameOf(null)).toBeNull();
    expect(preferredNameOf(undefined)).toBeNull();
  });

  it('keeps a real one, trimmed', () => {
    expect(preferredNameOf('Rina')).toBe('Rina');
    expect(preferredNameOf('  Rina ')).toBe('Rina');
  });

  it('falls back to the full name when there is no preferred name', () => {
    expect(displayNameOf({ preferredName: '', fullName: 'Rina Wijaya' })).toBe('Rina Wijaya');
    expect(displayNameOf({ preferredName: ' ', fullName: 'Rina Wijaya' })).toBe('Rina Wijaya');
    expect(displayNameOf({ preferredName: null, fullName: 'Rina Wijaya' })).toBe('Rina Wijaya');
    expect(displayNameOf({ fullName: 'Rina Wijaya' })).toBe('Rina Wijaya');
  });

  it('prefers the preferred name when there is one', () => {
    expect(displayNameOf({ preferredName: 'Rina', fullName: 'Rina Wijaya' })).toBe('Rina');
  });

  it('is null for nobody, so a caller chooses its own placeholder', () => {
    expect(displayNameOf(null)).toBeNull();
    expect(displayNameOf(undefined)).toBeNull();
    expect(displayNameOf({ preferredName: '', fullName: '' })).toBeNull();
  });
});
