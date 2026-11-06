import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import { CompanyTemplate, CompanyTemplateSchema } from '@/modules/config/company-template.schema';
import { ConfigSnapshot, ConfigSnapshotSchema } from '@/modules/config/config-snapshot.schema';
import { NamedTemplate, NamedTemplateSchema } from '@/modules/config/named-template.schema';
import { TrainingSkill, TrainingSkillSchema } from '@/modules/training/training-skill.schema';

/**
 * **Short names with a description, and *Sinkron dari template*, seeded** (P19.6-T4; ADR-0220; UI-161, OD-270).
 *
 * | Signed in as | Sees |
 * |---|---|
 * | `rina@kpm0417.test` (Agent) | `/training/SALES`: each of the six skills one short line, its *Deskripsi singkat* under it in grey |
 * | `owner@kpm0417.test` (Wilson), `admin@kpm0417.test` | Settings › Training: ***Sinkron dari template*** in the toolbar. It lists, by code, what Prudential template's newer Training and Capability would change — three modules' descriptions, *Retensi nasabah* → *Mempertahankan nasabah*, and the capability item *Konsistensi pencarian leads* → *Pencarian prospek* — old beside new. *Terapkan* takes them; agents read them at once, and Capability Mapping's item is named as the skill |
 * | `superadmin@agencyboost.test` in a view-as of 0417 | the same list, and *Terapkan* refused |
 *
 * **Demo words, not production's.** OD-272 gives the platform's Default template and this seed production's Training v7
 * and Capability v4 names, from a read-only export of production (ADR-0220 §5) that the operator has not yet supplied.
 * Until it is, the six default skills carry the demo lines below, and Prudential's template a newer version that differs
 * from 0417 in a few names, so the sync has something to show.
 *
 * **Written once.** 0417's skills take their line only where they hold none, with no version moved, and its newest
 * published copy is given the same lines in place — as migration `0045` gave categories theirs — so no publish bar
 * speaks of it. The template's version is published only while its newest holds none of the module lines below. A
 * re-run writes nothing; a sync in a walk is kept.
 */

const RECOMPILE = { overwriteModels: true } as const;

/** The six default skills' *Deskripsi singkat*, in 0417 and in Prudential's template alike (demo copy). */
export const DEMO_SKILL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  PROSPECTING: 'Temukan dan catat calon nasabah baru setiap minggu.',
  NEEDS_ANALYSIS: 'Gali kebutuhan perlindungan sebelum menawarkan produk.',
  OBJECTION_HANDLING: 'Jawab keberatan nasabah dengan tenang dan jelas.',
  CLOSING: 'Ajak nasabah mengambil keputusan hari ini.',
  CROSS_SELL: 'Tambahkan perlindungan untuk nasabah yang sudah ada.',
  RETENTION: 'Jaga hubungan agar polis nasabah tetap aktif.',
};

/** What Prudential's template's newer Training holds that 0417 does not: module lines, and one skill's new name. */
export const DEMO_TEMPLATE_NAMES = {
  modules: {
    PROSPECT_LIST: 'Daftar 100 nama untuk dihubungi minggu ini.',
    REFERRAL_GENERATION: 'Minta nama baru dari nasabah yang puas.',
    COLD_APPROACH_SCRIPTS: 'Kalimat pembuka untuk prospek yang belum kenal.',
  } as Readonly<Record<string, string>>,
  skills: { RETENTION: 'Mempertahankan nasabah' } as Readonly<Record<string, string>>,
  /** A capability item named as its skill (Capability v4's rule, ADR-0220 §4): `<GRID>:<ITEM>`. */
  capability: { 'PERSONAL_SELLING:LEADS_GEN': 'Pencarian prospek' } as Readonly<Record<string, string>>,
} as const;

export interface TrainingNamesFixtureDeps {
  clock: Clock;
  companyId: string;
  /** 0417, whose skills carry the lines and whose Owner sees the sync. */
  kpmId: string;
}

export interface TrainingNamesFixture {
  /** 0417's skills given their line on this run. */
  skills: number;
  /** Template versions published on this run: Training and Capability, or none on a re-run. */
  templateVersions: number;
  guide: string;
}

type Row = Record<string, unknown>;

