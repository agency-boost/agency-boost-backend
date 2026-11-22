import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  firstOwnerOf, HAS_AN_OWNER, HAS_NO_OWNER, isOwnerOf, ownedBy, ownerCountOf, ownerEntry, ownersInOrder, ownerUserIdsOf,
} from './kpm-owners';

const AUG = new Date('2026-08-01T00:00:00Z');
const NOV = new Date('2026-11-22T03:00:00Z');

/** **A KPM's owners, read** (P19.27-T1 AC-1; ADR-0285 §1): the pure helpers every *"is this the owner"* check reads now. */
describe('kpm-owners — the helpers (P19.27-T1 AC-1)', () => {
  const kpm = { owners: [ownerEntry('u-sinta', NOV, 'u-yohanes'), ownerEntry('u-yohanes', AUG)] };

  it('isOwnerOf answers any owner, and false for nobody, no KPM or a row with no list', () => {
    expect(isOwnerOf(kpm, 'u-yohanes')).toBe(true);
    expect(isOwnerOf(kpm, 'u-sinta')).toBe(true);
    expect(isOwnerOf(kpm, 'u-joko')).toBe(false);
    expect(isOwnerOf(kpm, null)).toBe(false);
    expect(isOwnerOf(null, 'u-yohanes')).toBe(false);
    expect(isOwnerOf({}, 'u-yohanes')).toBe(false);
  });

  it('ownerUserIdsOf and ownersInOrder put the earliest since first; a tie keeps the stored order', () => {
    expect(ownerUserIdsOf(kpm)).toEqual(['u-yohanes', 'u-sinta']);
    expect(ownersInOrder({ owners: [ownerEntry('a', NOV), ownerEntry('b', NOV)] }).map((o) => o.userId)).toEqual(['a', 'b']);
    expect(ownerUserIdsOf(undefined)).toEqual([]);
    expect(ownerUserIdsOf({ owners: null })).toEqual([]);
  });

  it('firstOwnerOf is the earliest since, or null; ownerCountOf counts them', () => {
    expect(firstOwnerOf(kpm)).toEqual({ userId: 'u-yohanes', since: AUG, addedByUserId: null });
    expect(firstOwnerOf({ owners: [] })).toBeNull();
    expect(ownerCountOf(kpm)).toBe(2);
    expect(ownerCountOf(null)).toBe(0);
  });

  it('the filters name owners.userId and the list’s first slot', () => {
    expect(ownedBy('u-1')).toEqual({ 'owners.userId': 'u-1' });
    expect(ownedBy({ $in: ['u-1'] })).toEqual({ 'owners.userId': { $in: ['u-1'] } });
    expect(HAS_AN_OWNER).toEqual({ 'owners.0': { $exists: true } });
    expect(HAS_NO_OWNER).toEqual({ 'owners.0': { $exists: false } });
  });
});

/**
 * **P19.27-T1 AC-2 — no read of `kpms.ownerUserId` is left** (ADR-0285 §2): every check that asked *"is this the owner"*
 * reads *any owner* through `kpm-owners.ts`. A source-shape assertion, as `raw-writes.tenancy.spec.ts` is: the one owner
 * may not come back by a stray `kpm.ownerUserId` or `{ ownerUserId: … }` filter on a KPM row.
 *
 * What remains, by design: the migrations that moved the field (`0052` reads it on a database 0077 has not reached;
 * `0077` moves it), and **the first owner** where a response keeps naming one (`KpmView.ownerUserId`, ADR-0285 §3) — its
 * declarations and the one line that fills it from `firstOwnerOf`.
 */
describe('P19.27-T1 AC-2 — no read of kpms.ownerUserId outside the migrations', () => {
  const src = join(__dirname, '../..');
  /** The first owner, as a response still names it: declared, and filled from the ordered list. */
  const FIRST_OWNER_FIELD = [
    /^\s*ownerUserId!?: string \| null;/,
    /^\s*ownerUserId: first\?\.userId \?\? null,/,
  ];

  it('finds the word only in the migrations and the first-owner response field', () => {
    const offenders = globSync('**/*.ts', { cwd: src })
      .filter((file) => !file.includes('.spec.') && !file.startsWith('migrations/'))
      .flatMap((file) => readFileSync(join(src, file), 'utf8').split('\n')
        .map((line, i) => ({ file, line: i + 1, text: line }))
        .filter(({ text }) => /\bownerUserId\b/.test(text))
        // A comment naming the old field, to say what replaced it, reads nothing.
        .filter(({ text }) => !/^\s*(\*|\/\/|\/\*)/.test(text))
        .filter(({ text }) => !FIRST_OWNER_FIELD.some((allowed) => allowed.test(text))));
    expect(offenders).toEqual([]);
  });
});
