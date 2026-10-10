import { Injectable } from '@nestjs/common';
import {
  CampaignStandingsReader, type OfficeCampaign, type OfficeStanding,
} from '@/modules/campaigns/campaign-standings-reader';
import { campaignOrder } from '@/modules/campaigns/campaign-words';
import { MemberNames } from '@/modules/org/member-names.service';
import type {
  ComplianceCategory, ComplianceCategoryRead, ComplianceCell, ComplianceOverride, ComplianceScope,
} from './compliance-category';

/** One campaign the Owner's *Campaigns* picker lists (D-window: overlapping this year, archived never). */
export interface ComplianceCampaignEntry {
  code: string;
  title: string;
  kind: 'structural' | 'seasonal';
  subtype: string | null;
  phase: 'upcoming' | 'running' | 'ended';
  /** ISO instants; `endsAt` `null` for a structural campaign with no end. */
  startsAt: string;
  endsAt: string | null;
  /** Its window's result is final (ADR-0144): the last month it reads has locked. */
  final: boolean;
}

export type CampaignsComplianceCatalog = ComplianceCampaignEntry[];

/** *—* in both columns: a campaign not open to the member's rung (D-chips). */
const NOT_ELIGIBLE: ComplianceCell = { status: null, done: null, on: null, second: null, override: null, overridable: false };

/** The picker's order: *Structural*, then *Seasonal — Ongoing*, then *Seasonal — Past* (`Owner:3002-3011`, `:3586-3600`). */
export function campaignPickerOrder(a: OfficeCampaign, b: OfficeCampaign): number {
  if (a.kind !== b.kind) return a.kind === 'structural' ? -1 : 1;
  const orderable = (c: OfficeCampaign) => ({
    code: c.code, title: c.title, kind: c.kind, phase: c.phase,
    startsAt: new Date(c.startsAt), endsAt: c.endsAt === null ? null : new Date(c.endsAt),
  });
  return campaignOrder(orderable(a), orderable(b));
}

/** The *Achieved* column is drawn only for an ended seasonal campaign (`Owner:3889`). */
const achievedApplies = (campaign: OfficeCampaign) => campaign.kind === 'seasonal' && campaign.phase === 'ended';

/**
 * **One member's cell for one campaign** (P18.6-T2 AC-6, AC-8) — the evaluation the member's own dialog reads, the
 * override applied (`fromFrozen`).
 *
 * - *Chasing* (`chasing`, done) / *Not chasing* (`not_chasing`); *—* in both for a rung it is not open to.
 * - `second`: the qualification status — the registry's code, which the screen labels *Achieved* (`qualified`),
 *   *Not achieved* (`not_met`, `not_joined`) or *—* (`in_progress`, `unknown`) — only for an ended seasonal
 *   campaign; `null` otherwise.
 * - `overridable`: the stored final standing of an ended seasonal campaign — a chaser at the window's end
 *   (ADR-0143 §4); a final `unknown` included — **never the reader's own** (`self`; the exit review, round 1: nobody
 *   overrides their own result, so no control is drawn on it). `override`: who set it, when and why.
 */
export function campaignCell(
  standing: OfficeStanding | undefined, campaign: OfficeCampaign, nameOf: (membershipId: string) => string, self = false,
): ComplianceCell {
  if (standing === undefined || !standing.eligible) return NOT_ELIGIBLE;
  const applies = achievedApplies(campaign);
  const override: ComplianceOverride | null = standing.overridden === null ? null : {
    status: standing.overridden.status,
    reason: standing.overridden.reason,
    by: { membershipId: standing.overridden.byMembershipId, name: nameOf(standing.overridden.byMembershipId) },
    at: standing.overridden.at,
  };
  return {
    status: standing.chasing ? 'chasing' : 'not_chasing',
    done: standing.chasing,
    on: null,
    second: applies ? standing.status : null,
    override,
    overridable: applies && standing.final && standing.chasing && !self,
  };
}

/**
 * **Campaigns in the Owner's compliance tree** (P18.6-T1 AC-3, P18.6-T2 AC-4, AC-6; D-window, D-chips, D-override).
 *
 * - **The catalog**: the office's seasonal campaigns overlapping this year — ended ones included — **and one whose
 *   window's last month is last December**, which becomes final this January (the exit review's M1: without it a
 *   December campaign left the tree before it could be overridden), every seasonal one not started yet whatever its
 *   year (round 2: members chase it before it starts), and its structural ones running; archived never
 *   (D-window, `inWindow`), through `CampaignStandingsReader.ofOffice` over the tree's members; in the picker's
 *   order. Without an `item`, the first: the prototype opens on its first campaign (`Owner:3497`), a structural one.
 * - **The chip**: of the tree's members eligible for at least one listed campaign, those chasing one they are
 *   eligible for.
 * - **The cells**: the selected campaign's, as `campaignCell` reads them — equal to the evaluation each member's own
 *   dialog reads, the override applied.
 * - **404** for an `item` the catalog does not list — refused by the port (`requireListed`) **before it evaluates
 *   anything**, so a refused read freezes and audits nothing (the exit review, round 1, item 7). Otherwise a read may
 *   be the first after a window locked: the port freezes it once, audited, and never in a read-only support session
 *   (ADR-0144). No §3.5 entry (D-audit-tree).
 */
@Injectable()
export class CampaignsComplianceCategory implements ComplianceCategory<CampaignsComplianceCatalog> {
  constructor(
    private readonly standings: CampaignStandingsReader,
    private readonly names: MemberNames,
  ) {}

  async read(
    scope: ComplianceScope,
    selection: { selected: boolean; item: string | null },
  ): Promise<ComplianceCategoryRead<CampaignsComplianceCatalog>> {
    const asked = selection.item === null ? undefined : selection.item.toUpperCase();
    // A code the year does not list is refused by the port before it evaluates anything: a 404 freezes nothing.
    const read = await this.standings.ofOffice(scope.ctx, {
      window: { start: scope.year.start, end: scope.year.end },
      memberIds: scope.memberIds,
      requireListed: asked,
    });
    const listed = [...read.campaigns].sort(campaignPickerOrder);
    const catalog = listed.map((c): ComplianceCampaignEntry => ({
      code: c.code, title: c.title, kind: c.kind, subtype: c.subtype, phase: c.phase,
      startsAt: c.startsAt, endsAt: c.endsAt, final: c.final,
    }));
    const item = asked ?? listed[0]?.code ?? null;

    const members = new Set(scope.memberIds);
    const eligible = new Set<string>();
    const chasing = new Set<string>();
    for (const standing of read.standings) {
      if (!members.has(standing.membershipId) || !standing.eligible) continue;
      eligible.add(standing.membershipId);
      if (standing.chasing) chasing.add(standing.membershipId);
    }

    let cells: Map<string, ComplianceCell> | null = null;
    if (selection.selected) {
      cells = new Map();
      const campaign = listed.find((c) => c.code === item);
      if (campaign) {
        const mine = new Map(read.standings.filter((s) => s.campaignCode === campaign.code).map((s) => [s.membershipId, s]));
        const by = [...new Set([...mine.values()].flatMap((s) => (s.overridden ? [s.overridden.byMembershipId] : [])))];
        const names = by.length > 0 ? await this.names.byMembershipId(scope.ctx, by) : new Map<string, string>();
        const nameOf = (m: string) => names.get(m) ?? '';
        for (const id of scope.memberIds) cells.set(id, campaignCell(mine.get(id), campaign, nameOf, id === scope.ctx.membershipId));
      }
    }
    return { catalog, chip: { count: chasing.size, of: eligible.size }, item, cells };
  }
}
