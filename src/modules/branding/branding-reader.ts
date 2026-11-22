import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, isValidObjectId } from 'mongoose';
import { RequestContext } from '@/common/context/request-context';
import { derivePalette, lessonColoursOf, normaliseHex, type BrandingPalette, type LessonColours } from '@/domain/branding/palette';
import { BRANDING, type MascotPose } from '@/domain/constants/branding';
import { AnalyticsConfigReader } from '@/modules/config/analytics-config.reader';
import { CompanyTemplate, CompanyTemplateDocument } from '@/modules/config/company-template.schema';
import { StoragePort } from '@/modules/assets/storage.port';
import { Kpm, KpmDocument, type KpmStartedFrom } from '@/modules/tenants/kpm.schema';
import { KpmBrandingRepository } from './kpm-branding.repository';
import type { BrandingLogo, BrandingMascot, BrandingSquare, KpmBranding } from './kpm-branding.schema';

/** One group's source: the KPM's own, its template's published *Tampilan*, or AgencyBoost's (`null`). */
export type BrandingSource = 'own' | 'template' | null;

/** **The fields of a branding**, the KPM's own or a template's: the shape `PUT` takes and a section's payload holds. */
export interface BrandingFields {
  logo: BrandingLogo | null;
  logoSquare: BrandingSquare | null;
  primary: string | null;
  secondary: string | null;
  mascot: BrandingMascot | null;
}

/**
 * **What a KPM shows now** (ADR-0218 §3): for each group, its own if it set one, else its template's published
 * *Tampilan*, else AgencyBoost's (`null`).
 */
export interface ShownBranding {
  kpmId: string;
  /** The KPM's name, as the sign-in page writes it: its branch name. */
  name: string;
  /** Changes whenever anything shown changes: a hash of it, so a cached file can be `immutable` (§4). */
  version: string;
  logo: BrandingLogo | null;
  logoSquare: BrandingSquare | null;
  /** The folder the icons are served from: the square logo's, else the wide logo's (§10). */
  iconsKey: string | null;
  primary: string | null;
  secondary: string | null;
  palette: BrandingPalette | null;
  mascot: BrandingMascot | null;
  source: { logos: BrandingSource; colours: BrandingSource; mascot: BrandingSource };
  /** ***Nama sistem*** (P19.21-T4; ADR-0274): the KPM's own, never a template's; `null` is *AgencyBoost*. */
  systemName: string | null;
}

/** **What the session carries** (§8): enough to paint before anything else is asked, and to build every image's address. */
export interface SessionBranding {
  kpmId: string;
  version: string;
  palette: BrandingPalette | null;
  logo: { width: number; height: number } | null;
  logoSquare: boolean;
  icons: boolean;
  /** The poses with a picture of their own; `default` first when there is a mascot at all. */
  mascotPoses: MascotPose[];
  /** A lesson's colours (ADR-0217 §5): `null` when the KPM shows no colours of its own or its template's. */
  lesson: LessonColours | null;
  /**
   * ***Nama sistem*** (P19.21-T4 AC-1; ADR-0274): what the app is called for this KPM's members, written in place of the
   * word *AgencyBoost*; `null` is the default, *AgencyBoost*.
   */
  systemName: string | null;
}

/**
 * **What the proposal's PDF draws of a KPM** (P19.7-T3; *redrawn 2026-11-12 by P19.14-T3, ADR-0256 §3, §5*): its name,
 * whether it shows any branding at all, its logo — **the square one, else the wide one** — and the two colours it
 * picked, as picked (the PDF derives its own shades from them; `null` where it shows none).
 */
export interface BrandingForPdf {
  /** The KPM's name, as the sign-in page writes it: its branch name. */
  name: string;
  /** A logo or a pair of colours — the KPM's own or its template's. Without either, the file is AgencyBoost's. */
  branded: boolean;
  logo: { png: Buffer; width: number; height: number } | null;
  primary: string | null;
  secondary: string | null;
}

/** AgencyBoost's, for the PDF without branding: the tokens' defaults (ADR-0218 §6). */
export const AGENCYBOOST_COLOURS = Object.freeze({
  primary: '#e8954a', primaryInk: '#a85e1b', secondary: '#1b2b4b', secondaryInk: '#1b2b4b',
});

const EMPTY: BrandingFields = { logo: null, logoSquare: null, primary: null, secondary: null, mascot: null };

