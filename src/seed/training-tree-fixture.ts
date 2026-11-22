import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { ConfigSnapshot, ConfigSnapshotSchema } from '@/modules/config/config-snapshot.schema';
import { TrainingModule, TrainingModuleSchema } from '@/modules/training/training-module.schema';
import { TrainingProgress, TrainingProgressSchema } from '@/modules/training/training-progress.schema';
import { TrainingSkill, TrainingSkillSchema } from '@/modules/training/training-skill.schema';
import { seedObjectId } from './coaching-fixture';

/**
 * **Pengaturan › Training as one tree, with something under every category** (P19.25-T4, ADR-0282; the brief's *"Kategori
 * (Sales, Product, Recruiting, Team Management, Soft Skills; "n skill · n modul") › Skill › Modul"*).
 *
 * The default catalog fills *Sales* alone (`training-taxonomy.ts`), so 0417's other categories opened onto nothing. This
 * gives *Produk*, *Recruitment*, *Manajemen tim* and *Soft skills* a skill each and two or three modules: some with a
 * link the office added (the row's item, with *Ganti*), some with nothing yet (*Unggah materi*), and a few of 0417's
 * cast with progress on them, so each row reads *"n dari 30 selesai"* or *Belum ada yang belajar*. *Sales* keeps what
 * `training-fixture.ts` gives it: the company's PDFs where storage is configured, its link, its progress.
 *
 * | Signed in as | Sees |
 * |---|---|
 * | `owner@kpm0417.test` (Wilson), `admin@kpm0417.test` | Pengaturan › Training: *Sales* open on *Pencarian prospek*, its modules' files and counts; *Produk*, *Recruitment*, *Manajemen tim*, *Soft skills* each *"1 skill · n modul"*; *Mengenal produk utama* with its link and *Ganti*, *Istilah polis* with *Unggah materi*, *Proses NPA* *"2 dari … selesai"*, *Opportunity talk* *Belum ada yang belajar* |
 * | `rina@kpm0417.test` (Agent) | `/training`: the four categories now hold modules she can open |
 *
 * **No publish bar speaks of it**: 0417's newest published copy is given the same skills and modules in place, as
 * `training-names-fixture.ts` gives it its lines — agents read them at once, and *Training* stays published on the hub.
 * **Written once, by derived ids**: a skill or module already there (by code, any status) is left as it is, and so is a
 * progress row; a re-run writes nothing.
 */

const RECOMPILE = { overwriteModels: true } as const;
const DAY_MS = 86_400_000;

type Material = { label: string; url: string } | null;

/** The four categories' skills and modules, in order. Codes are permanent (invariant §3), titles the office's words. */
export const TRAINING_TREE_SEED: readonly {
  categoryCode: string;
  skill: { code: string; label: string; description: string };
  modules: readonly { code: string; title: string; material: Material }[];
}[] = [
  {
    categoryCode: 'PRODUCT',
    skill: { code: 'PRODUCT_BASICS', label: 'Dasar asuransi', description: 'Kenali produk dan istilah sebelum bertemu nasabah.' },
    modules: [
      { code: 'PRODUCT_INTRO', title: 'Mengenal produk utama', material: { label: 'Ringkasan produk', url: 'https://example.com/agencyboost/ringkasan-produk' } },
      { code: 'POLICY_TERMS', title: 'Istilah polis', material: null },
    ],
  },
  {
    categoryCode: 'RECRUITING',
    skill: { code: 'RECRUIT_PRESENTATION', label: 'Presentasi rekrut', description: 'Ceritakan peluang karier dengan jelas.' },
    modules: [
      { code: 'OPPORTUNITY_TALK', title: 'Opportunity talk', material: null },
      { code: 'NPA_PROCESS', title: 'Proses NPA', material: { label: 'Langkah NPA', url: 'https://example.com/agencyboost/langkah-npa' } },
    ],
  },
  {
    categoryCode: 'TEAM_MANAGEMENT',
    skill: { code: 'ONE_ON_ONE_COACHING', label: 'Coaching 1-on-1', description: 'Satu pertemuan singkat setiap minggu.' },
    modules: [
      { code: 'WEEKLY_COACHING_FORMAT', title: 'Format coaching mingguan', material: { label: 'Format coaching', url: 'https://example.com/agencyboost/format-coaching' } },
      { code: 'COACHING_FOLLOW_UP', title: 'Menindaklanjuti hasil coaching', material: null },
    ],
  },
  {
    categoryCode: 'SOFT_SKILLS',
    skill: { code: 'COMMUNICATION', label: 'Komunikasi', description: 'Dengar dulu, baru bicara.' },
    modules: [
      { code: 'ACTIVE_LISTENING', title: 'Mendengar aktif', material: null },
    ],
  },
];

/** Who has done or begun what, by 0417's cast key. Anything unlisted is *Belum ada yang belajar*. */
export const TRAINING_TREE_PROGRESS: Readonly<Record<string, { done: readonly string[]; inProgress: readonly string[] }>> = {
  agus: { done: ['PRODUCT_INTRO', 'NPA_PROCESS', 'WEEKLY_COACHING_FORMAT'], inProgress: [] },
  siti: { done: ['PRODUCT_INTRO', 'NPA_PROCESS'], inProgress: ['WEEKLY_COACHING_FORMAT'] },
  rina: { done: ['PRODUCT_INTRO'], inProgress: ['POLICY_TERMS'] },
  dewi: { done: ['PRODUCT_INTRO'], inProgress: [] },
};

