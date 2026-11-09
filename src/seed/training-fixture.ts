import mongoose from 'mongoose';
import type { Clock } from '@/common/clock/clock.port';
import type { TrainingStatus } from '@/domain/constants';
import { Asset, AssetSchema } from '@/modules/assets/asset.schema';
import type { StoragePort } from '@/modules/assets/storage.port';
import { ActivationTemplate, ActivationTemplateSchema } from '@/modules/activation/activation-template.schema';
import { ActivationProgress, ActivationProgressSchema } from '@/modules/activation/activation-progress.schema';
import { ConfigSnapshot, ConfigSnapshotSchema } from '@/modules/config/config-snapshot.schema';
import { TrainingModule, TrainingModuleSchema } from '@/modules/training/training-module.schema';
import { TrainingProgress, TrainingProgressSchema } from '@/modules/training/training-progress.schema';
import { TrainingSkill, TrainingSkillSchema } from '@/modules/training/training-skill.schema';
import { CompanyTemplate, CompanyTemplateSchema } from '@/modules/config/company-template.schema';
import { NamedTemplate, NamedTemplateSchema } from '@/modules/config/named-template.schema';
import { servedLesson } from '@/modules/config/lesson-files';
import { seedObjectId } from './coaching-fixture';
import { demonstrationPdf } from './recruitment-fixture';

/**
 * **Training, as its learners live it** (Phase 18.2, P18.2-T1 AC-11, P18.2-T3 AC-8; the phase file's *Seed*):
 * progress across 0417's coaching cast, modelled on the prototype's Rina and Jordan (`Overall.html:7756-7763`) and the
 * Owner tree's Joko, Andi and Ayu (`KPM_Owner.html:3025-3054`); the training link bound in 0555 for Lina
 * (D-seed-link a); a module Lina did and the office then withdrew (D-history); a draft nobody is offered; and the
 * company's material for the Sales modules, by reference.
 *
 * | Signed in as | Sees |
 * |---|---|
 * | `rina@kpm0417.test` (Agent) | `/training` → `/training/SALES`: six skill cards; *Building Your Prospect List*, *Referral Generation Techniques*, *Cold Approach Scripts* and *Conducting a Financial Needs Analysis* **Done**, *Asking the Right Discovery Questions* **In progress**, the rest *Not started*. *Closing Techniques That Work*'s link already *Opened* ✓. Mark *Discovery Questions* Done for the toast; `/coaching/me/training` *Sales (4/10)*, then *(5/10)* |
 * | `sari@kpm0417.test` (AAB) → Rina | The coach's *Training* tab reads what Rina sees; one `activity_log.read_raw`, surface `training`, at `/admin/audit` |
 * | `agus@kpm0417.test` (AB) | Jordan's analogue: all ten **Done**, *Sales (10/10)*. His coachees **Indah** (Joko's pattern: 5 done, 2 in progress) and **Dimas** (Andi's: 4 done, 1 in progress) |
 * | `arief@kpm0417.test` → Novi, Wahyu | **Novi** (Ayu's pattern): nothing started, *Sales (0/10)*. **Wahyu**: 2 done |
 * | `siti@kpm0417.test` | Graduated; ten done |
 * | `removed@kpm0417.test` (Yanti) | **The re-join**: three done on her first, removed membership; none on the current one — *(0/10)* |
 * | `budi@`, `dewi@`, `admin@kpm0417.test` | Budi one *In progress*; Dewi three done; Maya Halim two done (she learns as the AB she is) |
 * | `agent@kpm0555.test` (Lina) | **T3** (D-seed-link a): 0555's checklist binds item 9 to *Closing Techniques That Work*. `/activation` (day 61, prospects done) shows item 9 *Auto* with *Go to Closing Techniques That Work →*; mark it Done and item 9 ticks, attributed. **D-history**: *Client Retention Best Practices*, which she did, is archived — absent from her `/training`, *Archived* on her person tab, outside *Sales (1/9)*. **A draft**: *Dasar-dasar PRUMapan* in *Product* is not offered |
 * | `owner@kpm0555.test` (Hendra) | Settings › Activation checklist: item 9 *Auto*. Field view → coaching → Lina → *Training* |
 *
 * **Content.** *Closing Techniques That Work* carries one `https` link, *External resource*, in both offices. Where
 * storage is configured, each Sales module also carries a one-page PDF written here as **Prudential's company
 * material, by reference** — a company asset both offices read, so *"0417 holds no training file of its own"* stays
 * true. Without storage the PDFs are skipped, the tiles fall to the link and the empty line, and the run says so.
 * No video is seeded: *Play Video* is walked by uploading a short mp4 in Settings first. **One HTML lesson**
 * (P19.6-T2, ADR-0217) goes first in *Building Your Prospect List*, before its PDF, the company's too — added to a
 * database seeded before as well, by its derived item id, so Rina opens it in the sandboxed frame.
 *
 * **No reviewed walk moves**: every row is a `trainingProgress` row, nothing before this phase reads, or 0555's
 * catalog and checklist (the flagged change: its checklist's version 2 binds item 9, Lina repinned to it, her day 61
 * and her prospects item kept; its published copy — still *version 1* — carries both, so its publish bar says only
 * what it said before). Content is set only on a module that holds none, and no module's `version` moves, so no
 * office's publish bar speaks of it. **Derived ids, written once until `--reset`**: a row already there, or one a walk
 * made, is left as it is; a re-run writes nothing.
 */