/** A template section's payload, read defensively: anything malformed is nothing. */
export function fieldsOf(payload: unknown): BrandingFields {
  const p = (payload ?? {}) as Partial<Record<keyof BrandingFields, unknown>>;
  const logo = p.logo as BrandingLogo | null | undefined;
  const square = p.logoSquare as BrandingSquare | null | undefined;
  const mascot = p.mascot as BrandingMascot | null | undefined;
  const primary = normaliseHex(p.primary);
  const secondary = normaliseHex(p.secondary);
  return {
    logo: logo && typeof logo.key === 'string' ? { key: logo.key, width: Number(logo.width) || 0, height: Number(logo.height) || 0 } : null,
    logoSquare: square && typeof square.key === 'string' && logo ? { key: square.key } : null,
    primary: primary && secondary ? primary : null,
    secondary: primary && secondary ? secondary : null,
    mascot: mascot && typeof mascot.default === 'string' ? { default: mascot.default, poses: { ...(mascot.poses ?? {}) } } : null,
  };
}

/**
 * **The one reader of a KPM's branding** (P19.6-T1; ADR-0218 §3, §8, §9). The session, the public sign-in read, the
 * files route, the settings page, the proposal's PDF and the lessons all read what a KPM shows through this, so they
 * cannot disagree. A KPM is read by its id alone, through the tenant-scoped repository with a context naming it.
 */
@Injectable()
export class BrandingReader {
  constructor(
    private readonly rows: KpmBrandingRepository,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    @InjectModel(CompanyTemplate.name) private readonly sections: Model<CompanyTemplateDocument>,
    private readonly templates: AnalyticsConfigReader,
    private readonly storage: StoragePort,
  ) {}

  /** The KPM's own live row, as fields; `null` when it has none. */
  async ownOf(kpmId: string): Promise<{ fields: BrandingFields; version: number; id: string; systemName: string | null } | null> {
    const row = await this.rows.live(RequestContext.tenantRead(kpmId, 'kpm-branding'));
    if (!row) return null;
    return {
      fields: fieldsOf(row as unknown as KpmBranding),
      version: row.version,
      id: String(row._id),
      systemName: typeof row.systemName === 'string' && row.systemName.trim() ? row.systemName : null,
    };
  }

  /** The KPM's template's published *Tampilan*: its fields and version, and the company that owns its images. */
  async templateOf(kpm: { companyId?: string; startedFrom?: KpmStartedFrom | null }): Promise<{ fields: BrandingFields; version: number; companyId: string } | null> {
    if (!kpm.companyId) return null;
    const template = await this.templates.templateOf(kpm.companyId, kpm.startedFrom ?? null);
    if (!template) return null;
    const row = await this.sections
      .findOne({ companyId: kpm.companyId, templateId: template.id, kind: 'branding', status: 'published', deletedAt: null })
      .sort({ version: -1 }).lean().exec();
    if (!row) return null;
    return { fields: fieldsOf(row.payload), version: row.version, companyId: kpm.companyId };
  }

  /** **What the KPM shows now**; `null` for an id that names no live KPM. `liveOnly` refuses a suspended or archived one. */
  async shownFor(kpmId: string, liveOnly = false): Promise<ShownBranding | null> {
    const kpm = await this.kpmOf(kpmId);
    if (!kpm || (liveOnly && kpm.status !== 'active')) return null;
    const [own, template] = await Promise.all([this.ownOf(kpmId), this.templateOf(kpm)]);
    return resolve(kpmId, kpm.branchName ?? '', own?.fields ?? EMPTY, template?.fields ?? EMPTY, own?.systemName ?? null);
  }

  /** The KPM's register row, the fields this reads; `null` for an id that names no KPM. */
  async kpmOf(kpmId: string): Promise<{ companyId?: string; startedFrom?: KpmStartedFrom | null; branchName?: string; status?: string } | null> {
    if (!isValidObjectId(kpmId)) return null;
    return this.kpms
      .findOne({ _id: kpmId, deletedAt: null }, { companyId: 1, startedFrom: 1, branchName: 1, status: 1 })
      .lean().exec() as Promise<{ companyId?: string; startedFrom?: KpmStartedFrom | null; branchName?: string; status?: string } | null>;
  }

