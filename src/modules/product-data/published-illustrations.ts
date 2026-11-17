import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { IllustrationSummaries, type IllustrationSummary } from './illustration-summaries.port';
import { Illustration, type IllustrationDocument } from './illustration.schema';

/**
 * **The Proposal tab's *Ilustrasi* column** (P19.15-T4 AC-1, provided by T2; ADR-0259 §8): each product's published,
 * not superseded illustration and how many blocks it publishes — *"Ada · 3 bagian"* — else *Belum ada*.
 */
@Injectable()
export class PublishedIllustrations extends IllustrationSummaries {
  constructor(@InjectModel(Illustration.name) private readonly illustrations: Model<IllustrationDocument>) {
    super();
  }

  async ofCompany(companyId: string): Promise<Map<string, IllustrationSummary>> {
    const rows = await this.illustrations
      .find({ companyId, status: 'published', supersededAt: null, deletedAt: null })
      .select('productId blocks publishedAt').sort({ publishedAt: -1 }).lean().exec();
    const out = new Map<string, IllustrationSummary>();
    for (const row of rows) {
      if (out.has(row.productId)) continue;
      out.set(row.productId, {
        blocks: (row.blocks ?? []).filter((b) => b.rows.length).length,
        publishedAt: row.publishedAt ? new Date(row.publishedAt).toISOString() : null,
      });
    }
    return out;
  }
}