const RECOMPILE = { overwriteModels: true } as const;
const DAY_MS = 86_400_000;

/** Sales's ten modules, in the catalog's order: the codes every row below names. */
export const SALES = [
  'PROSPECT_LIST', 'REFERRAL_GENERATION', 'COLD_APPROACH_SCRIPTS', 'FINANCIAL_NEEDS_ANALYSIS', 'DISCOVERY_QUESTIONS',
  'OBJECTION_FUNDAMENTALS', 'CLOSING_TECHNIQUES', 'PRICE_OBJECTIONS', 'CROSS_SELL_OPPORTUNITIES', 'CLIENT_RETENTION',
] as const;
type SalesCode = (typeof SALES)[number];

/** Who did what in 0417, by the fixture's cast key. Anything unlisted is *Not started*. */
export const TRAINING_SEED_0417: Readonly<Record<TrainingCastKey, { done: readonly SalesCode[]; inProgress: readonly SalesCode[] }>> = {
  rina: {
    done: ['PROSPECT_LIST', 'REFERRAL_GENERATION', 'COLD_APPROACH_SCRIPTS', 'FINANCIAL_NEEDS_ANALYSIS'],
    inProgress: ['DISCOVERY_QUESTIONS'],
  },
  agus: { done: SALES, inProgress: [] },
  indah: {
    done: ['PROSPECT_LIST', 'REFERRAL_GENERATION', 'COLD_APPROACH_SCRIPTS', 'FINANCIAL_NEEDS_ANALYSIS', 'DISCOVERY_QUESTIONS'],
    inProgress: ['OBJECTION_FUNDAMENTALS', 'CLOSING_TECHNIQUES'],
  },
  dimas: {
    done: ['PROSPECT_LIST', 'REFERRAL_GENERATION', 'FINANCIAL_NEEDS_ANALYSIS', 'OBJECTION_FUNDAMENTALS'],
    inProgress: ['CLOSING_TECHNIQUES'],
  },
  novi: { done: [], inProgress: [] },
  wahyu: { done: ['PROSPECT_LIST', 'COLD_APPROACH_SCRIPTS'], inProgress: [] },
  siti: { done: SALES, inProgress: [] },
  yantiFirst: { done: ['PROSPECT_LIST', 'REFERRAL_GENERATION', 'FINANCIAL_NEEDS_ANALYSIS'], inProgress: [] },
  yanti: { done: [], inProgress: [] },
  budi: { done: [], inProgress: ['PROSPECT_LIST'] },
  dewi: { done: ['PROSPECT_LIST', 'CLOSING_TECHNIQUES', 'PRICE_OBJECTIONS'], inProgress: [] },
  maya: { done: ['PROSPECT_LIST', 'REFERRAL_GENERATION'], inProgress: [] },
};

/** Lina's, in 0555: *Client Retention Best Practices* done before the office withdrew it (D-history). */
export const TRAINING_SEED_LINA = {
  done: ['CLIENT_RETENTION', 'PROSPECT_LIST'] as const,
  inProgress: ['FINANCIAL_NEEDS_ANALYSIS'] as const,
};

/** The module 0555 withdraws after Lina did it, the item its checklist binds, and the draft nobody is offered. */
export const TRAINING_SEED_0555 = {
  archived: 'CLIENT_RETENTION',
  bound: { item: 'MANDATORY_TRAINING', link: 'training:CLOSING_TECHNIQUES' },
  draftSkill: { code: 'PRODUCT_KNOWLEDGE', categoryCode: 'PRODUCT', label: 'Pengetahuan produk' },
  draftModule: { code: 'PRUMAPAN_BASICS', skillCode: 'PRODUCT_KNOWLEDGE', title: 'Dasar-dasar PRUMapan' },
} as const;

