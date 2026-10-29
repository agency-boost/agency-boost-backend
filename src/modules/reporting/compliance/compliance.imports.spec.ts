import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';

const SRC = join(__dirname, '../../..');
const FOLDER = __dirname;

/** A source's imports, resolved to files under `src/` — `@/` and relative, types included. */
function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].flatMap(([, spec]) => {
    const base = spec.startsWith('@/') ? join(SRC, spec.slice(2))
      : spec.startsWith('.') ? normalize(join(dirname(file), spec))
        : null;
    if (base === null) return [];
    return [`${base}.ts`, join(base, 'index.ts')].filter((candidate) => existsSync(candidate)).slice(0, 1);
  });
}

const rel = (file: string) => relative(SRC, file).replace(/\\/g, '/');

/**
 * **The compliance tree reads each category through the module that owns it, and nothing else** (P18.6-T1 AC-12,
 * P18.6-T2 AC-9; invariant §8). Its own folder, so `reporting.imports.spec.ts` — which holds Phase 18's top-level
 * files to *no training, event or campaign* — stays true for them, and this one holds the tree to exactly the readers
 * it calls: training's offered catalog and progress, goals' plans, activity's readings, activation's bulk reader,
 * events' readings, campaigns' standings reader, the names, the office's day, the audit seam and the permission check.
 * A new import of another module's internals fails here by name.
 */
describe('P18.6-T1 AC-12 the compliance tree reaches exactly the readers it calls', () => {
  const code = readdirSync(FOLDER).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts')).map((f) => join(FOLDER, f));

  it('P18.6-T1 AC-12 the folder has the code it is meant to', () => {
    expect(code.map((f) => f.slice(FOLDER.length + 1)).sort()).toEqual([
      'activation.category.ts', 'activity.category.ts', 'campaigns.category.ts', 'compliance-category.ts',
      'compliance.controller.ts', 'compliance.dto.ts', 'compliance.response.dto.ts', 'compliance.service.ts',
      'events.category.ts', 'goals.category.ts', 'training.category.ts',
    ]);
  });

  it('P18.6-T1 AC-12, P18.6-T2 AC-9 imports, of other modules, the readers it calls and nothing else', () => {
    const reached = [...new Set(code.flatMap(importsOf))]
      .map(rel)
      .filter((f) => f.startsWith('modules/') && !f.startsWith('modules/reporting/compliance/'))
      .sort();
    expect(reached).toEqual([
      'modules/activation/activation-readings.ts',
      'modules/activity/activity-readings.ts',
      'modules/audit/subject-read-audit.ts',
      'modules/campaigns/campaign-standings-reader.ts',
      'modules/campaigns/campaign-words.ts',
      'modules/events/event-readings.ts',
      'modules/goals/goal.service.ts',
      'modules/org/member-names.service.ts',
      'modules/rbac/permissions.ts',
      // Phase 18's own: the agencies, the names' order, and the office's people — and the module's sentences (P18.98-T5).
      'modules/reporting/agency-partition.ts',
      'modules/reporting/office-figures.ts',
      'modules/reporting/office-people.ts',
      'modules/reporting/reporting.messages.ts',
      'modules/tenants/tenant-day.service.ts',
      'modules/training/offered-training.ts',
      'modules/training/training-progress-readings.ts',
    ]);
  });

  it('P18.6-T1 AC-12 no file of the tree reaches a Mongoose model: every record through its owner’s reader', () => {
    for (const file of code) {
      expect([rel(file), /@InjectModel\(|mongoose\.model\(|\.collection\(|from 'mongoose'/.test(readFileSync(file, 'utf8'))])
        .toEqual([rel(file), false]);
    }
  });

  it('P18.6-T1 AC-12 each T1 category imports its own reader alone', () => {
    const own = (file: string) => importsOf(join(FOLDER, file)).map(rel)
      .filter((f) => f.startsWith('modules/') && !f.startsWith('modules/reporting/compliance/'));
    expect(own('training.category.ts').sort()).toEqual(['modules/training/offered-training.ts', 'modules/training/training-progress-readings.ts']);
    expect(own('goals.category.ts')).toEqual(['modules/goals/goal.service.ts']);
    expect(own('activity.category.ts')).toEqual(['modules/activity/activity-readings.ts']);
    expect(own('activation.category.ts')).toEqual(['modules/activation/activation-readings.ts']);
  });
});
