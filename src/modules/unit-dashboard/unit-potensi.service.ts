import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Clock } from '@/common/clock/clock.port';
import { RequestContext } from '@/common/context/request-context';
import { DomainException, NoMembershipException } from '@/common/errors/domain.exception';
import { ErrorCode } from '@/common/errors/error-codes';
import { calendarMonth, localDayOf, type LocalDate } from '@/common/time/local-day';
import { aaThisMonth, rekrutThisMonth, type PersonPotensi, type PotensiMonth } from '@/domain/metrics/potensi';
import { SubjectReadAudit } from '@/modules/audit/subject-read-audit';
import { LeadReadings, type PotensiOpenLead } from '@/modules/leads/lead-readings';
import { CoachResolver } from '@/modules/org/coach-resolver';
import { MemberNames } from '@/modules/org/member-names.service';
import { MembershipRepository } from '@/modules/org/membership.repository';
import { OfficialApe } from '@/modules/production/official-ape';
import { OrgLevelService } from '@/modules/tenants/org-level.service';
import { TenantDay, type Office } from '@/modules/tenants/tenant-day.service';
import { User, UserDocument } from '@/modules/users/user.schema';
import { UNIT_DASHBOARD_REFUSALS } from './unit-dashboard.messages';
import { UnitDashboardService } from './unit-dashboard.service';

/** A rung, as the company's ladder names it (BP and SBP at Manulife). */
export interface PotensiRung {
  code: string;
  label: string;
}

/** One person's *AA* view (ADR-0193 §1–§2). */
export interface PotensiAaCell {
  /** *n potensi*: sales leads switched on for the month and still open at its end. */
  potensi: number;
  /** `AA_THIS_MONTH`: a sales lead marked *Berhasil* in the month, or the month's row shows policies > 0. */
  aa: boolean;
  /** Sales leads switched on for the month, whatever became of them: a past month's *y* counts the people with one. */
  switched: number;
}

/** One person's *Rekrut* view (ADR-0193 §1, §3). */
export interface PotensiRekrutCell {
  /** *n potensi*: recruitment leads switched on for the month and still open at its end. */
  potensi: number;
  /** *n rekrut ✓*, `REKRUT_THIS_MONTH`: recruitment leads marked *Berhasil* in the month, switched on or not. */
  rekrut: number;
  /** Recruitment leads switched on for the month, whatever became of them: a person with one is in a past month's *y*. */
  switched: number;
}

/** One person on the tab. */
export interface PotensiPerson {
  membershipId: string;
  name: string;
  photoUrl: string | null;
  rung: PotensiRung;
  /** The card's leader: the first row, with the navy role tag before the name (UI-155). */
  isLeader: boolean;
  isReader: boolean;
  /** Their sheet answers the reader — `lead:read` reaches them (§3.7) — so the row opens it. */
  opens: boolean;
  aa: PotensiAaCell;
  rekrut: PotensiRekrutCell;
}

/** A card's sums: its header (*n potensi · n AA*) and an earlier month's row (*potensi x/y · n AA*). */
export interface PotensiTotals {
  aa: { potensi: number; aa: number; switchedPeople: number; switchedPeopleAa: number };
  rekrut: { potensi: number; rekrut: number; switchedPeople: number; switchedPeopleRekrut: number };
}

/** One card: a unit below the head, or the head's own direct agents (UI-155). */
export interface PotensiUnit {
  /**
   * `direct`: ***Unit Anda*** — the head and the agents who answer to them, **first** (P19.8-T4 AC-4, MOB UI-179);
   * `unit`: ***Unit <AAB name>***, each unit below, in the *Overview*'s order.
   */
  kind: 'unit' | 'direct';
  leader: { membershipId: string; name: string; rung: PotensiRung };
  /** The leader first, then everybody in the card in the roster's order. The screen sorts by the tile chosen. */
  people: PotensiPerson[];
  totals: PotensiTotals;
}