/** The company's link on *Closing Techniques That Work*, in both offices. */
export const TRAINING_SEED_LINK = {
  moduleCode: 'CLOSING_TECHNIQUES',
  id: seedObjectId('training-fixture', 'item', 'CLOSING_TECHNIQUES', 'link'),
  label: 'Teknik closing: bacaan lanjutan',
  url: 'https://www.prudential.co.id/',
} as const;

/**
 * **One HTML lesson, so a reviewer sees one in the sandboxed frame** (P19.6-T2, ADR-0217): the company's, on *Building
 * Your Prospect List*, first in the module and beside its PDF — the shape P19.6-T3 gives the owner's 23 lessons. Written
 * only where storage is configured, as the PDFs are.
 */
export const TRAINING_SEED_LESSON = {
  moduleCode: 'PROSPECT_LIST',
  id: seedObjectId('training-fixture', 'item', 'PROSPECT_LIST', 'lesson'),
  name: 'PROSPECT_LIST-lesson',
} as const;

/**
 * **A demonstration lesson, self-contained as the owner's are** (ADR-0217 §7): its colours are CSS variables on
 * `:root`, its table of contents links to anchors in the page, and its one small script keeps those links inside the
 * frame and reads the KPM's colours from the address's fragment exactly as ADR-0217 §5 states — three names, six
 * lower-case hexadecimal digits each, and nothing else. It loads nothing from anywhere.
 */
