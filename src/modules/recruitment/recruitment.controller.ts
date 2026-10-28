import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { RequestDocumentUploadDto } from '@/modules/assets/asset.dto';
import { SignedUploadDto } from '@/modules/assets/asset.response.dto';
import {
  AttachPitchDocumentDto, RecruitmentBriefQueryDto, SaveRecruitmentPlaybookDto, SetPitchConfirmationDto,
} from './recruitment.dto';
import {
  PitchDocumentUrlDto, PitchMaterialsDto, PitchSlotDto, RecruitmentAttackPlanDto, RecruitmentPlaybookAdminDto,
  RecruitmentPlaybookDto,
} from './recruitment.response.dto';
import { RecruitmentPitchService } from './recruitment-pitch.service';
import { RecruitmentPlanService } from './recruitment-plan.service';
import { RecruitmentPlaybookService } from './recruitment-playbook.service';

/** A refusal the derived descriptions cannot know, in the shared envelope. */
const refusal = (status: number, description: string) => ({ status, description, type: ApiErrorEnvelope });

/** Who reads the field routes, and who is turned away before anything is looked up. */
const READERS =
  'Every member of the office — the Owner and the Admin through their field view, an AB, an AAB and an Agent '
  + '— and a support session acting as one, read-only included. A Super Admin outside a support session '
  + 'belongs to no office and is refused `403 TENANT_NO_MEMBERSHIP`.';

/**
 * **The agents' *Recruitment*** (`/recruitment/attack-plan`, `/recruitment/pitch-materials`;
 * `functional/recruitment.md`, the Data contract): the plan for a candidate brief, the office's six pitch
 * documents — four required, two optional (ADR-0177) — and a document's short-lived link. Field reads under
 * `recruitment:read`; nothing here writes.
 */
@ApiTags('recruitment')
@ApiBearerAuth()
@Controller('recruitment')
export class RecruitmentController {
  constructor(
    private readonly plans: RecruitmentPlanService,
    private readonly pitch: RecruitmentPitchService,
  ) {}

  @Get('attack-plan')
  @RequirePermission('recruitment:read')
  @ApiOperation({
    summary: 'The Recruitment Attack Plan for a candidate brief',
    description:
      'The brief’s three questions as chips, whether the office’s company has a recruitment playbook, and — '
      + 'with a brief — the plan built from that playbook: the profile, an opening per motivation, an '
      + 'objection per hesitation (the profile’s own where it has one, else the base), and the next action, '
      + 'each list in the chips’ order. No brief, or no playbook: `plan: null`. All three parameters or none; '
      + 'an unknown or repeated code, an empty list, a missing parameter or any other parameter is `400`. '
      + `The words are the company’s, read live. Nothing about the candidate is stored. ${READERS}`,
  })
  @ApiResponse({ status: 200, type: RecruitmentAttackPlanDto })
  async attackPlan(@Ctx() ctx: RequestContext, @Query() query: RecruitmentBriefQueryDto) {
    return this.plans.attackPlan(ctx, query);
  }

  @Get('pitch-materials')
  @RequirePermission('recruitment:read')
  @ApiOperation({
    summary: 'The office’s recruitment pitch documents',
    description:
      'The six slots in order — the four the office’s readiness counts, then *Company Profile* and *Agency '
      + 'Profile*, optional — each with whether it is `required`, its state (*missing*, *complete*, *partial*, '
      + '*uploaded*), its file (name, size as storage reported it, and upload day in the office’s calendar) or '
      + '`null`, and whether each item of its checklist is ticked; and the banner’s counts, over the four '
      + `required alone. The agents’ tab and the settings page read the same answer. ${READERS}`,
  })
  @ApiResponse({ status: 200, type: PitchMaterialsDto })
  async pitchMaterials(@Ctx() ctx: RequestContext) {
    return this.pitch.read(ctx);
  }

  @Get('pitch-materials/:slot/url')
  @RequirePermission('recruitment:read')
  @ApiOperation({
    summary: 'A pitch document’s link, valid 300 seconds',
    description:
      'Signed only for a slot the reader’s own office has filled, whatever its ticks. A slot with nothing in '
      + `it and a slot that does not exist answer \`404\`, as another office’s does. ${READERS}`,
  })
  @ApiResponse({ status: 200, type: PitchDocumentUrlDto })
  async pitchDocumentUrl(@Ctx() ctx: RequestContext, @Param('slot') slot: string) {
    return this.pitch.url(ctx, slot);
  }
}

/**
 * **The office's side of the pitch** (`/kpm/settings/recruitment-pitch`): uploading, attaching and replacing
 * a document, and confirming what it includes. **`tenant_config:write`**, the one permission for every page
 * under Settings (ADR-0027) — the Owner's and the Admin's; a read-only support session is refused each, and
 * an elevated one writes as its member, both actors on the audit row. The page reads
 * `GET /recruitment/pitch-materials`.
 */
@ApiTags('recruitment')
@ApiBearerAuth()
@Controller('kpm/settings/recruitment-pitch')
export class RecruitmentPitchController {
  constructor(private readonly pitch: RecruitmentPitchService) {}

