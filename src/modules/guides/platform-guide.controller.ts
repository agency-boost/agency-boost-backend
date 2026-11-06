import { Controller, Get, Header, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '@/common/auth/auth.decorators';
import { ApiErrorEnvelope } from '@/common/errors/error-envelope.dto';
import { SUPER_ADMIN_GUIDE, SuperAdminGuide } from './super-admin-guide';

/** Every role but the Super Admin, a view-as session included: one answer, which names the grant. */
const NOT_THE_SUPER_ADMIN =
  '`PERM_DENIED` (`details.permission: "platform_guide:read"`) — every role but the Super Admin: the KPM Owner, the '
  + 'KPM Admin, an AB, an AAB, an Agent, somebody in no office, and a view-as session, which acts as its member. '
  + 'Nothing of the guide is answered.';

/**
 * **The Super Admin's guide, INTERNAL** (P19.6-T5; ADR-0219 §4; `functional/guides.md`, the Data contract): the HTML
 * and its PDF, as the owner delivered them, **to a Super Admin and nobody else** (`platform_guide:read`). The page
 * `/admin/panduan` reads the HTML with the session and draws it in a sandboxed `srcdoc` frame; its *PDF* control saves
 * the file. Neither answer may be kept by a cache (`no-store`), so no shared cache or proxy holds a copy for anybody
 * else. The two public guides are static files of the frontend (`/panduan/*.html`) and have no route here.
 */
@ApiTags('platform-guide')
@ApiBearerAuth()
@Controller('admin/panduan')
export class PlatformGuideController {
  constructor(private readonly guide: SuperAdminGuide) {}

  @Get()
  @RequirePermission('platform_guide:read')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: 'The Super Admin’s guide (*Panduan Super Admin*), INTERNAL',
    description:
      'The guide’s HTML, byte for byte as delivered (OD-271), `text/html; charset=utf-8`, `Cache-Control: no-store`. '
      + 'Read by `/admin/panduan` with the session and shown in `<iframe sandbox="allow-scripts allow-modals" srcdoc>`; '
      + 'never linked, never in a public folder. **The Super Admin’s alone.**',
  })
  // The 200 is the file alone (`text/html`, `response-map.ts`); the refusals are the envelope, as everywhere.
  @ApiResponse({ status: 200, description: 'The guide’s HTML.' })
  @ApiResponse({ status: 403, description: NOT_THE_SUPER_ADMIN, type: ApiErrorEnvelope })
  html() {
    const bytes = this.guide.html();
    return new StreamableFile(bytes, { type: 'text/html; charset=utf-8', length: bytes.length });
  }

  @Get('pdf')
  @RequirePermission('platform_guide:read')
  @Header('Cache-Control', 'no-store')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: 'The Super Admin’s guide as a PDF, INTERNAL',
    description:
      'The guide’s PDF, byte for byte as delivered, as an attachment named `panduan-super-admin.pdf`, '
      + '`Cache-Control: no-store`. The page’s *PDF* control saves it. **The Super Admin’s alone.**',
  })
  @ApiResponse({ status: 200, description: 'The guide’s PDF.' })
  @ApiResponse({ status: 403, description: NOT_THE_SUPER_ADMIN, type: ApiErrorEnvelope })
  pdf() {
    const bytes = this.guide.pdf();
    return new StreamableFile(bytes, {
      type: 'application/pdf',
      disposition: `attachment; filename="${SUPER_ADMIN_GUIDE.pdfDownloadName}"`,
      length: bytes.length,
    });
  }
}