export function demonstrationLesson(title: string): Buffer {
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const sections = [
    ['tujuan', 'Tujuan', 'Setelah pelajaran ini Anda bisa menyusun daftar 100 nama dan memilah siapa yang dihubungi dulu.'],
    ['langkah', 'Langkah', 'Tulis nama dari keluarga, teman, rekan kerja dan komunitas. Beri tanda siapa yang paling mudah dihubungi.'],
    ['latihan', 'Latihan', 'Tambahkan sepuluh nama ke Leads hari ini, lalu tandai lima yang akan Anda hubungi minggu ini.'],
  ];
  const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
:root { --accent: #d9822b; --accent-soft: #fbefe2; --ink: #1c2340; }
body { margin: 0; font-family: system-ui, sans-serif; color: var(--ink); line-height: 1.6; }
header { background: var(--ink); color: #fff; padding: 24px 16px; }
header p { margin: 4px 0 0; color: var(--accent-soft); }
nav, section { max-width: 720px; margin: 0 auto; padding: 16px; }
nav a { color: var(--accent); margin-right: 16px; font-weight: 600; }
section { min-height: 70vh; border-top: 4px solid var(--accent-soft); }
h2 { color: var(--accent); }
</style>
</head>
<body>
<header><h1>${escape(title)}</h1><p>AgencyBoost: pelajaran demonstrasi. Ini bukan materi pelatihan sungguhan.</p></header>
<nav>${sections.map(([id, heading]) => `<a href="#${id}">${heading}</a>`).join('')}</nav>
${sections.map(([id, heading, body]) => `<section id="${id}"><h2>${heading}</h2><p>${body}</p></section>`).join('\n')}
<script>
(function () {
  var names = { accent: '--accent', accentSoft: '--accent-soft', ink: '--ink' };
  location.hash.slice(1).split('&').forEach(function (pair) {
    var kv = pair.split('=');
    if (names.hasOwnProperty(kv[0]) && /^[0-9a-f]{6}$/.test(kv[1] || '')) {
      document.documentElement.style.setProperty(names[kv[0]], '#' + kv[1]);
    }
  });
  document.querySelectorAll('nav a').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      document.getElementById(a.getAttribute('href').slice(1)).scrollIntoView({ behavior: 'smooth' });
    });
  });
})();
</script>
</body>
</html>
`;
  // Served as the owner's are (`servedLesson`, P19.6-T3): its anchors use `scrollIntoView`, which without the scroll
  // keeper also scrolls the page behind the lesson's window.
  return Buffer.from(servedLesson(html), 'utf8');
}

export type TrainingCastKey =
  | 'rina' | 'agus' | 'indah' | 'dimas' | 'novi' | 'wahyu' | 'siti' | 'yantiFirst' | 'yanti' | 'budi' | 'dewi' | 'maya';

export interface TrainingFixtureDeps {
  clock: Clock;
  /** The storage the company's PDFs are written through; `null` or absent skips them. */
  storage?: StoragePort | null;
  /** Prudential: the company both offices belong to, whose material the modules reference. */
  companyId: string;
  /** Membership ids, by who. `yantiFirst` is Yanti's first, removed membership. */
  office0417: { kpmId: string; cast: Record<TrainingCastKey, string> };
  office0555: { kpmId: string; lina: string };
}

export interface TrainingFixture {
  /** Rows this run wrote: progress, catalog, checklist, snapshot, asset — 0 on a re-run. */
  written: number;
  /** Files this run sent to storage. */
  sent: number;
  files: 'stored' | 'skipped: storage is not configured' | `skipped: storage refused (${string})`;
  /** `null`, or why 0555's item 9 was left unbound on this run. */
  checklist: string | null;
  /** Prudential's default template's material (ADR-0208 §1): the version this run published, or `null`. */
  templateMaterial: TemplateMaterialSeed;
  guide: string;
}

/** What the template's material step wrote: the training version it published, and the modules it filled. */
export interface TemplateMaterialSeed {
  written: number;
  /** The `training_taxonomy` version published with the material; `null` when this run published none. */
  version: number | null;
  /** The module codes that carry material in it. */
  modules: string[];
}

/** The derived id of the `training_taxonomy` version that carries the template's material: one per template. */
export const templateMaterialRowId = (templateId: string) =>
  seedObjectId('training-fixture', 'template-material', templateId);

/**
 * **Prudential's default template carries the company's material** (ADR-0208 §1, §2; UI-162 *Done when*): a new
 * `training_taxonomy` version of the template, published, whose modules hold what 0417's modules hold from the company
 * — the Sales PDFs where storage took them, and *Closing*'s link — by reference, never by copying bytes. So a KPM
 * created from the template at `/admin/tenants/new` shows material in those modules with nothing uploaded, and the
 * section's *x / y modul punya materi* counts them. 0417 and 0555 were given the version before it, so the publish
 * dialog lists them: 0417 *Belum diubah KPM*, 0555 — which withdrew a module and added a draft — *Sudah diubah KPM*.
 *
 * Written once, by derived id, and only where the template's newest training holds no material and no draft waits:
 * a walk's own publish or draft is kept.
 */
async function seedTemplateMaterial(
  deps: TrainingFixtureDeps,
  Modules: mongoose.Model<TrainingModule>,
  source: string,
  now: Date,
): Promise<TemplateMaterialSeed> {
  const Named = mongoose.model(NamedTemplate.name, NamedTemplateSchema, undefined, RECOMPILE);
  const Rows = mongoose.model(CompanyTemplate.name, CompanyTemplateSchema, undefined, RECOMPILE);
  const nothing: TemplateMaterialSeed = { written: 0, version: null, modules: [] };
  const template = await Named.findOne({ companyId: deps.companyId, isDefault: true, deletedAt: null }).lean().exec();
  if (!template) return nothing;
  const templateId = String(template._id);
  const _id = new mongoose.Types.ObjectId(templateMaterialRowId(templateId));
  if (await Rows.exists({ _id })) return nothing;
  const scope = { companyId: deps.companyId, templateId, kind: 'training_taxonomy', deletedAt: null };
  if (await Rows.exists({ ...scope, status: 'draft' })) return nothing;
  const newest = await Rows.findOne({ ...scope, status: 'published' }).sort({ version: -1 }).lean().exec();
  if (!newest) return nothing;

  type Item = Record<string, unknown>;
  type Content = { files?: Item[]; videos?: Item[]; links?: Item[] };
  const holds = (c: Content | null | undefined) => Boolean(c && ((c.files?.length ?? 0) + (c.videos?.length ?? 0) + (c.links?.length ?? 0)));
  const payload = structuredClone(newest.payload) as { modules?: (Item & { code: string; content?: Content })[] };
  if ((payload.modules ?? []).some((m) => holds(m.content))) return nothing;

  const plain = (items: Item[] | undefined) => (items ?? []).map(({ _id: _drop, ...rest }) => ({ ...rest }));
  const filled: string[] = [];
  for (const module of payload.modules ?? []) {
    const row = await Modules.findOne({ kpmId: source, code: module.code }).lean().exec();
    const company = row?.companyContent as unknown as Content | undefined;
    if (!holds(company)) continue;
    module.content = { files: plain(company!.files), videos: plain(company!.videos), links: plain(company!.links) };
    filled.push(module.code);
  }
  if (filled.length === 0) return nothing;

  const version = newest.version + 1;
  await Rows.create({
    _id, ...scope, version, revision: ((newest as { revision?: number }).revision ?? 0) + 1, status: 'published',
    payload, publishedAt: now, createdBy: null, updatedBy: null,
  });
  return { written: 1, version, modules: filled };
}

/** A progress row's derived id: one per office, member and module. */
export const trainingProgressId = (kpmId: string, membershipId: string, moduleCode: string) =>
  seedObjectId('training-fixture', 'progress', kpmId, membershipId, moduleCode);

export async function seedTrainingFixture(deps: TrainingFixtureDeps): Promise<TrainingFixture> {
  const Progress = mongoose.model(TrainingProgress.name, TrainingProgressSchema, undefined, RECOMPILE);
  const Modules = mongoose.model(TrainingModule.name, TrainingModuleSchema, undefined, RECOMPILE);
  const Skills = mongoose.model(TrainingSkill.name, TrainingSkillSchema, undefined, RECOMPILE);
  const Templates = mongoose.model(ActivationTemplate.name, ActivationTemplateSchema, undefined, RECOMPILE);
  const Activations = mongoose.model(ActivationProgress.name, ActivationProgressSchema, undefined, RECOMPILE);
  const Snapshots = mongoose.model(ConfigSnapshot.name, ConfigSnapshotSchema, undefined, RECOMPILE);
  const Assets = mongoose.model(Asset.name, AssetSchema, undefined, RECOMPILE);
  const now = deps.clock.now();
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const oid = (hex: string) => new mongoose.Types.ObjectId(hex);
  let written = 0;
  let sent = 0;
  let templateMaterial: TemplateMaterialSeed = { written: 0, version: null, modules: [] };

  /**
   * One member's row of one module, written only where neither this fixture's row nor any live row for the
   * member and module exists — a walk's own write is the member's and stays. Dated in days before today.
   */
  const row = async (
    kpmId: string, membershipId: string, moduleCode: string, status: TrainingStatus,
    days: { started: number | null; completed: number | null }, opened: { itemId: string; at: Date }[] = [],
  ) => {
    const _id = oid(trainingProgressId(kpmId, membershipId, moduleCode));
    if (await Progress.exists({ _id })) return;
    if (await Progress.exists({ kpmId, membershipId, moduleCode, deletedAt: null })) return;
    const started = days.started === null ? null : daysAgo(days.started);
    const doc = new Progress({
      _id, kpmId, membershipId, moduleCode, status, startedAt: started,
      completedAt: status === 'done' && days.completed !== null ? daysAgo(days.completed) : null,
      opened, version: status === 'done' ? 3 : 2, deletedAt: null, createdBy: membershipId, updatedBy: membershipId,
    }, null, { strict: 'throw' });
    await doc.validate();
    const touched = opened[0]?.at ?? started ?? now;
    await Progress.collection.insertOne({ ...doc.toObject(), createdAt: touched, updatedAt: touched });
    written += 1;
  };
  /**
   * A plan's rows, two days apart, the last finished `endDaysAgo` days ago — so each member's dates fall while
   * their membership was live (Yanti's first one ended 48 days ago). Started two days before each finish.
   */
  const rowsFor = async (
    kpmId: string, membershipId: string, plan: { done: readonly string[]; inProgress: readonly string[] }, endDaysAgo = 3,
  ) => {
    const all = [...plan.done, ...plan.inProgress];
    for (const [k, code] of all.entries()) {
      const finished = endDaysAgo + (all.length - 1 - k) * 2;
      const done = k < plan.done.length;
      await row(kpmId, membershipId, code, done ? 'done' : 'in_progress', { started: finished + 2, completed: done ? finished : null });
    }
  };

  // ------------------------------------------------ 0417's coaching cast

  const { office0417, office0555 } = deps;
  for (const [key, plan] of Object.entries(TRAINING_SEED_0417) as [TrainingCastKey, (typeof TRAINING_SEED_0417)[TrainingCastKey]][]) {
    // Yanti's first membership was removed 48 days ago: what she did, she did before that.
    await rowsFor(office0417.kpmId, office0417.cast[key], plan, key === 'yantiFirst' ? 50 : 3);
  }
  // Rina already opened the Closing link (D-opened): the ✓ is there on her first look.
  await row(office0417.kpmId, office0417.cast.rina, TRAINING_SEED_LINK.moduleCode, 'not_started', { started: null, completed: null }, [
    { itemId: TRAINING_SEED_LINK.id, at: daysAgo(2) },
  ]);

  // ------------------------------------------------ the company's material, by reference

  let files: TrainingFixture['files'] = 'stored';
  const offices = [office0417.kpmId, office0555.kpmId];
  for (const kpmId of offices) {
    const closing = await Modules.findOne({ kpmId, code: TRAINING_SEED_LINK.moduleCode }).lean().exec();
    if (closing && (closing.companyContent?.links ?? []).length === 0) {
      await Modules.updateOne({ _id: closing._id }, {
        $set: { 'companyContent.links': [{ id: TRAINING_SEED_LINK.id, label: TRAINING_SEED_LINK.label, url: TRAINING_SEED_LINK.url }] },
      }).exec();
      written += 1;
    }
  }
  if (!deps.storage) {
    files = 'skipped: storage is not configured';
  } else {
    try {
      for (const code of SALES) {
        const title = (await Modules.findOne({ kpmId: office0417.kpmId, code }).lean().exec())?.title ?? code;
        const fileName = `${title}.pdf`;
        const stored = await deps.storage.putObject({
          owner: { kind: 'company', companyId: deps.companyId }, folder: 'training', name: `${code}-demonstration`,
          mimeType: 'application/pdf',
          body: demonstrationPdf([
            'AgencyBoost - dokumen demonstrasi', title, 'Materi pelatihan perusahaan Prudential, sebagai rujukan.',
            'PDF satu halaman yang ditulis seed demo. Ini bukan materi pelatihan sungguhan.',
          ]),
        });
        if (stored.sent) sent += 1;
        if (!(await Assets.exists({ storageKey: stored.storageKey }))) {
          await Assets.create({
            kpmId: null, companyId: deps.companyId, storageKey: stored.storageKey, mimeType: stored.mimeType,
            bytes: stored.bytes, originalFilename: fileName, uploadedByMembershipId: null,
            refCount: offices.length, uploadState: 'confirmed', deletedAt: null,
          });
          written += 1;
        }
        for (const kpmId of offices) {
          const updated = await Modules.updateOne(
            { kpmId, code, 'companyContent.files': { $size: 0 } },
            { $set: { 'companyContent.files': [{
              id: seedObjectId('training-fixture', 'item', code, 'file'), label: fileName,
              storageKey: stored.storageKey, mimeType: stored.mimeType, bytes: stored.bytes,
            }] } },
          ).exec();
          written += updated.modifiedCount;
        }
      }

      // P19.6-T2: one HTML lesson, first in *Building Your Prospect List*, the PDF beside it (ADR-0217).
      const lessonTitle = (await Modules.findOne({ kpmId: office0417.kpmId, code: TRAINING_SEED_LESSON.moduleCode }).lean().exec())
        ?.title ?? TRAINING_SEED_LESSON.moduleCode;
      const lesson = await deps.storage.putObject({
        owner: { kind: 'company', companyId: deps.companyId }, folder: 'training', name: TRAINING_SEED_LESSON.name,
        mimeType: 'text/html', body: demonstrationLesson(lessonTitle),
      });
      if (lesson.sent) sent += 1;
      const lessonLabel = `Pelajaran: ${lessonTitle}`;
      if (!(await Assets.exists({ storageKey: lesson.storageKey }))) {
        await Assets.create({
          kpmId: null, companyId: deps.companyId, storageKey: lesson.storageKey, mimeType: lesson.mimeType,
          bytes: lesson.bytes, originalFilename: `${lessonTitle}.html`, uploadedByMembershipId: null,
          refCount: offices.length, uploadState: 'confirmed', deletedAt: null,
        });
        written += 1;
      }
      for (const kpmId of offices) {
        const updated = await Modules.updateOne(
          { kpmId, code: TRAINING_SEED_LESSON.moduleCode, 'companyContent.files.id': { $ne: TRAINING_SEED_LESSON.id } },
          { $push: { 'companyContent.files': { $each: [{
            id: TRAINING_SEED_LESSON.id, label: lessonLabel,
            storageKey: lesson.storageKey, mimeType: lesson.mimeType, bytes: lesson.bytes,
          }], $position: 0 } } },
        ).exec();
        written += updated.modifiedCount;
      }
    } catch (err) {
      files = `skipped: storage refused (${(err as Error).message ?? 'unknown'})`;
    }
  }

  // ------------------------------------------------ the template's material (ADR-0208 §1, §2; UI-162)

  templateMaterial = await seedTemplateMaterial(deps, Modules, office0417.kpmId, now);
  written += templateMaterial.written;

  // ------------------------------------------------ 0555: Lina, the binding, the withdrawal, the draft

  // Lina did *Client Retention* five weeks back, before 0555 withdrew it and published (30 days ago).
  await rowsFor(office0555.kpmId, office0555.lina, TRAINING_SEED_LINA, 33);

  const kpmId = office0555.kpmId;
  const { draftSkill, draftModule, archived, bound } = TRAINING_SEED_0555;
  type Version = { _id: unknown; version: number; aspects: { items: { code: string; autoLink: string | null }[] }[] };
  const bindsItem = (v: Version) => v.aspects.some((a) => a.items.some((i) => i.code === bound.item && i.autoLink === bound.link));

  // ---- The catalog's changes, once: the draft skill is their marker, so a walk's later edits are never undone.
  const catalogFresh = !(await Skills.exists({ kpmId, code: draftSkill.code }));
  if (catalogFresh) {
    // A skill in *Product* holding one module nobody is offered: a draft.
    await Skills.create({
      _id: oid(seedObjectId('training-fixture', 'skill', kpmId, draftSkill.code)), kpmId, ...draftSkill,
      displayOrder: 1, version: 1, status: 'active', archivedAt: null, deletedAt: null,
    });
    written += 1;
    if (!(await Modules.exists({ kpmId, code: draftModule.code }))) {
      await Modules.create({
        _id: oid(seedObjectId('training-fixture', 'module', kpmId, draftModule.code)), kpmId, ...draftModule,
        publishState: 'draft', displayOrder: 1, officeContent: null, version: 1, status: 'active', archivedAt: null,
        deletedAt: null,
      });
      written += 1;
    }
    // *Client Retention Best Practices*, withdrawn after Lina did it and before the office's publish 30 days ago.
    const withdrawn = await Modules.updateOne(
      { kpmId, code: archived, status: 'active' },
      { $set: { status: 'archived', archivedAt: daysAgo(31) }, $inc: { version: 1 } },
    ).exec();
    written += withdrawn.modifiedCount;
  }

  /*
   * ---- The checklist binding item 9 to the closing module (`KPM_Owner.html:1546`): the newest published version that
   * binds it, or one this fixture publishes as the office's next version — **never past an Owner's draft**, whose
   * number is the next version's and which would then be published under an older number than this one. With a draft
   * there and no binding, the binding is skipped and the run says so.
   */
  const published = await Templates.find({ kpmId, status: 'published', deletedAt: null }).sort({ version: -1 }).lean().exec() as unknown as Version[];
  let binding = published.find(bindsItem);
  let createdBinding = false;
  let checklist: string | null = null;
  // The version this fixture publishes, by its derived id: once it exists, an Owner who unbound item 9 since is not overruled.
  const v2Id = oid(seedObjectId('training-fixture', 'checklist', kpmId));
  if (!binding && published[0] && !(await Templates.exists({ _id: v2Id }))) {
    if (await Templates.exists({ kpmId, status: 'draft', deletedAt: null })) {
      checklist = 'item 9 left unbound: 0555 holds a draft checklist, so no version was published past it';
    } else {
      const [last] = await Templates.find({ kpmId }).sort({ version: -1 }).limit(1).lean().exec() as unknown as Version[];
      const aspects = published[0].aspects.map((a) => ({
        ...a, items: a.items.map((i) => (i.code === bound.item ? { ...i, autoLink: bound.link } : i)),
      }));
      binding = (await Templates.create({
        _id: v2Id, kpmId, version: last.version + 1,
        status: 'published', publishedAt: now, aspects, createdBy: null, updatedBy: null, deletedAt: null,
      })).toObject() as unknown as Version;
      createdBinding = true;
      written += 1;
    }
  }
  // Lina's open activation is pinned to it, whatever version she is on.
  if (binding) {
    const repinned = await Activations.updateMany(
      { kpmId, membershipId: office0555.lina, graduatedAt: null, deletedAt: null, templateVersion: { $ne: binding.version } },
      { $set: { templateId: String(binding._id), templateVersion: binding.version } },
    ).exec();
    written += repinned.modifiedCount;
  }

  /*
   * **0555's published copy says the same** — in place, on the snapshot it already has: agents there have been on it
   * since its publish 30 days ago, and that copy is what a reviewed walk reads (its *Published version 1*, and the
   * unpublished ratio and type edits the Owner holds since). Only what this run changed is written: the training —
   * less the withdrawn module, with the new skill (empty: its only module is a draft) — and the binding version of the
   * checklist. A new version instead would move that walk's number; this moves nothing but what this phase shows.
   */
  const [newest] = await Snapshots.find({ kpmId }).sort({ version: -1 }).limit(1).lean().exec();
  if (newest && (catalogFresh || createdBinding)) {
    const set: Record<string, unknown> = {};
    if (catalogFresh) {
      type Tree = { code: string; skills: { code: string; modules: { code: string }[] }[] }[];
      const payload = newest.payload as { training?: Tree };
      const skill = (await Skills.findOne({ kpmId, code: draftSkill.code }).lean().exec())!;
      set['payload.training'] = (payload.training ?? []).map((category) => ({
        ...category,
        skills: [
          ...category.skills.map((s) => ({ ...s, modules: s.modules.filter((m) => m.code !== archived) })),
          ...(category.code === draftSkill.categoryCode && !category.skills.some((s) => s.code === draftSkill.code)
            ? [{ ...skill, id: String(skill._id), modules: [] }]
            : []),
        ],
      }));
    }
    if (binding) {
      set['payload.activationChecklist'] = {
        id: String(binding._id), version: binding.version, status: 'published', publishedAt: null, aspects: binding.aspects,
      };
    }
    await Snapshots.updateOne({ _id: newest._id }, { $set: set }).exec();
    written += 1;
  }

  // The modules by the titles the offices hold: the company's words, which a database seeded before keeps (P18.10-T7).
  const titleIn = async (office: string, code: string) =>
    String((await Modules.findOne({ kpmId: office, code }).lean().exec())?.title ?? code);
  const discovery = await titleIn(office0417.kpmId, 'DISCOVERY_QUESTIONS');
  const closing = await titleIn(office0555.kpmId, TRAINING_SEED_LINK.moduleCode);
  const retention = await titleIn(office0555.kpmId, archived);
  const draft = await titleIn(office0555.kpmId, draftModule.code);
  const guide = `
  TRAINING at /training, /coaching/me/training and a coachee's Training tab  (trainingProgress, from
           src/seed/training-fixture.ts; a status is the member's own word, set on the module's page)
    rina@kpm0417.test            Sales: 4 Done, "${discovery}" In progress;
                                 Closing's link already Opened. Mark Discovery Done: (4/10) -> (5/10)
    sari@kpm0417.test            Rina's Training tab reads what Rina sees; one recorded read, surface training
    agus@kpm0417.test            all ten Done (10/10); Indah 5 done + 2 in progress, Dimas 4 + 1
    arief@kpm0417.test           Novi nothing started (0/10); Wahyu 2 done
    siti@kpm0417.test            ten done          budi@  one In progress     dewi@  three done
    removed@kpm0417.test         Yanti: three done on her first membership, (0/10) on the current one
    agent@kpm0555.test           Lina: /activation item 9 Auto, "Go to ${closing} ->";
                                 mark it Done and the item ticks. "${retention}" was
                                 archived after she did it: gone from /training, Archived on her person
                                 tab, outside Sales (1/9). "${draft}" in Product is a draft
    owner@kpm0555.test           Hendra: Settings > Activation checklist, item 9 Auto
    owner@kpm0701.test           Hadi: the field view's /training is the empty state
    The company's material      ${files === 'stored' ? 'a PDF on every Sales module, by reference, and Closing\'s link' : `the link on Closing only; the PDFs were ${files}`}
    rina@kpm0417.test            ${files === 'stored' ? `/training/SALES/${TRAINING_SEED_LESSON.moduleCode}: an HTML lesson first, opened inside the sandboxed frame` : `no HTML lesson: ${files}`}
    superadmin@agencyboost.test  /admin/companies/{Prudential} > Prudential template > Training: the material on
                                 ${templateMaterial.modules.length || 'its'} module(s)${templateMaterial.version ? ` (version ${templateMaterial.version})` : ''}; "Dipakai N KPM" lists 0417 as
                                 Belum diubah KPM and 0555 as Sudah diubah KPM. A KPM made from it at /admin/tenants/new
                                 shows the material with nothing uploaded
${checklist ? `    0555's checklist             ${checklist}\n` : ''}`;
  return { written, sent, files, checklist, templateMaterial, guide };
}
