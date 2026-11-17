import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ulid } from 'ulid';
import { Clock } from '@/common/clock/clock.port';
import { DEFAULT_TENANT_TIMEZONE } from '@/domain/constants';
import { PRODUCT_DATA_READER, ProductDataReader } from './ai/reader.port';
import { IntakeCatalogue } from './intake-catalogue';
import { readableOf, Unreadable, type PreparedFile } from './intake-files';
import { intakeStatusOf } from './intake-status';
import { IntakeTargets } from './intake-targets';
import { understand, type ProductNow } from './intake-understanding';
import {
  IntakeItem, UploadIntake, type IntakeFile, type IntakeItemDocument, type UploadIntakeDocument,
} from './upload-intake.schema';

/**
 * **The reading of an upload, in the API's own process** (P19.15-T3; ADR-0259 §5).
 *
 * There is no queue in this product, and an upload of a few files is read in a minute or two, so the request that
 * uploads answers at once with the intake `reading` and this runs after it, in the same process, file by file. **The
 * trade-off** (ADR-0259 §5): a restart mid-reading loses the reading — nothing resumes it — so an intake still `reading`
 * `INTAKE.STALE_READING_MINUTES` after it started is reported `failed` the next time anybody reads it, and the person
 * uploads again. The screen polls until the status moves.
 *
 * One file failing does not fail the others: its own status and reason are on it.
 */
@Injectable()
export class IntakeReading {
  private readonly logger = new Logger(IntakeReading.name);
  private readonly running = new Set<Promise<void>>();

  constructor(
    @InjectModel(UploadIntake.name) private readonly intakes: Model<UploadIntakeDocument>,
    @InjectModel(IntakeItem.name) private readonly items: Model<IntakeItemDocument>,
    @Inject(PRODUCT_DATA_READER) private readonly reader: ProductDataReader,
    private readonly catalogue: IntakeCatalogue,
    private readonly targets: IntakeTargets,
    private readonly clock: Clock,
  ) {}

  /** Starts reading and returns at once; the reading's own failure is written on the intake, never thrown. */
  start(intakeId: string, companyId: string | null, files: PreparedFile[]): void {
    const job: Promise<void> = this.run(intakeId, companyId, files)
      .catch(async (err: unknown) => {
        this.logger.error({ intakeId, err: err instanceof Error ? err.name : 'unknown' }, 'intake reading failed');
        await this.intakes.updateOne({ _id: intakeId }, { $set: { status: 'failed', failure: 'service_error', readAt: this.clock.now() } }).exec();
      })
      .finally(() => { this.running.delete(job); });
    this.running.add(job);
  }

  /** Every reading under way, finished — what a test waits on, and what a graceful shutdown could. */
  async settled(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  private async run(intakeId: string, companyId: string | null, prepared: PreparedFile[]): Promise<void> {
    const today = this.clock.localDateFor(DEFAULT_TENANT_TIMEZONE);
    const [companies, catalogue] = await Promise.all([this.catalogue.companies(), this.catalogue.catalogue(companyId)]);
    const company = companyId ? companies.find((c) => c.id === companyId) ?? null : null;
    const products = new Map<string, ProductNow>();
    const intake = await this.intakes.findById(intakeId).exec();
    if (!intake) return;
    const files: IntakeFile[] = intake.files.map((f) => ({ ...f }));
    const usage = { inputTokens: 0, outputTokens: 0 };

    for (const [index, file] of prepared.entries()) {
      const record = files[index];
      let readable;
      try {
        readable = await readableOf(file);
      } catch (err) {
        record.status = 'failed';
        record.failure = err instanceof Unreadable ? err.reason : 'unreadable';
        await this.intakes.updateOne({ _id: intakeId }, { $set: { files } }).exec();
        continue;
      }
      const result = await this.reader.readFile({ file: readable.part, company, companies, catalogue, today });
      if (result.usage) {
        usage.inputTokens += result.usage.inputTokens;
        usage.outputTokens += result.usage.outputTokens;
      }
      if (!result.ok) {
        record.status = 'failed';
        record.failure = result.failure;
        await this.intakes.updateOne({ _id: intakeId }, { $set: { files, usage } }).exec();
        continue;
      }
      for (const read of result.value.items) {
        for (const named of read.products) {
          const entry = named.id ? catalogue.find((p) => p.id === named.id) : undefined;
          if (entry && !products.has(entry.id)) {
            const now = await this.targets.productNow(entry.companyId, entry.id, today);
            if (now) products.set(entry.id, now);
          }
        }
        const draft = understand(read, {
          companyId, companies, catalogue, products, file: { index, name: file.name, grid: readable.grid }, today, newId: ulid,
        });
        await this.items.create({ intakeId, ...draft, appliedRef: null, decidedBy: null, decidedAt: null, deletedAt: null });
        record.items += 1;
      }
      record.status = 'read';
      await this.intakes.updateOne({ _id: intakeId }, { $set: { files, usage } }).exec();
    }

    const items = await this.items.find({ intakeId, deletedAt: null }).select('status').lean().exec();
    await this.intakes.updateOne(
      { _id: intakeId, status: 'reading' },
      { $set: { files, usage, status: intakeStatusOf(false, files, items), readAt: this.clock.now() } },
    ).exec();
  }
}
