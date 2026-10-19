import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every schema the codebase registers, discovered from the source tree.
 *
 * The convention specs used to end with `expect(LIST_A.length + LIST_B.length).toBe(4)`
 * and a comment promising *"the failure is the prompt to decide which list it belongs
 * in"*. It never was: both sides of that comparison came from the lists themselves, so
 * it held whatever the lists contained and could only fail if somebody edited a list and
 * forgot the literal. Phase 3 added five collections and it stayed green throughout —
 * `memberships`, `membershipHistory`, `joinRequests`, `inviteCodes` and `groups` went
 * unclassified by both the tenant-index convention and the soft-delete convention.
 *
 * Reading the filesystem makes the assertion mean what it always claimed: a new
 * `*.schema.ts` fails both specs until somebody says which list it belongs in.
 */
export function registeredSchemaNames(): string[] {
  const root = join(__dirname, '..', '..');
  const names: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.schema.ts')) {
        const source = readFileSync(path, 'utf8');
        for (const m of source.matchAll(
          /export const (\w+Schema) = SchemaFactory\.createForClass/g,
        )) {
          names.push(m[1]);
        }
      }
    }
  };

  walk(root);
  return names.sort();
}

/**
 * The names a spec has classified, in the order the failure should read.
 *
 * Both convention specs key their lists by collection name (`'memberships'`) while the
 * source exports by class name (`MembershipSchema`), so the comparison is made on the
 * exported names the lists actually import.
 */
export function unclassified(classified: readonly string[]): string[] {
  const known = new Set(classified);
  return registeredSchemaNames().filter((name) => !known.has(name));
}
