import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestContext } from '@/common/context/request-context';
import { ProductionWrites, signalAfterWrite, signalBeforeWrite } from './production-writes.port';

const ctx = RequestContext.forJob('kpm-1', 'spec');

/**
 * **The Quant runs are told of every write to the office's file** (P19.5-T3 AC-9; ADR-0215 §6): before it — a run past its
 * 15th freezes as it stands — and after it — a live run recalculates, a frozen one is marked. Failing open, as
 * `SalesEvents` does: the write is never refused for the runs' sake.
 */
describe('P19.5-T3 AC-9 ProductionWrites', () => {
  it('P19.5-T3 AC-9 signals the month before and after, and does nothing without a port', async () => {
    const seen: string[] = [];
    const port: ProductionWrites = {
      beforeWrite: async (_c, month) => { seen.push(`before ${month}`); },
      afterWrite: async (_c, month) => { seen.push(`after ${month}`); },
    };
    await signalBeforeWrite(port, ctx, '2026-06');
    await signalAfterWrite(port, ctx, '2026-06');
    await signalBeforeWrite(null, ctx, '2026-06');
    expect(seen).toEqual(['before 2026-06', 'after 2026-06']);
  });

  it('P19.5-T3 AC-9 fails open: a run that cannot freeze or recalculate never refuses the write', async () => {
    const port: ProductionWrites = {
      beforeWrite: async () => { throw new Error('down'); },
      afterWrite: async () => { throw new Error('down'); },
    };
    await expect(signalBeforeWrite(port, ctx, '2026-06')).resolves.toBeUndefined();
    await expect(signalAfterWrite(port, ctx, '2026-06')).resolves.toBeUndefined();
  });

  it('P19.5-T3 AC-9 every writer of the file signals both: a commit, a revert, a correction and a batch of corrections', () => {
    const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');
    const imports = read('production-import.service.ts');
    const corrections = read('production-correction.service.ts');
    expect(imports.match(/signalBeforeWrite\(this\.writes/g)).toHaveLength(2);
    expect(imports.match(/signalAfterWrite\(this\.writes/g)).toHaveLength(2);
    expect(corrections.match(/signalBeforeWrite\(this\.writes/g)).toHaveLength(2);
    expect(corrections.match(/signalAfterWrite\(this\.writes/g)).toHaveLength(2);
  });
});