export interface TrainingTreeFixture {
  /** Skills, modules, progress rows and the snapshot this run wrote — 0 on a re-run. */
  written: number;
}

export async function seedTrainingTreeFixture({ clock, kpmId, cast }: {
  clock: Clock;
  kpmId: string;
  /** 0417's cast, by the keys `TRAINING_TREE_PROGRESS` names: membership ids. */
  cast: Readonly<Record<string, string>>;
}): Promise<TrainingTreeFixture> {
  const Skills = mongoose.model(TrainingSkill.name, TrainingSkillSchema, undefined, RECOMPILE);
  const Modules = mongoose.model(TrainingModule.name, TrainingModuleSchema, undefined, RECOMPILE);
  const Progress = mongoose.model(TrainingProgress.name, TrainingProgressSchema, undefined, RECOMPILE);
  const Snapshots = mongoose.model(ConfigSnapshot.name, ConfigSnapshotSchema, undefined, RECOMPILE);
  const now = clock.now();
  let written = 0;
  const added: { categoryCode: string; skillId: string }[] = [];

  for (const branch of TRAINING_TREE_SEED) {
    const categoryLive = await mongoose.connection.collection('trainingCategories')
      .findOne({ kpmId, code: branch.categoryCode, status: 'active', deletedAt: null });
    if (!categoryLive) continue;
    let skill = await Skills.findOne({ kpmId, code: branch.skill.code }).lean().exec();
    if (!skill) {
      const order = await Skills.countDocuments({ kpmId, categoryCode: branch.categoryCode }).exec();
      const created = await Skills.create({
        _id: seedObjectId(`training-tree:${kpmId}:skill:${branch.skill.code}`),
        kpmId, code: branch.skill.code, categoryCode: branch.categoryCode, label: branch.skill.label,
        description: branch.skill.description, displayOrder: order + 1, version: 1, status: 'active', archivedAt: null,
      });
      skill = created.toObject();
      added.push({ categoryCode: branch.categoryCode, skillId: String(created._id) });
      written += 1;
    }
    for (const [index, module] of branch.modules.entries()) {
      if (await Modules.exists({ kpmId, code: module.code }).exec()) continue;
      await Modules.create({
        _id: seedObjectId(`training-tree:${kpmId}:module:${module.code}`),
        kpmId, code: module.code, skillCode: branch.skill.code, title: module.title, description: null,
        publishState: 'published', displayOrder: index + 1, version: 1, status: 'active', archivedAt: null,
        officeContent: module.material
          ? { files: [], videos: [], links: [{ id: `seed-${module.code.toLowerCase()}`, ...module.material }] }
          : null,
      });
      written += 1;
    }
  }

  // Progress: a row per member and module, once (the unique index is per member and module code).
  for (const [key, plan] of Object.entries(TRAINING_TREE_PROGRESS)) {
    const membershipId = cast[key];
    if (!membershipId) continue;
    const rows = [
      ...plan.done.map((moduleCode, i) => ({ moduleCode, status: 'done' as const, daysAgo: 20 - i * 3 })),
      ...plan.inProgress.map((moduleCode, i) => ({ moduleCode, status: 'in_progress' as const, daysAgo: 6 - i })),
    ];
    for (const row of rows) {
      if (await Progress.exists({ kpmId, membershipId, moduleCode: row.moduleCode, deletedAt: null }).exec()) continue;
      const at = new Date(now.getTime() - row.daysAgo * DAY_MS);
      await Progress.create({
        kpmId, membershipId, moduleCode: row.moduleCode, status: row.status, startedAt: at,
        completedAt: row.status === 'done' ? at : null, opened: [], version: 1,
      });
      written += 1;
    }
  }

  /*
   * **0417's published copy says the same, in place** (the pattern of `training-names-fixture.ts`): each new skill, with
   * its published modules, appended to its category as the working read orders them — so the publish gate compares
   * equal and *Training* reads as published on the hub, as the hub's fixture expects of every setting but one.
   */
  if (added.length > 0) {
    const [newest] = await Snapshots.find({ kpmId }).sort({ version: -1 }).limit(1).lean().exec();
    if (newest) {
      type Tree = { code: string; skills: unknown[] }[];
      const payload = newest.payload as { training?: Tree };
      const view = async (skillId: string) => {
        const s = (await Skills.findById(skillId).lean().exec())!;
        const modules = await Modules.find({ kpmId, skillCode: s.code, status: 'active', publishState: 'published' })
          .sort({ displayOrder: 1 }).lean().exec();
        return {
          id: String(s._id), code: s.code, categoryCode: s.categoryCode, label: s.label, description: s.description ?? null,
          displayOrder: s.displayOrder, version: s.version, status: s.status,
          modules: modules.map((m) => ({
            id: String(m._id), code: m.code, skillCode: m.skillCode, title: m.title, description: m.description ?? null,
            publishState: m.publishState, displayOrder: m.displayOrder, version: m.version, status: m.status,
          })),
        };
      };
      const training: Tree = [];
      for (const category of payload.training ?? []) {
        const mine = added.filter((a) => a.categoryCode === category.code);
        training.push({ ...category, skills: [...category.skills, ...(await Promise.all(mine.map((a) => view(a.skillId))))] });
      }
      await Snapshots.updateOne({ _id: newest._id }, { $set: { 'payload.training': training } }).exec();
      written += 1;
    }
  }

  return { written };
}