  @Post('uploads')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'A signed upload for a pitch document',
    description:
      'A PDF of at most 25 MB, into the office’s own `recruitment-pitch` folder — refused before anything is '
      + 'signed otherwise. The bytes go from the browser straight to storage; attach the key to a slot next.',
  })
  @ApiResponse({ status: 201, type: SignedUploadDto })
  @ApiResponse(refusal(413, '`ASSET_TOO_LARGE` — larger than 25 MB.'))
  @ApiResponse(refusal(415, '`ASSET_TYPE_NOT_ALLOWED` — not a PDF.'))
  async requestUpload(@Ctx() ctx: RequestContext, @Body() dto: RequestDocumentUploadDto) {
    return this.pitch.requestUpload(ctx, dto);
  }

  @Put(':slot')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Attach a PDF to a slot, or replace the one it holds',
    description:
      'Any of the six slots, the two optional ones as the four. The upload is confirmed against what storage '
      + 'holds first; then, in one write, the file replaces what the slot held, **every confirmation of the slot '
      + 'is cleared**, and `version` moves by one. The file it replaced is released, never deleted. Audited '
      + '(`recruitment_pitch.attached`) with the items it cleared. Attaching the file the slot already holds '
      + 'changes nothing.',
  })
  @ApiResponse({ status: 200, type: PitchSlotDto })
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — no such slot, or a key this office was never signed — **or** one belonging to another '
    + 'office. They are deliberately indistinguishable: a `403` here would confirm it exists. Nothing is attached.',
  ))
  @ApiResponse(refusal(409, '`ASSET_NOT_UPLOADED` — the bytes never reached storage. Nothing is attached.'))
  @ApiResponse(refusal(413, '`ASSET_TOO_LARGE` — storage holds more than 25 MB. Nothing is attached.'))
  @ApiResponse(refusal(415, '`ASSET_TYPE_NOT_ALLOWED` — storage holds something other than a PDF. Nothing is attached.'))
  async attach(@Ctx() ctx: RequestContext, @Param('slot') slot: string, @Body() dto: AttachPitchDocumentDto) {
    return this.pitch.attach(ctx, slot, dto.storageKey);
  }

  @Put(':slot/confirmations/:item')
  @RequirePermission('tenant_config:write')
  @ApiOperation({
    summary: 'Confirm that the PDF includes an item, or take the confirmation back',
    description:
      '*"Confirm this PDF actually includes"*: tick or untick one item of the slot’s checklist, against the '
      + 'slot’s `version` — the file the reader saw. Idempotent. An item the slot does not have, or a slot '
      + 'with no file, is `400`. Audited with who and when (`recruitment_pitch.ticked`, `…unticked`); the '
      + 'version does not move.',
  })
  @ApiResponse({ status: 200, type: PitchSlotDto })
  @ApiResponse(refusal(
    404,
    '`NOT_FOUND` — no such slot. Indistinguishable from one in another office, which an office never reaches.',
  ))
  @ApiResponse(refusal(409, '`VERSION_CONFLICT` — the file was replaced since it was read. Nothing is written.'))
  async setConfirmation(
    @Ctx() ctx: RequestContext,
    @Param('slot') slot: string,
    @Param('item') item: string,
    @Body() dto: SetPitchConfirmationDto,
  ) {
    return this.pitch.confirm(ctx, slot, item, dto);
  }
}

/**
 * **A company's recruitment playbook, on the console** (OD-88 → option 5, ADR-0125; the Company template's
 * *Recruitment* tab). The company's own, shared by every template and read live by every office of the
 * company. Read under `company_template:read`; saved under **`recruitment_playbook:write`** — the Super
 * Admin's alone, apart from `company_template:write` because the words reach every office at once, as a
 * product does.
 */
@ApiTags('recruitment')
@ApiBearerAuth()
@Controller('admin/companies/:companyId/recruitment-playbook')
export class RecruitmentPlaybookController {
  constructor(private readonly playbooks: RecruitmentPlaybookService) {}

  @Get()
  @RequirePermission('company_template:read')
  @ApiOperation({
    summary: 'A company’s recruitment playbook',
    description:
      'The company’s playbook with its version, or `null` for a company with none; the AgencyBoost words, to '
      + 'start one from; the brief’s vocabulary its words are keyed by; and the bounds a save is held to '
      + '(`limits`).',
  })
  @ApiResponse({ status: 200, type: RecruitmentPlaybookAdminDto })
  async read(@Param('companyId') companyId: string) {
    return this.playbooks.readForAdmin(companyId);
  }

  @Put()
  @RequirePermission('recruitment_playbook:write')
  @ApiOperation({
    summary: 'Save a company’s recruitment playbook',
    description:
      'The whole playbook in one write, pinned to `version` — `null` only to create the first. Every profile '
      + 'and every hesitation answered, an opening for every motivation, each text 1 to 600 characters, 1 to 6 '
      + 'benefits a profile, no key the playbook does not have: otherwise `400 VALIDATION_FAILED` with every '
      + 'violation in `details.violations`, each `{ field, message }`, the field a path into the request — '
      + '`body.profiles.retiree.benefits[1]`, `body.objections.time.youSay`, `body.nextAction`. Audited with '
      + 'the words before and after. Every office of the company reads it on its next plan.',
  })
  @ApiResponse({ status: 200, type: RecruitmentPlaybookDto })
  @ApiResponse(refusal(
    409,
    '`VERSION_CONFLICT` — the playbook changed since it was read, or `version: null` for a company that has '
    + 'one. Nothing is written.',
  ))
  async save(
    @Ctx() ctx: RequestContext, @Param('companyId') companyId: string, @Body() dto: SaveRecruitmentPlaybookDto,
  ) {
    return this.playbooks.save(ctx, companyId, { version: dto.version, body: dto.body });
  }
}