/** `GET /unit/dashboard/potensi`. */
export interface UnitPotensiView {
  /** The month read, `YYYY-MM`. */
  month: string;
  /** The agency's current month: an earlier `month` is drawn as the past month's rows (AC-9). */
  currentMonth: string;
  today: LocalDate;
  head: { membershipId: string; name: string; isReader: boolean };
  /**
   * The two tiles: *Active Agent* (was *AA*; ADR-0229 §8), the people who are `AA_THIS_MONTH` in the month; *Rekrut*,
   * the kandidat who became rekrut in it. Under each, ***potensi x*** (P19.8-T4 AC-9, MOB UI-186): **the people** with a
   * lead of that type switched on for the month, whatever became of it — the cards' *y* summed (`switchedPeople`).
   */
  tiles: { aa: number; rekrut: number; potensi: { aa: number; rekrut: number } };
  units: PotensiUnit[];
}

/** One of the person's kandidat on the sheet (AC-7). */
export interface PotensiKandidat {
  leadId: string;
  name: string;
  statusCode: string | null;
  /** `potensi`: switched on, still open; `rekrut`: marked *Berhasil* in the month. */
  state: 'potensi' | 'rekrut';
  /** The office day it became rekrut; `null` for a potensi. */
  rekrutOn: LocalDate | null;
  /** The membership it became, linked through *Tambahkan ke unit ›*: *New Hires ›* opens it. `null` until then. */
  newHireMembershipId: string | null;
}

/** `GET /unit/dashboard/potensi/:membershipId`: the sheet a row opens (AC-6, AC-7). Read-only. */
export interface UnitPotensiPersonView {
  month: string;
  currentMonth: string;
  person: { membershipId: string; name: string; rung: PotensiRung; phone: string | null; isReader: boolean };
  /** The unit line under the title: the person's own unit when they lead somebody, else their leader's. */
  unit: { name: string; rung: PotensiRung } | null;
  /** The AA sheet: their sales leads switched on and still open, nearest next action first, with the client's name. */
  sales: PotensiOpenLead[];
  /** The Rekrut sheet: their kandidat switched on and still open, then those who became rekrut in the month. */
  kandidat: PotensiKandidat[];
}

/** What a membership row is read for here. */
interface Placed {
  membershipId: string;
  leaderId: string | null;
  role: string;
  orgLevelCode: string;
}

/**
 * **The Unit Dashboard's *Potensi* tab** (P19.1-T6; UI-155, UI-159 item 4; ADR-0193; `functional/unit-dashboard.md`,
 * *November 2026*): `GET /unit/dashboard/potensi` and `GET /unit/dashboard/potensi/:membershipId`, on
 * `unit_dashboard:read_potensi` — the dashboard's cells without the Agent's.
 *
 * - **Whose**: the dashboard's own reach (`UnitDashboardService.people`) — the reader's unit, or `for` a leader below
 *   them; the Owner and an Admin any leader's; 404 outside it, never 403. A leader who leads nobody is answered their
 *   own card alone, the tiles at 0 — the tab is the role's, never hidden for being empty (ADR-0189, UI-159 item 4).
 * - **Grouped per unit, in the Overview's order** (AC-3; P19.8-T4 AC-4, MOB UI-179, ADR-0229 §4): **the head's own card
 *   first** — the head and the agents who answer to them directly — then one card per unit below the head, in the
 *   roster's order, each with its leader first. Every person counts once, in every month (MOB UI-182).
 * - **The figures** are the three named metrics (ADR-0193), defined once in `domain/metrics/potensi.ts`: the leads read
 *   once for the whole unit (`LeadReadings.potensiOfMany`), the month's production rows once through the one port for
 *   the official figure (`OfficialApe`, ADR-0195 §5) — the office's file, imported or corrected, never an estimate. The month is the agency's, through the clock port (`Clock.monthBounds`).
 * - **A person's sheet** names clients and kandidat (Q-2), so it reaches only whom the reader's `lead:read` reaches —
 *   themselves, or somebody they coach (§3.7) — and writes the read entry for that person's leads as the leads list
 *   does (ADR-0089). Their WhatsApp number only while their membership is active.
 * - **The read is recorded**: one §3.5 entry per member shown other than the reader, surface `unit_dashboard`, over
 *   the month's days up to today. It fails open.
 *
 * A fixed number of queries whatever the unit's size: none per person.
 */
