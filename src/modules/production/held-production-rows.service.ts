import { Injectable } from '@nestjs/common';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { AuditService } from '@/modules/audit/audit.service';
import { HeldRowsPort } from '@/modules/org/held-rows.port';
import { MonthlyAgentDataRepository } from './monthly-agent-data.repository';
import { cellAsHydrated, type MetricValue } from './monthly-agent-data.schema';
import { heldCodeOf } from './production-preview';
import { UnregisteredAgentDataRepository } from './unregistered-agent-data.repository';

/**
 * **The *Belum terdaftar* months of a code, moved onto the membership that takes it** (P19.5-T2 AC-5; ADR-0214 §8).
 *
 * When a membership of the KPM is given a code that the Data upload held apart under `unknownAgent: 'flag'`, each held
 * month is written onto the membership:
 *
 * - **as an import writes** — provenance `imported`, the held row's batch as its source — where the membership has no
 *   row for that month;
 * - **where it has one, a held cell fills only an empty cell**: a stored figure is never replaced by a held one.
 *
 * The held row becomes `moved`, with the membership and the moment, never deleted; the move is audited
 * (`production.held_rows_moved`). Tenant-scoped throughout.
 */
@Injectable()
export class HeldProductionRows implements HeldRowsPort {
  constructor(
    private readonly held: UnregisteredAgentDataRepository,
    private readonly data: MonthlyAgentDataRepository,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async codeRegistered(ctx: RequestContext, membershipId: string, agentCode: string): Promise<void> {
    const rows = await this.held.find(ctx, { agentCode: heldCodeOf(agentCode), status: 'held' }, { sort: { month: 1 } });
    if (rows.length === 0) return;
    const now = this.clock.now();
    const moved: string[] = [];
    for (const row of rows) {
      const existing = await this.data.findOne(ctx, { membershipId, month: row.month });
      const set: Record<string, unknown> = {};
      const fill = (bucket: 'values' | 'ytdValues') => {
        for (const [kode, raw] of Object.entries(row[bucket] ?? {})) {
          const cell = cellAsHydrated(raw as Partial<MetricValue>);
          if (!cell || cell.value === null) continue;
          const there = cellAsHydrated((existing?.[bucket]?.[kode] ?? undefined) as Partial<MetricValue> | undefined);
          if (there && (there.value !== null || there.provenance !== null)) continue;
          set[`${bucket}.${kode}`] = { ...cell, provenance: 'imported', sourceBatchId: row.sourceBatchId };
        }
      };
      fill('values');
      fill('ytdValues');
      if (Object.keys(set).length > 0 || !existing) {
        await this.data.upsertOne(ctx, { membershipId, month: row.month }, {
          $set: {
            ...set,
            ...(existing ? {} : { templateId: row.templateId, templateVersion: row.templateVersion, asOf: row.asOf }),
          },
          $setOnInsert: { agentCode },
        });
      }
      await this.held.updateById(ctx, String(row._id), {
        $set: { status: 'moved', movedToMembershipId: membershipId, movedAt: now },
      });
      moved.push(row.month);
    }
    await this.audit.record(ctx, {
      action: 'production.held_rows_moved',
      targetCollection: 'unregisteredAgentData',
      targetId: heldCodeOf(agentCode),
      targetMembershipId: membershipId,
      after: { agentCode: heldCodeOf(agentCode), months: moved },
    });
  }
}
