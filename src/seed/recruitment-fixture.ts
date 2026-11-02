import mongoose from 'mongoose';
import type { ConfigService } from '@nestjs/config';
import type { Clock } from '@/common/clock/clock.port';
import { RECRUITMENT, RECRUITMENT_PITCH_SLOTS, type RecruitmentPitchSlotCode } from '@/domain/constants';
import { up as recruitmentPlaybook, type RecruitmentPlaybookResult } from '@/migrations/0025-recruitment-playbook';
import { Asset, AssetSchema } from '@/modules/assets/asset.schema';
import { GcsAdapter, storageRefusal } from '@/modules/assets/gcs.adapter';
import { StoragePort } from '@/modules/assets/storage.port';
import { AuditLog, AuditLogSchema } from '@/modules/audit/audit-log.schema';
import { KpmProductConfig, KpmProductConfigSchema } from '@/modules/products/kpm-product-config.schema';
import { Product, ProductSchema } from '@/modules/products/product.schema';
import { RecruitmentPitchSlot, RecruitmentPitchSlotSchema } from '@/modules/recruitment/recruitment-pitch.schema';
import { RecruitmentPlaybook, RecruitmentPlaybookSchema } from '@/modules/recruitment/recruitment-playbook.schema';
import { defaultPlaybookBody } from '@/modules/recruitment/recruitment-playbook-defaults';
import { seedObjectId } from './coaching-fixture';

