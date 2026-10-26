import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import {
  CreateLeadDto, CreateLeadQueryDto, ListLeadsQueryDto, ReorderLeadsDto, SetLeadOutcomeDto, SetLeadStatusDto,
  UpdateLeadDto,
} from './lead.dto';
import { DeletedLeadDto, LeadOrderDto, LeadPageDto, LeadResponseDto } from './lead.response.dto';
import { LeadService } from './lead.service';

/**
 * One person an agent is working (P7-T2, P7-T3).
 *
 * **Eight routes, one screen.** Everything here is called by `/leads`; nothing is an endpoint
 * waiting for a consumer, which is the rule `check-api-consumers.py` enforces and the reason
 * P7-T1 shipped with none at all. `GET /leads/summary` lost its only caller when `/leads` went back to
 * the prototype and was retired with it (P10.1-T4); `PATCH /leads/order`, the screen's drag handles,
 * arrived with P18.8-T7.
 *
 * **Moving and closing are separate routes on separate permissions**, because they are separate
 * acts: a status says where somebody is, an outcome says the work stopped and how it ended. The
 * prototype puts them side by side as a dropdown and two buttons, which is the same distinction
 * drawn in pixels.
 */
/** A named owner outside the caller's reach, worded as every 404 in the document is. */
const NOT_REACHED =
  '`NOT_FOUND` — `owner` names nobody whose leads you may reach, **or** somebody in another office. The '
  + 'two are deliberately indistinguishable: a `403` here would confirm the id exists.';

/** A write pinned to a version the lead has moved past. */
const STALE = '`VERSION_CONFLICT` — the lead changed since `version`: re-read it. Nothing was written.';

/** What the three write routes say about the version they pin. */
const PINNED =
  '`version` is the version the write was read at: a stale one is `VERSION_CONFLICT` (409), and nothing '
  + 'is written. **Optional for the lead’s owner, required of anybody else** — a leader’s write without '
  + 'one is `VALIDATION_FAILED` (400). Another office’s lead, or one you cannot reach, is a 404 first.';

@ApiTags('leads')
@ApiBearerAuth()
@Controller('leads')
export class LeadController {
  constructor(private readonly leads: LeadService) {}

  @Get()
  @RequirePermission('lead:read')
  @ApiOperation({
    summary: 'Your leads',
    description:
      'Search over the name and the remarks, filter by ladder, stage, outcome and attention '
      + 'state, sort on one key, and page. The Leads table sorts on name, type, status and '
      + 'registration, and asks for every page in turn. **Scoped to what your grant reaches**: '
      + 'your own, plus your unit or your downline. A lead outside it is a 404, never a 403. '
      + 'A page holding somebody else’s leads writes one entry to the audit log for each person '
      + 'whose leads it shows; your own write none.\n\n'
      + '`owner` narrows it to one member’s leads — yours, or somebody you coach, for the coaching '
      + 'session’s Leads card — beside every other filter. Somebody your grant does not reach is a '
      + '404. Another member’s list writes one audit entry, whatever it holds.',
  })
  @ApiResponse({ status: 200, type: LeadPageDto })
  // `owner` is a query field, so `openapi.ts` derives no 404 for it: written here.
  @ApiResponse({ status: 404, description: NOT_REACHED, type: ApiErrorEnvelope })
  async list(@Ctx() ctx: RequestContext, @Query() query: ListLeadsQueryDto) {
    return this.leads.list(ctx, query);
  }

  /**
   * **`:id` is the last `GET` in this class, and a literal path added later goes above it.** Nest
   * matches in declaration order, so a `GET /leads/<word>` declared below would be read as a lead
   * whose id is that word — a 404 that looks like a missing record rather than a shadowed route.
   * That 404 is now what `GET /leads/summary` answers: the route stood here until P10.1-T4.
   */
  @Get(':id')
  @RequirePermission('lead:read')
  @ApiOperation({
    summary: 'One lead',
    description:
      '**404, not 403**, for another office’s. A lead you do not own — one of somebody you coach — '
      + 'writes one entry to the audit log; your own writes none.',
  })
  @ApiResponse({ status: 200, type: LeadResponseDto })
  async read(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.leads.read(ctx, id);
  }