export async function seedTrainingNamesFixture(deps: TrainingNamesFixtureDeps): Promise<TrainingNamesFixture> {
  const now = deps.clock.now();
  const Skills = mongoose.model(TrainingSkill.name, TrainingSkillSchema, undefined, RECOMPILE);
  const Snapshots = mongoose.model(ConfigSnapshot.name, ConfigSnapshotSchema, undefined, RECOMPILE);
  const Templates = mongoose.model(CompanyTemplate.name, CompanyTemplateSchema, undefined, RECOMPILE);
  const Named = mongoose.model(NamedTemplate.name, NamedTemplateSchema, undefined, RECOMPILE);

  // ---- 0417's six skills, their line where they hold none; no version moves.
  let skills = 0;
  for (const [code, description] of Object.entries(DEMO_SKILL_DESCRIPTIONS)) {
    const written = await Skills.updateOne(
      { kpmId: deps.kpmId, code, deletedAt: null, $or: [{ description: null }, { description: { $exists: false } }] },
      { $set: { description } },
    ).exec();
    skills += written.modifiedCount;
  }
  // …and its agents' copy, in place, as `0045` gave categories theirs.
  const [newest] = await Snapshots.find({ kpmId: deps.kpmId, deletedAt: null }).sort({ version: -1 }).limit(1).lean().exec();
  const tree = (newest?.payload as { training?: { skills?: Row[] }[] } | undefined)?.training;
  if (newest && Array.isArray(tree)) {
    let touched = false;
    const next = tree.map((category) => ({
      ...category,
      skills: (category.skills ?? []).map((skill) => {
        const line = DEMO_SKILL_DESCRIPTIONS[String(skill.code)];
        if (!line || skill.description) return skill;
        touched = true;
        return { ...skill, description: line };
      }),
    }));
    if (touched) await Snapshots.updateOne({ _id: newest._id }, { $set: { 'payload.training': next } }).exec();
  }

  // ---- Prudential's default template: a newer Training and Capability than 0417's, once.
  const template = await Named.findOne({ companyId: deps.companyId, isDefault: true, deletedAt: null }).lean().exec();
  let templateVersions = 0;
  if (template) {
    const templateId = String(template._id);
    const publishNext = async (kind: 'training_taxonomy' | 'capability_ladder', change: (payload: Row) => Row | null) => {
      const scope = { companyId: deps.companyId, templateId, kind, deletedAt: null };
      const [top] = await Templates.find({ ...scope, status: 'published' }).sort({ version: -1 }).limit(1).lean().exec();
      if (!top) return;
      const payload = change(structuredClone(top.payload as Row));
      if (!payload) return;
      const version = Number(top.version) + 1;
      const draft = await Templates.findOne({ ...scope, status: 'draft' }).exec();
      if (draft && draft.version <= version) await Templates.updateOne({ _id: draft._id }, { $set: { version: version + 1 } }).exec();
      const [byRevision] = await Templates.find(scope).sort({ revision: -1 }).limit(1).lean().exec();
      await Templates.create({
        ...scope, version, revision: Number(byRevision?.revision ?? 0) + 1, status: 'published', payload, publishedAt: now,
        migratedFrom: null, createdBy: 'seed:demo', updatedBy: 'seed:demo',
      });
      templateVersions += 1;
    };

    await publishNext('training_taxonomy', (payload) => {
      const modules = (payload.modules ?? []) as Row[];
      // Done once: the newest already holds the module lines.
      if (modules.some((m) => m.description === DEMO_TEMPLATE_NAMES.modules[String(m.code)])) return null;
      return {
        ...payload,
        skills: ((payload.skills ?? []) as Row[]).map((s) => ({
          ...s,
          label: DEMO_TEMPLATE_NAMES.skills[String(s.code)] ?? s.label,
          description: DEMO_SKILL_DESCRIPTIONS[String(s.code)] ?? s.description ?? null,
        })),
        modules: modules.map((m) => ({ ...m, description: DEMO_TEMPLATE_NAMES.modules[String(m.code)] ?? m.description ?? null })),
      };
    });
    await publishNext('capability_ladder', (payload) => {
      const grids = (payload.grids ?? []) as (Row & { items?: Row[] })[];
      const named = (g: Row, i: Row) => DEMO_TEMPLATE_NAMES.capability[`${String(g.code)}:${String(i.code)}`];
      if (grids.some((g) => (g.items ?? []).some((i) => named(g, i) && i.label === named(g, i)))) return null;
      return { ...payload, grids: grids.map((g) => ({ ...g, items: (g.items ?? []).map((i) => ({ ...i, label: named(g, i) ?? i.label })) })) };
    });
  }

  const guide = `
  TRAINING NAMES  short names with a description, and Sinkron dari template (P19.6-T4, src/seed/training-names-fixture.ts)
    rina@kpm0417.test            /training/SALES: each skill one line, its description under it in grey
    owner@kpm0417.test           /kpm/settings/training: "Sinkron dari template" lists, by code, three module
                                 descriptions, Retensi nasabah -> Mempertahankan nasabah and a capability item named
                                 as its skill; "Terapkan" takes them, and agents read them at once
    Demo words: production's Training v7 / Capability v4 names wait on the operator's export (OD-272)
`;
  return { skills, templateVersions, guide };
}
