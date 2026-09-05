import { initialsOf } from './directory.service';

describe('avatar initials', () => {
  it('takes the first and last name', () => {
    expect(initialsOf('Rina Wijaya')).toBe('RW');
    expect(initialsOf('Wilson Adi Tanoto')).toBe('WT');
  });

  it('doubles a single name rather than showing one letter', () => {
    expect(initialsOf('Sari')).toBe('SS');
  });

  it('copes with a blank name instead of throwing', () => {
    // `users.fullName` is required and trimmed, so this cannot be written through the
    // schema today. The guard stays for the import that will not go through it — an
    // avatar is not worth a crash.
    expect(initialsOf('')).toBe('??');
    expect(initialsOf('   ')).toBe('??');
  });

  it('ignores extra spacing', () => {
    expect(initialsOf('  Budi   Santoso  ')).toBe('BS');
  });
});
