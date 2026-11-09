import { globSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const SRC = join(__dirname, '../..');
const READER = join(__dirname, 'activation-readings.ts');

/** A source's imports, resolved to files under `src/` — `@/` and relative, types included. */
function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].flatMap(([, spec]) => {
    if (spec.startsWith('@/')) return [`${join(SRC, spec.slice(2))}.ts`];
    if (spec.startsWith('.')) return [`${normalize(join(dirname(file), spec))}.ts`];
    return [];
  });
}

/**
 * **Who reads an office's activations in bulk** (P18.3-T1 AC-7): `ActivationReadings` answers every hire's activation
 * of an office in one read — a disclosure the leader's roster makes only for the hires the leader coaches (COACH), and
 * the Owner's compliance tree for its listed members, with the §3.5 entry its service writes. So its importers are
 * named: the tree's *Activation* category, and the module that registers it. Anything else reaching for it is a new
 * reader of every hire's activation, and a decision written down here first.
 */
describe('P18.3-T1 AC-7 activation’s bulk reader: its importers, and what it reads through', () => {
  const sources = globSync('**/*.ts', { cwd: SRC })
    .filter((f) => !f.endsWith('.spec.ts'))
    .map((f) => join(SRC, f));

  it('finds the sources at all, so a silent zero cannot pass', () => {
    expect(sources.length).toBeGreaterThan(200);
  });

  it('P18.3-T1 AC-7 is imported by the compliance tree’s Activation category and the app module, and nothing else', () => {
    const importers = sources
      .filter((file) => file !== READER && importsOf(file).includes(READER))
      .map((file) => relative(SRC, file).replace(/\\/g, '/'))
      .sort();
    expect(importers).toEqual(['app.module.ts', 'modules/reporting/compliance/activation.category.ts']);
  });

  it('P18.3-T1 AC-7 reads through the tenant-scoped repository and the one computation, never a raw model', () => {
    const source = readFileSync(READER, 'utf8');
    expect(source).not.toMatch(/@InjectModel\(|mongoose\.model\(|\.collection\(/);
    expect(importsOf(READER).map((f) => relative(SRC, f).replace(/\\/g, '/')).filter((f) => f.startsWith('modules/')).sort()).toEqual([
      'modules/activation/activation-progress.repository.ts',
      'modules/activation/activation-progress.schema.ts',
      'modules/activation/activation-progress.service.ts',
      'modules/activation/activation-rules.ts',
      'modules/tenants/tenant-day.service.ts',
    ]);
  });
});