@Injectable()
export class UnitPotensiService {
  constructor(
    private readonly dashboard: UnitDashboardService,
    private readonly days: TenantDay,
    private readonly clock: Clock,
    private readonly leads: LeadReadings,
    /** ADR-0195 §5: the office's official production, through the one port — never a member's own estimate. */
    private readonly production: OfficialApe,
    private readonly coach: CoachResolver,
    private readonly orgLevels: OrgLevelService,
    private readonly names: MemberNames,
    private readonly memberships: MembershipRepository,
    private readonly subjectReads: SubjectReadAudit,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
  ) {}

  async read(ctx: RequestContext, query: { month?: string; for?: string } = {}): Promise<UnitPotensiView> {
    const me = requireMembership(ctx);
    const office = await this.days.office(ctx);
    const m = this.monthOf(office, query.month);
    const people = await this.dashboard.people(ctx, query.for);
    const ids = people.group;

    const [placed, figures, cells, ladder, pictured, leadReach] = await Promise.all([
      this.placed(ctx, ids),
      this.leads.potensiOfMany(ctx, ids, m),
      this.production.monthCellsAndYearToDateFor(ctx, ids, { from: m.month, to: m.month }),
      office.companyId ? this.orgLevels.list(ctx, office.companyId) : Promise.resolve([]),
      this.names.pictured(ctx, ids),
      this.coach.reach(ctx, 'lead:read'),
    ]);
    const labels = new Map(ladder.map((level) => [level.code, level.label]));
    const rungOf = (id: string): PotensiRung => {
      const code = placed.get(id)?.orgLevelCode ?? '';
      return { code, label: labels.get(code) ?? code };
    };
    const nameOf = (id: string) => people.names.get(id) ?? '';

    const personOf = (id: string, isLeader: boolean): PotensiPerson => {
      const counted = figures.get(id) as PersonPotensi;
      const policies = cells.cells.get(id)?.get(m.month)?.policyCountMonthly ?? null;
      return {
        membershipId: id,
        name: nameOf(id),
        photoUrl: pictured.get(id)?.photoUrl ?? null,
        rung: rungOf(id),
        isLeader,
        isReader: id === me,
        opens: id === me || leadReach === null || leadReach.includes(id),
        aa: {
          potensi: counted.sales.potensi,
          aa: aaThisMonth(counted.sales.won, policies),
          switched: counted.sales.switched,
        },
        rekrut: {
          potensi: counted.recruitment.potensi,
          rekrut: rekrutThisMonth(counted),
          switched: counted.recruitment.switched,
        },
      };
    };

    // The tree below the head, each level in the roster's order (`people.group` is it).
    const below = new Map<string, string[]>();
    for (const id of ids) {
      const leader = placed.get(id)?.leaderId;
      if (id !== people.head.membershipId && leader) below.set(leader, [...(below.get(leader) ?? []), id]);
    }
    const leadsSomebody = (id: string) => below.has(id);
    const card = (kind: PotensiUnit['kind'], leader: string, members: readonly string[]): PotensiUnit => {
      const rows = [personOf(leader, true), ...members.map((id) => personOf(id, false))];
      return {
        kind, leader: { membershipId: leader, name: nameOf(leader), rung: rungOf(leader) }, people: rows, totals: totalsOf(rows),
      };
    };
    const unitsOf = (leader: string): PotensiUnit[] => {
      const children = below.get(leader) ?? [];
      return [
        card('unit', leader, children.filter((c) => !leadsSomebody(c))),
        ...children.filter(leadsSomebody).flatMap(unitsOf),
      ];
    };
    // The head's level splits as the dashboard's does: its agents who lead nobody are *direct*, anybody else a unit.
    const direct = below.get(people.head.membershipId) ?? [];
    const isUnitHead = (id: string) => placed.get(id)?.role !== 'agent' || leadsSomebody(id);
    // *Unit Anda* first, then each unit below, as the Overview's roster orders them (MOB UI-179).
    const units = [
      card('direct', people.head.membershipId, direct.filter((id) => !isUnitHead(id))),
      ...direct.filter(isUnitHead).flatMap(unitsOf),
    ];
    const everybody = units.flatMap((u) => u.people);

    const view: UnitPotensiView = {
      month: m.month,
      currentMonth: office.month,
      today: office.today,
      head: { membershipId: people.head.membershipId, name: nameOf(people.head.membershipId), isReader: people.head.isReader },
      tiles: {
        aa: everybody.filter((p) => p.aa.aa).length,
        rekrut: everybody.reduce((sum, p) => sum + p.rekrut.rekrut, 0),
        // *potensi x*: the cards' *y* summed — people, never leads (ADR-0229 §8).
        potensi: {
          aa: units.reduce((sum, u) => sum + u.totals.aa.switchedPeople, 0),
          rekrut: units.reduce((sum, u) => sum + u.totals.rekrut.switchedPeople, 0),
        },
      },
      units,
    };

    // Last, once the answer exists: the month's days up to today, one entry per member shown other than the reader.
    await this.subjectReads.recordMany(ctx, everybody, 'unit_dashboard', this.disclosed(office, m.month));
    return view;
  }

