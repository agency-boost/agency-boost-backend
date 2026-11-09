import mongoose from 'mongoose';
import { MOTIVATION_CATEGORY } from '@/domain/constants/training-taxonomy';
import { TEMPLATE_LIBRARY } from '@/modules/tenants/template-library';

/** A category as a `training_taxonomy` template's payload holds it. */
interface Held {
  code?: unknown;
}

/**
 * Where *Motivation* goes in a template's categories: **after *Team Management***, as the seed has it (UI-063's order,
 * *… Team Management · Motivation · Soft Skills …*); before *Soft Skills* where the template no longer holds Team
 * Management; at the end where it holds neither.
 */
function placeIn(categories: readonly Held[]): number {
  const after = categories.findIndex((c) => c?.code === 'TEAM_MANAGEMENT');
  if (after >= 0) return after + 1;
  const before = categories.findIndex((c) => c?.code === 'SOFT_SKILLS');
  return before >= 0 ? before : categories.length;
}

/**
 * **The owner's seventh training category in the platform's Default template** (Phase 18.11 T10; the UI V1 report's
 * UI-063, *Motivation, new, owner 30 Oct 2026*). The seed has carried `MOTIVATION_CATEGORY` since this phase, so a fresh
 * install's `0037` writes the Template company's *Default template* with it; this gives it to a Default template made
 * before:
 *
 * - **only the Template company's Default template** (`TEMPLATE_LIBRARY`'s fixed ids), its `training_taxonomy` kind,
 *   **every version, draft and published**, as `0046` rewrote it — `{ code, label, description }`, the seed's words,
 *   placed after *Team Management*;
 * - **only where it holds no category coded `MOTIVATION`** — one the Super Admin added keeps their words and place;
 * - **never an office's own taxonomy, its snapshots, an insurer's template, or a template saved from an office** (ADR-0018,
 *   ADR-0164: a template reaches the offices made from it afterwards and never reaches back). An office made before adds
 *   *Motivasi* in Settings › Training if it wants it; the category is empty either way, and a category with no published
 *   module is not offered to a field member (ADR-0176 §9).
 *
 * **No version moves**, so no office reads as built from another version. **Idempotent**: the write is guarded on the
 * code being absent, and a second run finds it present (`current`). Prints `{ templates, current }`.
 */
export async function up(db: mongoose.mongo.Db): Promise<{ templates: number; current: number }> {
  const { code, label, description } = MOTIVATION_CATEGORY;
  const row = { code, label, description };
  const templates = db.collection('companyTemplates');
  let written = 0;
  let current = 0;

  for (const template of await templates.find({
    companyId: TEMPLATE_LIBRARY.companyId,
    templateId: TEMPLATE_LIBRARY.defaultTemplateId,
    kind: 'training_taxonomy',
    deletedAt: null,
  }).toArray()) {
    const categories = (template.payload as { categories?: unknown } | undefined)?.categories;
    if (!Array.isArray(categories)) continue;
    if (categories.some((c: Held) => c?.code === code)) {
      current += 1;
      continue;
    }
    const result = await templates.updateOne(
      { _id: template._id, 'payload.categories.code': { $ne: code } },
      // The driver's types read a dotted path into a payload it does not know as `undefined`; the update is plain `$push`.
      { $push: { 'payload.categories': { $each: [row], $position: placeIn(categories as Held[]) } } } as unknown as mongoose.mongo.UpdateFilter<mongoose.mongo.Document>,
    );
    written += result.modifiedCount;
  }

  return { templates: written, current };
}