  /** **The session's branding** (§8): for the request's KPM; `null` with no KPM (the Super Admin's own view). */
  async forSession(ctx: RequestContext): Promise<SessionBranding | null> {
    if (!ctx.kpmId) return null;
    const shown = await this.shownFor(ctx.kpmId);
    return shown ? sessionOf(shown) : null;
  }

  /**
   * **The proposal's PDF** (P19.7-T3; *since 2026-11-12, P19.14-T3 AC-4, ADR-0256 §5*): the KPM's name; its logo's PNG
   * bytes read from storage — the square `logo-square.png` where it has one, the wide `logo.png` else, `null` when
   * neither reads; and the two colours it shows. A logo that cannot be read is left out, never a failed file.
   */
  async forPdf(kpmId: string): Promise<BrandingForPdf> {
    const shown = await this.shownFor(kpmId);
    if (!shown) return { name: '', branded: false, logo: null, primary: null, secondary: null };
    const read = (key: string) => this.storage.read(key, BRANDING.IMAGE_MAX_BYTES).catch(() => null);
    let logo: BrandingForPdf['logo'] = null;
    if (shown.logoSquare) {
      const png = await read(`${shown.logoSquare.key}/logo-square.png`);
      if (png && png.length > 0) logo = { png, width: BRANDING.SQUARE_MIN_PX, height: BRANDING.SQUARE_MIN_PX };
    }
    if (!logo && shown.logo) {
      const png = await read(`${shown.logo.key}/logo.png`);
      if (png && png.length > 0) logo = { png, width: shown.logo.width, height: shown.logo.height };
    }
    return {
      name: shown.name,
      branded: Boolean(shown.logo || shown.logoSquare || shown.palette),
      logo,
      primary: shown.palette ? shown.primary : null,
      secondary: shown.palette ? shown.secondary : null,
    };
  }
}

/** **The resolution by group** (§3): own, else the template's, else AgencyBoost's. */
export function resolve(
  kpmId: string, name: string, own: BrandingFields, template: BrandingFields, systemName: string | null = null,
): ShownBranding {
  const logos: BrandingSource = own.logo ? 'own' : template.logo ? 'template' : null;
  const colours: BrandingSource = own.primary ? 'own' : template.primary ? 'template' : null;
  const mascotSource: BrandingSource = own.mascot ? 'own' : template.mascot ? 'template' : null;
  const fromLogos = logos === 'own' ? own : logos === 'template' ? template : EMPTY;
  const fromColours = colours === 'own' ? own : colours === 'template' ? template : EMPTY;
  const mascot = mascotSource === 'own' ? own.mascot : mascotSource === 'template' ? template.mascot : null;
  // Every colour derives a palette (P19.12-T3; ADR-0246): a pair is shown whenever both are set.
  const palette = fromColours.primary && fromColours.secondary ? derivePalette(fromColours.primary, fromColours.secondary).palette : null;
  const shown = {
    logo: fromLogos.logo,
    logoSquare: fromLogos.logoSquare,
    iconsKey: fromLogos.logoSquare?.key ?? fromLogos.logo?.key ?? null,
    primary: palette ? fromColours.primary : null,
    secondary: palette ? fromColours.secondary : null,
    palette,
    mascot,
  };
  const version = createHash('sha1')
    .update(JSON.stringify({ l: shown.logo, s: shown.logoSquare, p: shown.primary, q: shown.secondary, m: shown.mascot }))
    .digest('hex').slice(0, BRANDING.VERSION_LENGTH);
  return {
    kpmId, name, version, ...shown, source: { logos, colours: palette ? colours : null, mascot: mascotSource }, systemName,
  };
}

/** The session's shape of what a KPM shows. */
export function sessionOf(shown: ShownBranding): SessionBranding {
  const poses: MascotPose[] = shown.mascot
    ? ['default', ...BRANDING.MASCOT_POSES.filter((p): p is Exclude<MascotPose, 'default'> => p !== 'default' && Boolean(shown.mascot!.poses[p]))]
    : [];
  return {
    kpmId: shown.kpmId,
    version: shown.version,
    palette: shown.palette,
    logo: shown.logo ? { width: shown.logo.width, height: shown.logo.height } : null,
    logoSquare: Boolean(shown.logoSquare),
    icons: Boolean(shown.iconsKey),
    mascotPoses: poses,
    lesson: lessonColoursOf(shown.palette),
    systemName: shown.systemName,
  };
}
