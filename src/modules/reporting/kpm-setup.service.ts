import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { NotFoundException } from '@/common/errors/domain.exception';
import { addDays, editableUntil, type LocalDate } from '@/common/time/local-day';
import { DEFAULT_TENANT_TIMEZONE, PRODUCTION } from '@/domain/constants';
import { ActivationTemplateRepository } from '@/modules/activation/activation.repository';
import { AuditService } from '@/modules/audit/audit.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { KpmProductConfigRepository } from '@/modules/products/kpm-product.repository';
import { DataUploadBatchRepository } from '@/modules/production/data-upload-batch.repository';
import { ProductionMonthRepository } from '@/modules/production/production-month.repository';
import { Kpm, KpmDocument } from '@/modules/tenants/kpm.schema';
import { KpmSetupMarkRepository } from './kpm-setup-mark.repository';
import { REVIEWED_PAGES, type ReviewedPage, type SetupMarkVia } from './kpm-setup-mark.schema';
import { shiftMonth } from './office-figures';

/**
 * **The seven steps of *Siapkan KPM*, in the card's order** (P19.3-T2 AC-4; UI-149, Overview R2): the four settings pages
 * first — *"the owner must set up the KPM, not only watch it"* — then *Impor anggota*, *Unggah produksi* and *Atur target
 * rekrutmen*.
 */
export const SETUP_STEPS = [...REVIEWED_PAGES, 'import', 'upload', 'recruit-target'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/** A month the office may still upload, and the last day it may (`editableUntil`, ADR-0050). */
export interface OpenMonth {
  month: string;
  closesOn: LocalDate;
}

/** `GET /kpm/overview`'s `setup` while any step is open; `null` once the card is gone for good. */
export interface SetupView {
  /** How many of the seven are done: *"n dari 7 selesai"*. */
  done: number;
  steps: { key: SetupStep; done: boolean }[];
  /** Step 1's meta: the office's address **and** contact phone are both filled (*"Alamat dan telepon belum diisi"*). */
  branchFilled: boolean;
  /** Step 5's meta: today's headcount (*"Baru 1 anggota: Anda"*). */
  members: number;
  /** Step 6: the month to upload — the earliest still open and not uploaded — with its closing day; `null` with none. */
  openMonth: OpenMonth | null;
  /** Step 7's meta: the target that stands for this month, or `null` (*"Target belum diatur"*). */
  target: number | null;
}

/** `GET /kpm/overview`'s `settings`: what waits for the Owner on the settings pages (UI-148, Appendix D). */
export interface SettingsWaiting {
  /** Products whose own script or description waits for approval (`reviewState: 'pending'`): *"2 produk menunggu Anda"*. */
  productsAwaiting: number;
  /** The version an unpublished activation checklist draft will be (*"Draf versi 2"*), or `null` with none saved. */
  checklistDraftVersion: number | null;
}

/** What the Overview already knows and hands in, so nothing is read twice. */
export interface SetupFacts {
  today: LocalDate;
  /** `YYYY-MM`, the office's calendar month. */
  month: string;
  timezone: string;
  /** Today's headcount (`OFFICE_HEADCOUNT`). */
  headcount: number;
  /** The recruitment target standing for this month, or `null`. */
  target: number | null;
  /** This year's months the office's file holds, sorted. */
  held: readonly string[];
}

/** What `read` answers: the card, what waits, and the months the year's production counts and waits on. */
export interface SetupReading {
  setup: SetupView | null;
  settings: SettingsWaiting;
  /** The first month *"this year"* counts: January, or the KPM's first month when it began this year (UI-150, R3). */
  from: string;
  /**
   * The months the year to date waits on **that are still open for upload** (UI-150, Overview R3): from `from` to this
   * month, after the latest month held, each still open (ADR-0050), each with its closing day.
   */
  missing: OpenMonth[];
}

/** What `PUT /kpm/settings/:page/reviewed` answers. */
export interface ReviewedView {
  page: ReviewedPage;
  reviewed: true;
  /** When the page's step first ticked — this tap, an earlier one or a save. */
  at: string;
  via: SetupMarkVia;
}

/** Every month from `from` to `to`, inclusive, both `YYYY-MM`. */
export function monthsFrom(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to; m = shiftMonth(m, 1)) out.push(m);
  return out;
}