  /**
   * **A person's sheet** (AC-6, AC-7): read-only, the names of their potential clients and kandidat (Q-2). `lead:read`'s
   * reach decides who may open it — the reader, or somebody they coach — and anybody else, another office's member
   * included, is 404. Recorded as a read of that person's leads (ADR-0089), never for the reader's own.
   */
  async person(ctx: RequestContext, membershipId: string, query: { month?: string } = {}): Promise<UnitPotensiPersonView> {
    requireMembership(ctx);
    const office = await this.days.office(ctx);
    const m = this.monthOf(office, query.month);
    const subject = await this.coach.subject(ctx, membershipId, 'lead:read', 'Membership');
    const id = subject.membershipId;

    const [own, leads, ladder] = await Promise.all([
      this.memberships.findById(ctx, id),
      this.leads.potensiLeadsOf(ctx, id, m),
      office.companyId ? this.orgLevels.list(ctx, office.companyId) : Promise.resolve([]),
    ]);
    const leadsSomebody = own ? await this.memberships.exists(ctx, { leaderId: id, status: 'active' }) : false;
    const unitHeadId = leadsSomebody ? id : own?.leaderId ?? null;
    const unitHead = unitHeadId && unitHeadId !== id ? await this.memberships.findById(ctx, unitHeadId) : own;
    const named = await this.names.byMembershipId(ctx, [id, ...(unitHeadId ? [unitHeadId] : [])]);
    const labels = new Map(ladder.map((level) => [level.code, level.label]));
    const rung = (code: string | undefined): PotensiRung => ({ code: code ?? '', label: labels.get(code ?? '') ?? code ?? '' });

    const view: UnitPotensiPersonView = {
      month: m.month,
      currentMonth: office.month,
      person: {
        membershipId: id,
        name: named.get(id) ?? '',
        rung: rung(own?.orgLevelCode),
        phone: own?.status === 'active' ? await this.phoneOf(String(own.userId)) : null,
        isReader: subject.self,
      },
      unit: unitHeadId && unitHead ? { name: named.get(unitHeadId) ?? '', rung: rung(unitHead.orgLevelCode) } : null,
      sales: leads.sales,
      kandidat: [
        ...leads.recruitment.map((lead): PotensiKandidat => ({
          leadId: lead.id, name: lead.name, statusCode: lead.statusCode, state: 'potensi', rekrutOn: null, newHireMembershipId: null,
        })),
        ...leads.rekrut.map((lead): PotensiKandidat => ({
          leadId: lead.id,
          name: lead.name,
          statusCode: lead.statusCode,
          state: 'rekrut',
          rekrutOn: localDayOf(lead.rekrutAt, office.timezone),
          newHireMembershipId: lead.joinedMembershipId,
        })),
      ],
    };

    if (!subject.self) await this.subjectReads.record(ctx, { membershipId: id }, 'leads', { from: null, to: office.today });
    return view;
  }

