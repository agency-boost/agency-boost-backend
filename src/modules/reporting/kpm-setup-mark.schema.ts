import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { baseSchemaOptions } from '@/common/schema/base.schema';

export type KpmSetupMarkDocument = HydratedDocument<KpmSetupMark>;

/**
 * **The four settings pages the KPM setup card asks the Owner to look at** (P19.3-T2 AC-5; UI-149, Overview R2): steps 1 to
 * 4 of *Siapkan KPM*, in the card's order, each the path segment of its page under `/kpm/settings/` and of
 * `PUT /kpm/settings/:page/reviewed` (the route registry, fixed at P19.3-T0).
 */
export const REVIEWED_PAGES = ['branch-info', 'activity-types', 'activation-checklist', 'products'] as const;
export type ReviewedPage = (typeof REVIEWED_PAGES)[number];

/**
 * **What a mark records**: one of the four pages reviewed (*Sudah sesuai*) or saved, or **`setup-complete`** — the card's
 * *"all seven done"*, stored once so the card never comes back (P19.3-T2, *Backend*), whatever later happens to a
 * derived step (the last member leaving, say).
 */
export const SETUP_MARKS = [...REVIEWED_PAGES, 'setup-complete'] as const;
export type SetupMark = (typeof SETUP_MARKS)[number];

/**
 * How a mark came to be: **`reviewed`**, the Owner or an Admin tapped *Sudah sesuai*; **`saved`**, they saved the page;
 * **`derived`**, the Overview found all seven steps done (`setup-complete` only); **`migration`**, an office already
 * running when the card arrived (`0052-kpm-setup-running-offices`).
 */
export const SETUP_MARK_VIAS = ['reviewed', 'saved', 'derived', 'migration'] as const;
export type SetupMarkVia = (typeof SETUP_MARK_VIAS)[number];

/**
 * **A KPM's setup marks** (P19.3-T2; ADR-0204's phase, the glossary's *Reviewed* and *KPM setup card*): the *"reviewed"
 * flag per settings page per KPM, set on save or *Sudah sesuai*, that Appendix D of the UI report asks for (UI-149), and
 * the card's completion.
 *
 * - **One row per office and mark**, `kpmId` leading its index (invariant §1). The first write wins: a later save or a
 *   second tap finds the row and changes nothing, so `at` and `via` say when and how the step first ticked.
 * - **Never the page's data**: a mark is beside the settings, never in them. *Sudah sesuai* leaves the checklist's
 *   version as it was (AC-5).
 * - **Soft-deleted, never removed** (invariant §6). Nothing in the product deletes one; an erasure would.
 * - **Audited** when *Sudah sesuai* sets one (`kpm_setup.page_reviewed`). A save's mark is the save's own audit entry's
 *   companion and writes none of its own.
 */
@Schema({ ...baseSchemaOptions, collection: 'kpmSetupMarks' })
export class KpmSetupMark {
  @Prop({ type: String, required: true, index: true })
  kpmId!: string;

  @Prop({ type: String, required: true, enum: SETUP_MARKS })
  mark!: SetupMark;

  @Prop({ type: String, required: true, enum: SETUP_MARK_VIAS })
  via!: SetupMarkVia;

  /** When the mark was first set, from the clock port. */
  @Prop({ type: Date, required: true })
  at!: Date;

  /** The membership that set it — never a user id or a name (invariant §2); `null` for a derived or migrated mark. */
  @Prop({ type: String, default: null })
  by!: string | null;

  @Prop({ type: Date, default: null, index: true })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  createdBy!: string | null;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;
}

export const KpmSetupMarkSchema = SchemaFactory.createForClass(KpmSetupMark);

/** One live mark per office and mark: the first write wins, and a race's second insert is refused and retried. */
KpmSetupMarkSchema.index(
  { kpmId: 1, mark: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