/**
 * **Recruitment tools, seeded** (Phase 17, *Seed*; P17-T7 AC-1, P17-T9 AC-4, D-seed;
 * `functional/recruitment.md`, *Seed*). Which account shows what — field accounts on `"demo password field"`:
 *
 * | What | Its state | Who to sign in as, and what they see |
 * |---|---|---|
 * | **Prudential's playbook** | the AgencyBoost words — the prototype's, verbatim — version 1, as a company started from the defaults is given them | `rina@kpm0417.test` (Agent), `sari@` (AAB), `agus@` (AB) at `/recruitment/attack-plan`: the four briefs below; `superadmin@agencyboost.test` at `/admin/companies` → *Prudential* → *Template* → *Recruitment*: the words, to edit |
 * | **Allianz Life's playbook** | the same words, version 1; Allianz has no office | the Super Admin's *Recruitment* tab for Allianz Life. The cross-company test rewords one in a fixture, not here |
 * | **Sejahtera Baru Life** (`template-fixture.ts`, created blank) | **no playbook** | `owner@kpm0701.test` (Hadi Gunawan) and `agent@kpm0701.test` (Nadia Putri): the playbook-empty state on *Attack Plan*; the Super Admin's tab: *Start from the AgencyBoost words* or *Start from nothing* |
 * | **0417 BSD City's pitch** — the prototype's own (`:626-661`), and one optional document (P18.97-T5 AC-5) | *Opportunity Overview*: `Opportunity_Overview_v3.pdf`, *Career Path Ladder* ticked by the Owner and *Support provided* by the Admin — *Uploaded · needs confirmation*; *Proof & Credibility*: `Proof_and_Credibility_2026.pdf`, *Uploaded*; *FAQ* and *How to Join* *Missing*; ***Company Profile***: `Company_Profile_2026.pdf`, *Uploaded*; ***Agency Profile*** empty, *Not uploaded yet* — both tagged *Optional* | `owner@kpm0417.test` and `admin@kpm0417.test` (Maya Halim) at `/kpm/settings/recruitment-pitch`: the ring *1/4*, *"Recruitment Pitch is incomplete"*, *"2 missing, 1 needs checking."* — the optional two counted in neither; *Replace* clears the two ticks. Rina, Sari and Agus at `/recruitment/pitch-materials`: the same six cards, read-only — *View PDF* on the three uploaded, every file *< 1 KB* (the one-page demonstration PDFs) |
 * | **0555 Kelapa Gading's pitch** | all four uploaded, *Opportunity Overview*'s four items ticked by its Owner; ***Company Profile*** and ***Agency Profile*** both uploaded (P18.97-T5 AC-5) | `owner@kpm0555.test`, `agent@kpm0555.test`: *4/4*, *"Recruitment Pitch is complete"*, six uploaded cards |
 * | **0701 Cempaka Putih** | no pitch document | Hadi and Nadia: *0/4*, *"4 missing."*; the two optional cards *Not uploaded yet*, never *Missing* |
 * | **0417's own PRUMapan brochure** (P17-T9) | `Brosur_PRUMapan_BSD.pdf` in *PRUMapan*'s *Brochure* slot, the office's own file | `rina@kpm0417.test` at `/product-catalog/PRUMAPAN` → *Documents*: the brochure opens; the Owner at `/kpm/settings/products`: the row reads as the office's, with *Replace* and *Use Prudential's* |
 *
 * **The briefs the walk uses**, each computed over the seed's words (`recruitment-plan.spec.ts` pins them):
 *
 * | Brief (`/recruitment/attack-plan?…`) | What the plan shows |
 * |---|---|
 * | *Business owner* · *Side income* · *Already has a stable job* (`type=business-owner&motivation=side-income&hesitation=stable-job`) | one opening, untagged; the business owner's own objection, *"I already have my own thing running — why add this?"* (`:497`) |
 * | *Retiree* · *Flexibility*, *Lead a team* · *No network*, *Worried about time commitment* (`type=retiree&motivation=flexibility,leadership&hesitation=no-network,time`) | *Opening lines*, two tags in the chips' order; the base *no network* objection, and the retiree's own *time* one (`:501`) |
 * | *Fresh grad*, every motivation, every hesitation | four openings, five objections, the summary's *Type* reading *Fresh graduate* |
 * | *Agent (other insurer)* · *Career change* · *Already has a stable job* | the other insurer's own reply (`:505`) |
 *
 * **The files are real, and only where storage is** (D-seed). Each is a one-page PDF this file writes, naming
 * its slot and saying it is a demonstration, stored **through the real storage adapter** in the office's own
 * folder (`StoragePort.putObject`) under a key named for it — so a key storage already holds is registered, not
 * sent again — and registered as the office's confirmed asset, referenced once. **Where storage is not
 * configured, or refuses, the pitch documents and the brochure are skipped and the run says so: no slot is
 * ever written without its file.** The playbooks need no storage and are always written.
 *
 * **Written once, until `--reset`.** Every `_id` is derived (`seedObjectId`); a playbook is written only for a
 * company with none, a slot only where the office holds nothing in it — one replaced in a walk is the walk's —
 * and the brochure only where nobody has set or given back 0417's *Brochure* (its audit rows are the marker,
 * as `sales-tools-fixture.ts`'s are). Each write leaves the audit row its service would have. **Migration
 * `0025-recruitment-playbook` runs here**, as a deployed database meets it: on a fresh seed it finds both
 * companies already given their words, and Sejahtera Baru Life blank.
 */

const RECOMPILE = { overwriteModels: true } as const;
const DAY_MS = 86_400_000;

/** One office's pitch, as the seed fills it: a file per slot it fills, and the items ticked on it. */
interface SeededSlot {
  slot: RecruitmentPitchSlotCode;
  fileName: string;
  /** Days before the run it was uploaded — a few weeks, as the prototype's dates are. */
  uploadedDaysAgo: number;
  /** Ticked items, each by whom — `owner` or `admin` of the office. */
  ticks: { item: string; by: 'owner' | 'admin' }[];
}

/**
 * What each office's pitch holds (*Seed*): 0417 the prototype's and its *Company Profile*, its *Agency Profile*
 * left empty; 0555 complete, with both optional documents; 0701 nothing (P18.97-T5 AC-5, ADR-0177 §2).
 */