  @Post()
  @RequirePermission('lead:create')
  @ApiOperation({
    summary: 'Add a lead',
    description:
      'A name is enough, and a phone number or an email needs nothing beside it: the lawful basis '
      + 'and its rule were removed on 2026-10-07 (ADR-0108 §1). The lead starts on no stage: the '
      + 'first one is a move.\n\n'
      + 'Yours, or — with `owner` — in the pipeline of somebody you coach: the lead is theirs, and its '
      + 'creation and `lastEditedBy` name you. Anybody you do not coach, yourself included, is a 404. '
      + 'No notification is sent.',
  })
  @ApiResponse({ status: 201, type: LeadResponseDto })
  @ApiResponse({ status: 404, description: NOT_REACHED, type: ApiErrorEnvelope })
  async create(
    @Ctx() ctx: RequestContext, @Body() body: CreateLeadDto, @Query() query: CreateLeadQueryDto,
  ) {
    return this.leads.create(ctx, body, query.owner);
  }

  /**
   * **Declared above `PATCH :id`**, or Nest reads *order* as a lead's id and answers a patch to a lead
   * that does not exist (the note on `GET :id` above).
   */
  @Patch('order')
  @RequirePermission('lead:update')
  @ApiOperation({
    summary: 'Put your leads in your order',
    description:
      'Every one of your **open** leads, once each, top first: `GET /leads` without `sort` then answers '
      + 'in this order, and a lead you add goes to the top (ADR-0161 §1). Your own, whatever your grant '
      + 'reaches: a leader orders their own leads, not their agents’. A closed or deleted lead, somebody '
      + 'else’s, another office’s, a repeat or one left out is `VALIDATION_FAILED` (400), and nothing is '
      + 'written. A place is not a change to the lead: no `version` moves and no editor is named. One '
      + '`lead.reordered` entry, with how many.',
  })
  @ApiResponse({ status: 200, type: LeadOrderDto })
  async reorder(@Ctx() ctx: RequestContext, @Body() body: ReorderLeadsDto) {
    return this.leads.reorder(ctx, body.ids);
  }

  @Patch(':id')
  @RequirePermission('lead:update')
  @ApiOperation({
    summary: 'Change a lead',
    description:
      'Any of the fields creation takes, one or several. **Not the stage** — that is its own '
      + 'route. `contact` travels as a pair, so saving the phone never erases the email.\n\n'
      + PINNED,
  })
  @ApiResponse({ status: 200, type: LeadResponseDto })
  @ApiResponse({ status: 409, description: STALE, type: ApiErrorEnvelope })
  async update(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: UpdateLeadDto) {
    return this.leads.update(ctx, id, body);
  }

  @Patch(':id/status')
  @RequirePermission('lead:update')
  @ApiOperation({
    summary: 'Move a lead along its ladder',
    description:
      'Any **active** stage of its own pipeline, at any time (ADR-0045): `rank` is presentation '
      + 'and reorderable, so a forward-only rule would let a drag on the Owner’s settings screen '
      + 'change which moves their agents may make. Refused for the other ladder '
      + '(`LEAD_STATUS_WRONG_PIPELINE`), for a retired stage (`CONFIG_ARCHIVED`), and for a lead '
      + 'that is already closed (`LEAD_ALREADY_CLOSED`). Every move is appended to the history.\n\n'
      + PINNED,
  })
  @ApiResponse({ status: 200, type: LeadResponseDto })
  @ApiResponse({ status: 409, description: `${STALE} \`LEAD_ALREADY_CLOSED\` — reopen it first.`, type: ApiErrorEnvelope })
  async setStatus(
    @Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: SetLeadStatusDto,
  ) {
    return this.leads.setStatus(ctx, id, body.statusCode, body.version);
  }

  @Patch(':id/outcome')
  @RequirePermission('lead:mark_outcome')
  @ApiOperation({
    summary: 'Close a lead, or reopen it',
    description:
      '`won` needs the stage that closes the pipeline (`LEAD_STATUS_NOT_FINAL` otherwise); '
      + '`lost` is allowed at any stage; `null` reopens. The two prototype screens disagree about '
      + 'the second and the stricter reading of each half is taken (§3.7).\n\n'
      + PINNED,
  })
  @ApiResponse({ status: 200, type: LeadResponseDto })
  @ApiResponse({ status: 409, description: `${STALE} \`LEAD_ALREADY_CLOSED\` — reopen it first.`, type: ApiErrorEnvelope })
  async setOutcome(
    @Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: SetLeadOutcomeDto,
  ) {
    return this.leads.setOutcome(ctx, id, body.outcome, body.version);
  }

  @Delete(':id')
  @RequirePermission('lead:delete')
  @ApiOperation({
    summary: 'Remove a lead',
    description:
      '**Soft**, and the owner’s alone (§3.7). Nothing is removed; erasure under PDP is a '
      + 'deliberate, audited, cascading operation and not this button.',
  })
  @ApiResponse({ status: 200, type: DeletedLeadDto })
  async remove(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.leads.remove(ctx, id);
  }
}
