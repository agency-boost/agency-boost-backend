import { Injectable } from '@nestjs/common';
import { RequestContext } from '@/common/context/request-context';
import { NOT_A_TEST_ACCOUNT } from '@/modules/org/counted-members';
import { MembershipRepository } from '@/modules/org/membership.repository';
import type { CheckedContent } from './training-content';
import { TrainingProgressRepository } from './training-progress.repository';

/** How many of the office's members have finished one module, and how many have begun it (P19.25-T4 AC-2). */
export interface ModuleCompletion {
  /** Members whose status on the module is `done` — their own word (ADR-0139). */
  done: number;
  /** Members who have begun it: `in_progress` or `done`. Zero is *Belum ada yang belajar*. */
  started: number;
  /** The office's counted members: active, never a test account (ADR-0267 §1). The row's *"dari 30"*. */
  of: number;
}

/** The one item a module's row names (P19.25-T4 AC-2): the first file, else the first video, else the first link. */
export interface ModuleMaterialItem {
  label: string;
  kind: 'file' | 'video' | 'link';
  /** The type storage confirmed; `null` for a link, which is not ours to store. */
  mimeType: string | null;
}

/**
 * **The item a module's row shows beside *Ganti*** (P19.25-T4 AC-2; ADR-0282 §2): of the material agents are shown — the
 * office's replacement when it has one, else the template's (ADR-0208 §1) — the first file, else the first video, else
 * the first link. `null` is *Unggah materi*.
 */
export function materialItemOf(content: CheckedContent): ModuleMaterialItem | null {
  const file = content.files[0];
  if (file) return { label: file.label, kind: 'file', mimeType: file.mimeType };
  const video = content.videos[0];
  if (video) return { label: video.label, kind: 'video', mimeType: video.mimeType };
  const link = content.links[0];
  if (link) return { label: link.label, kind: 'link', mimeType: null };
  return null;
}

/**
 * **"n dari 30 selesai" for every module, in two queries** (P19.25-T4 AC-2; ADR-0282 §2; `metrics-and-definitions.md`,
 * `TRAINING_MODULE_DONE_COUNT`):
 *
 * - **Who is counted** is the office's active memberships without a test account (`NOT_A_TEST_ACCOUNT`, ADR-0267 §1) —
 *   the same people the Overview's *Training* compliance card counts, so its *"x dari y anggota"* for a module and this
 *   row's *"x dari y selesai"* are one figure.
 * - **Done is the member's own word** (ADR-0139): `trainingProgress.status === 'done'`; a row nobody touched is *not
 *   started*. A module in draft or archived still has its rows read, so the figure does not jump when it is published.
 * - **Bounded**: the members once, then one rollup over their rows grouped by module and status — never a query per
 *   module or per member.
 */
@Injectable()
export class TrainingModuleFacts {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly progress: TrainingProgressRepository,
  ) {}

  async completion(ctx: RequestContext, moduleCodes: readonly string[]): Promise<Map<string, ModuleCompletion>> {
    const members = await this.memberships.find(
      ctx, { status: 'active', ...NOT_A_TEST_ACCOUNT }, { projection: { _id: 1 } },
    );
    const ids = members.map((m) => String(m._id));
    const byModule = new Map<string, ModuleCompletion>(
      moduleCodes.map((code) => [code, { done: 0, started: 0, of: ids.length }]),
    );
    if (ids.length === 0 || moduleCodes.length === 0) return byModule;

    const rows = await this.progress.aggregate(ctx, [
      {
        $match: {
          membershipId: { $in: ids },
          moduleCode: { $in: [...new Set(moduleCodes)] },
          status: { $in: ['in_progress', 'done'] },
        },
      },
      { $group: { _id: { moduleCode: '$moduleCode', status: '$status' }, n: { $sum: 1 } } },
    ]);
    for (const row of rows) {
      const key = row._id as { moduleCode: string; status: string };
      const into = byModule.get(key.moduleCode);
      if (!into) continue;
      const n = Number(row.n ?? 0);
      into.started += n;
      if (key.status === 'done') into.done += n;
    }
    return byModule;
  }
}