export const RECRUITMENT_SEED_PITCH: Readonly<Record<'0417' | '0555', readonly SeededSlot[]>> = {
  '0417': [
    {
      slot: 'opportunity', fileName: 'Opportunity_Overview_v3.pdf', uploadedDaysAgo: 27,
      ticks: [{ item: 'career-path', by: 'owner' }, { item: 'support', by: 'admin' }],
    },
    { slot: 'proof', fileName: 'Proof_and_Credibility_2026.pdf', uploadedDaysAgo: 40, ticks: [] },
    { slot: 'company', fileName: 'Company_Profile_2026.pdf', uploadedDaysAgo: 33, ticks: [] },
  ],
  '0555': [
    {
      slot: 'opportunity', fileName: 'Kelapa_Gading_Opportunity_Overview.pdf', uploadedDaysAgo: 20,
      ticks: ['career-path', 'income', 'support', 'commitment'].map((item) => ({ item, by: 'owner' as const })),
    },
    { slot: 'proof', fileName: 'Kelapa_Gading_Proof_and_Credibility.pdf', uploadedDaysAgo: 20, ticks: [] },
    { slot: 'faq', fileName: 'Kelapa_Gading_FAQ.pdf', uploadedDaysAgo: 19, ticks: [] },
    { slot: 'howtojoin', fileName: 'Kelapa_Gading_How_to_Join.pdf', uploadedDaysAgo: 19, ticks: [] },
    { slot: 'company', fileName: 'Kelapa_Gading_Company_Profile.pdf', uploadedDaysAgo: 18, ticks: [] },
    { slot: 'agency', fileName: 'Kelapa_Gading_Agency_Profile.pdf', uploadedDaysAgo: 18, ticks: [] },
  ],
};

/** 0417's own product document (P17-T9): PRUMapan's brochure. */
export const RECRUITMENT_SEED_BROCHURE = {
  code: 'PRUMAPAN', slot: 'brochure', fileName: 'Brosur_PRUMapan_BSD.pdf', uploadedDaysAgo: 12,
} as const;

/** Storage refused a file: the one failure that skips the files rather than failing the run. */
class StorageRefused extends Error {}

/** A playbook's derived id. */
export const recruitmentPlaybookId = (companyId: string) => seedObjectId('recruitment-fixture', 'playbook', companyId);
/** A pitch slot's derived id, by office code and slot. */
export const recruitmentPitchId = (code: string, slot: string) => seedObjectId('recruitment-fixture', 'pitch', code, slot);

/**
 * **A minimal, valid one-page PDF** (D-seed): Helvetica, one line per entry, the cross-reference table's
 * offsets computed from the bytes themselves. ASCII only — a PDF string's standard encoding — with `(`, `)`
 * and `\` escaped.
 */