/**
 * **A new KPM's setup card, and what waits on the settings pages** (P19.3-T2; UI-148, UI-149, UI-150 and their Appendix D
 * rows; Overview R1b, R2, R3).
 *
 * - **Steps 1 to 4 are marks** (`kpmSetupMarks`): set when the Owner or an Admin saves that page
 *   (`SetupStepSavedInterceptor`) or taps *Sudah sesuai* on it (`markReviewed`). The tap changes nothing else: the
 *   checklist keeps its version.
 * - **Steps 5 to 7 are derived** from data that already exists, and nothing stores them: a member besides the Owner, any
 *   committed production upload (or a month the file holds), a recruitment target standing.
 * - **All seven done is stored once** (`setup-complete`), so the card never comes back.
 * - **"This year" starts with the KPM** (Overview R3): months before its first are never missing, and only months still
 *   open for upload are named — what Data upload offers.
 *
 * Every read and write goes through a tenant-scoped repository; the office row is read by the caller's own `kpmId`.
 * A fixed number of queries whatever the office's size.
 */
@Injectable()
export class KpmSetup {
  private readonly logger = new Logger(KpmSetup.name);

  constructor(
    private readonly marks: KpmSetupMarkRepository,
    @InjectModel(Kpm.name) private readonly kpms: Model<KpmDocument>,
    private readonly memberships: MembershipRepository,
    private readonly batches: DataUploadBatchRepository,
    private readonly productionMonths: ProductionMonthRepository,
    private readonly products: KpmProductConfigRepository,
    private readonly checklists: ActivationTemplateRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** A page the card knows, or **404**: any other segment names nothing this route marks. */
  static requirePage(page: string): ReviewedPage {
    if (!(REVIEWED_PAGES as readonly string[]).includes(page)) throw new NotFoundException('Settings page');
    return page as ReviewedPage;
  }

  /**
   * ***Sudah sesuai*** (P19.3-T2 AC-5; UI-149): the page's step ticks, and **nothing of the page changes**. The first
   * mark is audited (`kpm_setup.page_reviewed`); a page already marked — by an earlier tap or a save — answers as it
   * stands and writes nothing.
   */
  async markReviewed(ctx: RequestContext, pageSegment: string): Promise<ReviewedView> {
    const page = KpmSetup.requirePage(pageSegment);
    const set = await this.marks.setOnce(ctx, page, 'reviewed', this.clock.now());
    if (set.created) {
      await this.audit.record(ctx, {
        action: 'kpm_setup.page_reviewed',
        targetCollection: 'kpmSetupMarks',
        targetId: set.id,
        before: null,
        after: { page, via: 'reviewed' },
      });
    }
    return { page, reviewed: true, at: set.at.toISOString(), via: set.via };
  }

  /**
   * **Saving the page sets the mark too** (P19.3-T2, *Routes*: *"Saving any of the four pages also sets the flag"*). Called
   * once the save has succeeded; **fails open** — a mark that cannot be written is logged, and the save stands.
   */
  async markSaved(ctx: RequestContext, page: ReviewedPage): Promise<void> {
    try {
      await this.marks.setOnce(ctx, page, 'saved', this.clock.now());
    } catch (err) {
      this.logger.error({ err, page }, 'failed to mark a settings page saved');
    }
  }

  /** The card, what waits, and the year's months — for `GET /kpm/overview`. */
  async read(ctx: RequestContext, facts: SetupFacts): Promise<SetupReading> {
    const office = (await this.kpms.findById(ctx.kpmId)
      .select('createdAt ownerUserId address contactPhone settings timezone').lean().exec()) as
      | { createdAt?: Date; ownerUserId?: string | null; address?: string | null; contactPhone?: string | null;
        settings?: { productionLockGraceDays?: number } }
      | null;
    const year = facts.today.slice(0, 4);
    // The KPM's first month, in its own zone (UI-150's *"KPM creation month (exists on the KPM)"*).
    const firstMonth = office?.createdAt
      ? this.clock.localDateFor(facts.timezone ?? DEFAULT_TENANT_TIMEZONE, office.createdAt).slice(0, 7)
      : `${year}-01`;
    // Never after this month: an office row stamped later than the office's own today (a clock behind) counts from now.
    const from = [[`${year}-01`, firstMonth].sort()[1], facts.month].sort()[0];
    const latestHeld = facts.held.length === 0 ? null : facts.held[facts.held.length - 1];
    const waiting = monthsFrom(from, facts.month).filter((m) => latestHeld === null || m > latestHeld);
    const grace = office?.settings?.productionLockGraceDays ?? PRODUCTION.LOCK_GRACE_DAYS;

    const ownerUserId = office?.ownerUserId ?? null;
    const [marks, overrides, productsAwaiting, draft, besidesOwner, uploaded] = await Promise.all([
      this.marks.marksOf(ctx),
      waiting.length === 0
        ? Promise.resolve([])
        : this.productionMonths.find(
          ctx, { month: { $in: waiting } }, { projection: { month: 1, lockOverride: 1, firstWrittenOn: 1, revision: 1 } },
        ),
      this.products.count(ctx, { reviewState: 'pending' }),
      this.checklists.findOne(ctx, { status: 'draft' }),
      this.memberships.count(ctx, { status: 'active', ...(ownerUserId ? { userId: { $ne: ownerUserId } } : {}) }),
      facts.held.length > 0 ? Promise.resolve(true) : this.batches.exists(ctx, { status: 'committed' }),
    ]);

    /*
     * Open as the data upload judges it (ADR-0050, `ProductionMonths.state`): a hand on the lock wins, else the schedule —
     * **as ADR-0214 §11 amends it** (P19.5-T3, the alignment P19.5-T2 left to it): every month waited on is in the required
     * history (it is from the KPM's first month on), so one **never written** stays open past its schedule, closing
     * `grace` days from today until its first upload; one first written after its schedule closes `grace` days after
     * that write. Data upload and this list name the same months.
     */
    type MonthRow = { month: string; lockOverride?: string | null; firstWrittenOn?: string | null; revision?: number };
    const rows = new Map((overrides as MonthRow[]).map((row) => [row.month, row]));
    const missing: OpenMonth[] = waiting
      .map((m) => {
        const row = rows.get(m);
        const scheduled = editableUntil(`${m}-01`, grace);
        const written = row?.firstWrittenOn ?? null;
        const neverWritten = written === null && (row === undefined || (row.revision ?? 0) === 0);
        const closesOn = neverWritten && facts.today > scheduled ? addDays(facts.today, grace)
          : written !== null && written > scheduled ? addDays(written, grace)
            : scheduled;
        return { month: m, closesOn, hand: row?.lockOverride ?? null };
      })
      .filter(({ closesOn, hand }) => (hand === null ? facts.today <= closesOn : hand === 'open'))
      .map(({ month: m, closesOn }) => ({ month: m, closesOn }));

    const settings: SettingsWaiting = {
      productsAwaiting,
      checklistDraftVersion: draft ? (draft as unknown as { version: number }).version : null,
    };
    const reading = (setup: SetupView | null): SetupReading => ({ setup, settings, from, missing });
    if (marks.has('setup-complete')) return reading(null);

    const done: Record<SetupStep, boolean> = {
      'branch-info': marks.has('branch-info'),
      'activity-types': marks.has('activity-types'),
      'activation-checklist': marks.has('activation-checklist'),
      products: marks.has('products'),
      import: besidesOwner > 0,
      upload: uploaded,
      'recruit-target': facts.target !== null,
    };
    const count = SETUP_STEPS.filter((key) => done[key]).length;
    if (count === SETUP_STEPS.length) {
      // All seven: stored once, so the card never comes back (P19.3-T2, *Backend*). Not by a read that only looks — a
      // view-as session, or the Super Admin's platform read (ADR-0206 §4, ADR-0207 §3): the next read by the office stores it.
      if (!ctx.impersonationReadOnly) await this.marks.setOnce(ctx, 'setup-complete', 'derived', this.clock.now());
      return reading(null);
    }
    const thisMonthOpen = facts.today <= editableUntil(`${facts.month}-01`, grace);
    return reading({
      done: count,
      steps: SETUP_STEPS.map((key) => ({ key, done: done[key] })),
      branchFilled: !!office?.address?.trim() && !!office?.contactPhone?.trim(),
      members: facts.headcount,
      openMonth: missing[0] ?? (thisMonthOpen ? { month: facts.month, closesOn: editableUntil(`${facts.month}-01`, grace) } : null),
      target: facts.target,
    });
  }
}