  /** The month asked for — the agency's current one when none — with its bounds; a later one is `400`. */
  private monthOf(office: Office, asked: string | undefined): PotensiMonth {
    const month = asked ?? office.month;
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED, UNIT_DASHBOARD_REFUSALS.VALIDATION_FAILED.potensiMonthShape, HttpStatus.BAD_REQUEST,
        { field: 'month' },
      );
    }
    if (month > office.month) {
      throw new DomainException(
        ErrorCode.VALIDATION_FAILED, UNIT_DASHBOARD_REFUSALS.VALIDATION_FAILED.futureMonth, HttpStatus.BAD_REQUEST,
        { field: 'month', month: office.month },
      );
    }
    return { month, ...this.clock.monthBounds(office.timezone, month) };
  }

  /** The days a month's read discloses: its first day to its last, or to today in the current month. */
  private disclosed(office: Office, month: string): { from: LocalDate; to: LocalDate } {
    const { from, to } = calendarMonth(`${month}-01`);
    return { from, to: to < office.today ? to : office.today };
  }

  /** Each person's leader, role and rung, read once for the whole unit — never empty: the head is always in it. */
  private async placed(ctx: RequestContext, ids: readonly string[]): Promise<Map<string, Placed>> {
    const rows = await this.memberships.find(
      ctx, { _id: { $in: [...ids] } }, { projection: { leaderId: 1, role: 1, orgLevelCode: 1 } },
    );
    return new Map(rows.map((row) => [String(row._id), {
      membershipId: String(row._id), leaderId: row.leaderId ?? null, role: row.role, orgLevelCode: row.orgLevelCode,
    }]));
  }

  /** The person's WhatsApp number on their account, for *Chat Agent {name}*; `null` without one. */
  private async phoneOf(userId: string): Promise<string | null> {
    const user = await this.users.findOne({ _id: userId }).select('phone').lean().exec();
    return (user as { phone?: string | null } | null)?.phone ?? null;
  }
}

/** A card's sums, from its rows: one figure each, never a second reading of the rules. */
function totalsOf(rows: readonly PotensiPerson[]): PotensiTotals {
  const sum = (pick: (p: PotensiPerson) => number) => rows.reduce((total, p) => total + pick(p), 0);
  // An earlier month's *potensi x/y*: *y* the people with a lead switched on, *x* how many of them got the ✓ (§A.13).
  const salesSwitched = rows.filter((p) => p.aa.switched > 0);
  const recruitSwitched = rows.filter((p) => p.rekrut.switched > 0);
  return {
    aa: {
      potensi: sum((p) => p.aa.potensi),
      aa: rows.filter((p) => p.aa.aa).length,
      switchedPeople: salesSwitched.length,
      switchedPeopleAa: salesSwitched.filter((p) => p.aa.aa).length,
    },
    rekrut: {
      potensi: sum((p) => p.rekrut.potensi),
      rekrut: sum((p) => p.rekrut.rekrut),
      switchedPeople: recruitSwitched.length,
      switchedPeopleRekrut: recruitSwitched.filter((p) => p.rekrut.rekrut > 0).length,
    },
  };
}

function requireMembership(ctx: RequestContext): string {
  const me = ctx.membershipId;
  if (!me) throw new NoMembershipException();
  return me;
}
