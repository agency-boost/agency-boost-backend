import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { configSchemaOptions } from '@/common/schema/base.schema';

export type KpmBrandingDocument = HydratedDocument<KpmBranding>;

/** The wide logo the KPM set: the folder of its sizes (`…/branding/<ulid>`), and the kept PNG's pixel size. */
export interface BrandingLogo {
  key: string;
  width: number;
  height: number;
}

/** The square logo: the folder of its 512 px PNG and its icons. */
export interface BrandingSquare {
  key: string;
}

/** The mascot: the folder of each pose's three WebP widths, the default required. */
/** One colour's words as measured on save. `fill` is absent on a row saved before 2026-11-11, where it is the colour. */
export interface BrandingContrast {
  side: 'light' | 'dark';
  ratio: number;
  fill?: string;
}

export interface BrandingMascot {
  default: string;
  poses: Partial<Record<'thinking' | 'celebrating' | 'pointing' | 'phone', string>>;
}

/**
 * **A KPM's own branding — *Tampilan KPM*** (P19.6-T1; ADR-0218 §1, §2, §5, §12; `erd.md`, *kpmBranding*).
 *
 * One live row per KPM at most. Three groups, each saved whole and each `null` when the KPM takes its template's or
 * AgencyBoost's: the logos (wide, with an optional square), the colours (both, with each one's contrast side and ratio
 * as measured on save), and the mascot (default, with optional poses). The images are folders of sizes made at confirm
 * (`branding-images.ts`); an original is never named here and never served.
 *
 * - **`kpmId` leads every index**; every read and write goes through `KpmBrandingRepository` (invariant §1).
 * - ***Kembalikan ke default*** soft-deletes the row (`deletedAt`; invariant §6); the next *Simpan* writes a new one.
 * - `version` is the domain's number, pinned by every write (`expectedVersion`, `409 VERSION_CONFLICT`). Starts at 1.
 */
@Schema({ ...configSchemaOptions, collection: 'kpmBranding' })
export class KpmBranding {
  @Prop({ type: String, required: true })
  kpmId!: string;

  @Prop({ type: Object, default: null })
  logo!: BrandingLogo | null;

  @Prop({ type: Object, default: null })
  logoSquare!: BrandingSquare | null;

  /** *Warna utama*, `#rrggbb` lower-cased; `null` with `secondary` when the KPM takes another's colours. */
  @Prop({ type: String, default: null })
  primary!: string | null;

  @Prop({ type: String, default: null })
  secondary!: string | null;

  /**
   * The words on each colour as measured on save: `light` (white) or `dark`, the ratio (acceptance 2), and the `fill`
   * they read on — the colour itself, or its nearest readable shade (P19.12-T3; ADR-0246 §3). For the audit; the
   * palette is derived again on read. A row saved before 2026-11-11 has no `fill`: it is the colour.
   */
  @Prop({ type: Object, default: null })
  contrast!: { primary: BrandingContrast; secondary: BrandingContrast } | null;

  @Prop({ type: Object, default: null })
  mascot!: BrandingMascot | null;

  @Prop({ type: Number, required: true, default: 1 })
  version!: number;

  @Prop({ type: String, default: null })
  updatedBy!: string | null;

  @Prop({ type: Date, default: null })
  deletedAt!: Date | null;

  @Prop({ type: String, default: null })
  deletedBy!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const KpmBrandingSchema = SchemaFactory.createForClass(KpmBranding);

/** The one read: a KPM's live row. */
KpmBrandingSchema.index({ kpmId: 1, deletedAt: 1 });
