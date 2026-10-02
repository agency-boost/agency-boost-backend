import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ErrorCode } from './error-codes';

/**
 * **Outside a reader's scope is 404, `NOT_FOUND`, never a refusal that names the reason** (P11-T3
 * AC-3, `conventions.md` *Errors*). A 403 confirms that the person exists; a code that says *you do
 * not coach them* or *these notes are private* tells a subject that notes about them exist.
 */
describe('ErrorCode (P11-T3 AC-3)', () => {
  it('P11-T3 AC-3: holds neither COACHING_NOT_COACH_OF nor COACHING_NOTES_PRIVATE (ADR-0073, ADR-0074)', () => {
    expect(Object.keys(ErrorCode)).not.toContain('COACHING_NOT_COACH_OF');
    expect(Object.keys(ErrorCode)).not.toContain('COACHING_NOTES_PRIVATE');
    expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND');
  });

  it('P11-T3 AC-3: nothing raises PERM_OUT_OF_SCOPE — a subject outside the grant is answered 404', () => {
    // The activity reads raised it for an Agent naming somebody else until P11-T3. The code stays
    // in the enum while the error catalog still lists it; no service may answer with it.
    const src = join(__dirname, '../..');
    const raisers = globSync('**/*.ts', { cwd: src })
      .filter((file) => !file.includes('.spec.') && file !== 'common/errors/error-codes.ts')
      .filter((file) => readFileSync(join(src, file), 'utf8').includes('PERM_OUT_OF_SCOPE'));
    expect(raisers).toEqual([]);
  });
});