export function demonstrationPdf(lines: readonly string[]): Buffer {
  const escape = (text: string) => text.replace(/[^\x20-\x7e]/g, '-').replace(/([\\()])/g, '\\$1');
  const text = lines.map((line, i) => `BT /F1 ${i === 0 ? 20 : 12} Tf 72 ${720 - i * 28} Td (${escape(line)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(text, 'latin1')} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * **The storage the seed writes through, where one is configured** (D-seed; P18.7-T2, ADR-0153) — detected
 * the way the API detects it: a `GCS_BUCKET` that names a bucket, the key prefix defaulting to `dev` as
 * `env.validation.ts` defaults it, and `GCS_PROJECT_ID` only if set. `null` otherwise — the API's
 * `UnconfiguredStorage` case — and the run says so. Credentials are Application Default Credentials, as the
 * API's are. Reads the process's environment, which the command loaded; nothing here opens a file.
 */
export function storageFromEnvironment(env: NodeJS.ProcessEnv, clock: Clock): StoragePort | null {
  const bucket = env.GCS_BUCKET?.trim();
  if (!bucket) return null;
  const projectId = env.GCS_PROJECT_ID?.trim();
  const values: Record<string, string> = {
    GCS_BUCKET: bucket,
    STORAGE_KEY_PREFIX: env.STORAGE_KEY_PREFIX?.trim() || 'dev',
    ...(projectId ? { GCS_PROJECT_ID: projectId } : {}),
  };
  // Only what the adapter asks for, from the environment given — not a whole `ConfigService`, which would
  // read `process.env` whatever it was handed.
  const config = {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`${key} is not set.`);
      return values[key];
    },
  } as unknown as ConfigService;
  return new GcsAdapter(config, clock);
}

export interface RecruitmentFixtureDeps {
  clock: Clock;
  /** The storage to write the files through; `null` or absent — not configured — skips them. */
  storage?: StoragePort | null;
  /** Prudential and Allianz Life, given the AgencyBoost words. */
  companies: { prudential: string; allianz: string };
  /** The two offices whose pitch is seeded, each with the people who upload and tick there. */
  offices: Record<'0417' | '0555', {
    kpmId: string;
    owner: { membershipId: string; userId: string };
    admin: { membershipId: string; userId: string } | null;
  }>;
}

export interface RecruitmentFixture {
  /** Playbooks, pitch slots and the brochure this run wrote — 0 on a re-run. */
  written: number;
  /** Files this run sent to storage — 0 on a re-run, and when storage already held them. */
  sent: number;
  /** Whether the files were stored, or why not. */
  files: 'stored' | 'skipped: storage is not configured' | `skipped: storage refused (${string})`;
  /** What migration `0025` did on this run: nothing on a fresh seed. */
  migration: RecruitmentPlaybookResult;
  guide: string;
}

export async function seedRecruitmentFixture(deps: RecruitmentFixtureDeps): Promise<RecruitmentFixture> {
  const Playbooks = mongoose.model(RecruitmentPlaybook.name, RecruitmentPlaybookSchema, undefined, RECOMPILE);
  const Slots = mongoose.model(RecruitmentPitchSlot.name, RecruitmentPitchSlotSchema, undefined, RECOMPILE);
  const Assets = mongoose.model(Asset.name, AssetSchema, undefined, RECOMPILE);
  const Audit = mongoose.model(AuditLog.name, AuditLogSchema, undefined, RECOMPILE);
  const Products = mongoose.model(Product.name, ProductSchema, undefined, RECOMPILE);
  const Configs = mongoose.model(KpmProductConfig.name, KpmProductConfigSchema, undefined, RECOMPILE);
  const now = deps.clock.now();
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
  let written = 0;
  let sent = 0;

  // ------------------------------------------------ the playbooks: the AgencyBoost words, version 1

  for (const companyId of [deps.companies.prudential, deps.companies.allianz]) {
    if (await Playbooks.exists({ companyId, deletedAt: null })) continue;
    await Playbooks.create({
      _id: recruitmentPlaybookId(companyId), companyId, body: defaultPlaybookBody(), version: 1,
      updatedBy: null, createdBy: null, deletedAt: null,
    });
    written += 1;
  }
  // As a deployed database meets it: on a fresh seed, both companies are current and the blank one blank.
  const migration = await recruitmentPlaybook(mongoose.connection.db!, now);

  // ------------------------------------------------ the files, only where storage is

  /**
   * One file into an office's own folder, registered as its confirmed asset (ADR-0032, ADR-0040), or
   * `null` when it could not be stored — and then nothing that would name it is written.
   */
  const store = async (
    kpmId: string, folder: string, name: string, fileName: string, lines: string[],
    by: { membershipId: string }, at: Date,
  ) => {
    const stored = await deps.storage!.putObject({
      owner: { kind: 'kpm', kpmId }, folder, name, mimeType: 'application/pdf', body: demonstrationPdf(lines),
    }).catch((err: unknown) => {
      // The vendor's message alone — never the whole object, which can carry the request's credentials.
      throw new StorageRefused(storageRefusal(err).message);
    });
    if (stored.sent) sent += 1;
    if (!(await Assets.exists({ storageKey: stored.storageKey }))) {
      await Assets.create({
        kpmId, companyId: null, storageKey: stored.storageKey, mimeType: stored.mimeType, bytes: stored.bytes,
        originalFilename: fileName, uploadedByMembershipId: by.membershipId, refCount: 1, uploadState: 'confirmed',
        deletedAt: null, createdAt: at, updatedAt: at,
      });
    }
    return stored;
  };

  let files: RecruitmentFixture['files'] = 'stored';
  if (!deps.storage) {
    files = 'skipped: storage is not configured';
  } else {
    try {
      for (const code of ['0417', '0555'] as const) {
        const office = deps.offices[code];
        for (const seeded of RECRUITMENT_SEED_PITCH[code]) {
          // A slot the office holds anything in — this run's, an earlier one's, or one replaced in a walk.
          if (await Slots.exists({ kpmId: office.kpmId, slot: seeded.slot, deletedAt: null })) continue;
          const definition = RECRUITMENT_PITCH_SLOTS.find((s) => s.code === seeded.slot)!;
          const uploadedAt = daysAgo(seeded.uploadedDaysAgo);
          const stored = await store(
            office.kpmId, RECRUITMENT.PITCH_UPLOAD_FOLDER, `${seeded.slot}-demonstration`, seeded.fileName,
            ['AgencyBoost - dokumen demonstrasi', definition.title, seeded.fileName,
              'PDF satu halaman yang ditulis seed demo, agar slot ini bisa dibuka.', 'Ini bukan dokumen pitch sungguhan.'],
            office.owner, uploadedAt,
          );
          const confirmations = seeded.ticks.map((t, i) => ({
            item: t.item,
            byMembershipId: (t.by === 'admin' && office.admin ? office.admin : office.owner).membershipId,
            at: new Date(uploadedAt.getTime() + (i + 1) * 3_600_000),
          }));
          const _id = recruitmentPitchId(code, seeded.slot);
          await Slots.create({
            _id, kpmId: office.kpmId, slot: seeded.slot, storageKey: stored.storageKey, fileName: seeded.fileName,
            mimeType: stored.mimeType, bytes: stored.bytes, uploadedAt, uploadedByMembershipId: office.owner.membershipId,
            confirmations, version: 1, deletedAt: null, createdBy: office.owner.membershipId, updatedBy: office.owner.membershipId,
          });
          // The audit rows the office's service would have written: the attach, then each tick.
          await Audit.create({
            kpmId: office.kpmId, actorUserId: office.owner.userId, actorMembershipId: office.owner.membershipId,
            action: 'recruitment_pitch.attached', targetCollection: 'kpmRecruitmentPitchDocuments', targetId: _id,
            before: null,
            after: {
              slot: seeded.slot, storageKey: stored.storageKey, fileName: seeded.fileName, bytes: stored.bytes,
              version: 1, clearedItems: [],
            },
            createdAt: uploadedAt, updatedAt: uploadedAt,
          });
          for (const c of confirmations) {
            const actor = c.byMembershipId === office.admin?.membershipId ? office.admin : office.owner;
            await Audit.create({
              kpmId: office.kpmId, actorUserId: actor.userId, actorMembershipId: actor.membershipId,
              action: 'recruitment_pitch.ticked', targetCollection: 'kpmRecruitmentPitchDocuments', targetId: _id,
              after: { slot: seeded.slot, item: c.item, ticked: true, version: 1, at: c.at.toISOString() },
              createdAt: c.at, updatedAt: c.at,
            });
          }
          written += 1;
        }
      }

      // P17-T9: 0417's own PRUMapan brochure, where nobody has set or given back that slot.
      const office = deps.offices['0417'];
      const brochure = RECRUITMENT_SEED_BROCHURE;
      const product = await Products.findOne({ companyId: deps.companies.prudential, code: brochure.code, deletedAt: null })
        .select('_id').lean().exec();
      const row = product
        ? await Configs.findOne({ kpmId: office.kpmId, productId: String(product._id), deletedAt: null }).exec()
        : null;
      const decided = row && await Audit.exists({
        kpmId: office.kpmId, targetCollection: 'kpmProductConfigs', targetId: String(row._id),
        action: { $in: ['kpm_product.document_set', 'kpm_product.document_reset'] }, 'after.slot': brochure.slot,
      });
      if (product && row && !decided && !row.documents?.get(brochure.slot)) {
        const uploadedAt = daysAgo(brochure.uploadedDaysAgo);
        const stored = await store(
          office.kpmId, 'products', `${brochure.code}-${brochure.slot}-demonstration`, brochure.fileName,
          ['AgencyBoost - dokumen demonstrasi', 'PRUMapan - Brosur', brochure.fileName,
            'PDF satu halaman yang ditulis seed demo, sebagai brosur milik kantor 0417 BSD City.', 'Ini bukan brosur Prudential.'],
          office.owner, uploadedAt,
        );
        await Configs.updateOne({ _id: row._id }, {
          $set: {
            // Labelled with its file's name, as a browser upload on the products page labels one.
            [`documents.${brochure.slot}`]: {
              storageKey: stored.storageKey, label: brochure.fileName, mimeType: stored.mimeType, bytes: stored.bytes,
            },
            updatedBy: office.owner.membershipId,
          },
          $inc: { version: 1 },
        }).exec();
        await Audit.create({
          kpmId: office.kpmId, actorUserId: office.owner.userId, actorMembershipId: office.owner.membershipId,
          action: 'kpm_product.document_set', targetCollection: 'kpmProductConfigs', targetId: String(row._id),
          after: { code: brochure.code, slot: brochure.slot }, createdAt: uploadedAt, updatedAt: uploadedAt,
        });
        written += 1;
      }
    } catch (err) {
      // Only storage's refusal skips the files; anything else — the database, a bug — fails the run as any
      // seed failure does. Nothing that names a file is written before its file is stored, so stopping here
      // leaves no slot pointing at nothing: what was stored before the refusal stands, and a re-run finishes.
      if (!(err instanceof StorageRefused)) throw err;
      files = `skipped: storage refused (${err.message})`;
    }
  }

  const fileLine = files === 'stored'
    ? 'stored through the configured storage, one-page demonstration PDFs'
    : `NOT seeded — ${files}. Upload them as 0417's Owner: the pitch at /kpm/settings/recruitment-pitch, `
      + 'PRUMapan\'s brochure at /kpm/settings/products';
  const guide = `
  RECRUITMENT at /recruitment/attack-plan and /recruitment/pitch-materials  (from src/seed/recruitment-fixture.ts;
             the office's side at /kpm/settings/recruitment-pitch, the playbook on the Super Admin's
             Company template → Recruitment)
    Pitch files                  ${fileLine}
    Playbooks                    Prudential and Allianz Life: the AgencyBoost words, version 1. Sejahtera Baru
                                 Life: none — 0701's agents meet the playbook-empty state
    KPM 0417 · BSD City          rina@ (Agent), sari@ (AAB), agus@ (AB): both tabs, the pitch read-only.
                                 Opportunity Overview "Uploaded · needs confirmation" (Career Path by the Owner,
                                 Support by the Admin, Maya Halim), Proof & Credibility uploaded, FAQ and How to
                                 Join missing: the ring 1/4. Company Profile uploaded and Agency Profile "Not
                                 uploaded yet", both Optional and counted in neither. owner@ / admin@ upload,
                                 replace and confirm at Settings → Recruitment pitch; Replace clears the ticks.
                                 PRUMapan's own brochure at /product-catalog/PRUMAPAN → Documents
    KPM 0555 · Kelapa Gading     owner@kpm0555.test, agent@kpm0555.test: all four, 4/4, complete, and both
                                 optional documents uploaded
    KPM 0701 · Cempaka Putih     owner@kpm0701.test (Hadi Gunawan), agent@kpm0701.test (Nadia Putri): 0/4 and
                                 no playbook
    Briefs to try                ?type=business-owner&motivation=side-income&hesitation=stable-job
                                 ?type=retiree&motivation=flexibility,leadership&hesitation=no-network,time
                                 ?type=fresh-grad&motivation=side-income,full-career,flexibility,leadership
                                   &hesitation=no-experience,stable-job,reputation,no-network,time
                                 ?type=other-insurer&motivation=full-career&hesitation=stable-job
`;

  return { written, sent, files, migration, guide };
}
