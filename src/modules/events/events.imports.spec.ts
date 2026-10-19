import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MODULE = __dirname;

/**
 * Files of the events module allowed to reach a Mongoose model directly, each with the reason. Everything else reads
 * and writes through the tenant repositories (invariant §1; the Phase 18.5 exit review).
 */
const ALLOWED = new Map<string, string>([
  ['event.repository.ts', 'the repositories for the four events collections: each injects its own model'],
  ['event-guest.service.ts',
    'reads the office\'s company **name** (`companies`, by the `_id` the office\'s row names) for *"{company} Event"*: '
    + 'a company sits above the tenant, is not tenant-scoped, and holds nothing of another office'],
]);

/** The ways a source reaches a model rather than a repository. */
const RAW = [/@InjectModel\(/, /mongoose\.model\(/, /\.collection\(/, /mongoose\.connection/];

function sources(): string[] {
  return globSync('**/*.ts', { cwd: MODULE }).filter((f) => !f.endsWith('.spec.ts')).map((f) => f.replace(/\\/g, '/'));
}

/**
 * **The events services use no raw Mongoose model** (invariant §1; the Phase 18.5 exit review, 15). `repositories.tenancy
 * .spec.ts` holds the tenant-scoped models across the codebase; this holds every model, in this module, so a service
 * reaching past its repository — even to a collection that is not tenant-scoped — is a decision written down here.
 */
describe('the events module reaches its data through repositories (invariant §1)', () => {
  const files = sources();

  it('finds the module’s sources at all, so a silent zero cannot pass', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('P18.5-T5 AC-9 no file but the allowed ones injects or opens a Mongoose model', () => {
    const offenders = files
      .filter((file) => !ALLOWED.has(file))
      .filter((file) => RAW.some((pattern) => pattern.test(readFileSync(join(MODULE, file), 'utf8'))));
    expect(offenders).toEqual([]);
  });

  it('P18.5-T5 AC-9 the guest service’s one model is the company’s, and only the company’s', () => {
    const source = readFileSync(join(MODULE, 'event-guest.service.ts'), 'utf8');
    expect([...source.matchAll(/@InjectModel\((\w+)\.name\)/g)].map((m) => m[1])).toEqual(['Company']);
  });

  it('allows nothing it no longer needs', () => {
    expect([...ALLOWED.keys()].filter((file) => !files.includes(file))).toEqual([]);
  });

  /*
   * **The readings' importers, guarded** (P18.6-T1 AC-3; the phase file's *Risks*, 1): `EventReadings` — the roll
   * call's computation, `attendanceOfMany` among it — is a service port with no route. Outside this module exactly
   * one file reads it: the compliance tree's *Events* category (`app.module.ts` registers the provider, and reads
   * nothing). Another reader is a decision, written down here.
   */
  it('P18.6-T1 AC-3 outside the events module, only the compliance tree’s Events category imports the readings', () => {
    const SRC = join(MODULE, '../..');
    const importers = globSync('**/*.ts', { cwd: SRC })
      .map((f) => f.replace(/\\/g, '/'))
      .filter((f) => !f.endsWith('.spec.ts') && !f.startsWith('modules/events/') && f !== 'app.module.ts')
      .filter((f) => /from '[^']*events\/event-readings'/.test(readFileSync(join(SRC, f), 'utf8')));
    expect(importers).toEqual(['modules/reporting/compliance/events.category.ts']);
  });
});
