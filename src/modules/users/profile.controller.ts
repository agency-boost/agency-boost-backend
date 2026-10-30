import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Ctx, RefuseInSupportSession } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import type { SignedUpload } from '@/modules/assets/storage.port';
import { AvatarService } from './avatar.service';
import { AttachAvatarDto, AvatarDto, ProfileFactsDto, RequestAvatarUploadDto } from './profile.dto';
import { ProfileService } from './profile.service';

/**
 * ***Profil saya*** (UI V1, 2026-10-30; UI-111): the photo, and the read-only facts the page shows beside what
 * `GET /auth/me` carries. Its own controller under `/auth/me`, so the specs that build `AuthController` stay as they are.
 *
 * **Enforced by the session, as `GET` and `PATCH /auth/me` are** (`roles-and-permissions.md`, `profile:read_self` and
 * `profile:update_self`, noted 2026-10-29): every route reaches the caller's own account, the id the session's and never
 * the request's, and every role holds both at `own`. **The photo is the person's own**: its three writes are refused in
 * any support session (`@RefuseInSupportSession`, ADR-0162 §4).
 */
@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth/me')
export class ProfileController {
  constructor(
    private readonly profile: ProfileService,
    private readonly avatars: AvatarService,
  ) {}

  @Get('profile')
  @ApiOperation({
    summary: 'Your profile’s read-only facts',
    description:
      '*Profil saya* (UI-111): your insurer and the agent code it issued (never changed here: *Hubungi admin KPM*), '
      + 'your leader in this office (`null` with none) and your group — everybody you lead, at any depth, by role '
      + '(`null` when you lead nobody). Your own, read from the session; somebody in no office reads no leader and no group.',
  })
  async facts(@Ctx() ctx: RequestContext): Promise<ProfileFactsDto> {
    return this.profile.facts(ctx);
  }

  @Post('avatar/upload')
  @RefuseInSupportSession()
  @ApiOperation({
    summary: 'Sign the upload of your profile photo',
    description:
      '*Simpan foto*, first step (UI-111): the browser crops the picture to a 256 × 256 JPEG and uploads it straight to '
      + 'storage with this form, under your own folder (ADR-0153: file bytes never transit the API). A type other than '
      + '`image/jpeg` is `415 ASSET_TYPE_NOT_ALLOWED`, more than 512 KB `413 ASSET_TOO_LARGE`. **Refused `403 '
      + 'PERM_DENIED` in any support session.**',
  })
  async requestAvatarUpload(@Ctx() ctx: RequestContext, @Body() dto: RequestAvatarUploadDto): Promise<SignedUpload> {
    return this.avatars.requestUpload(ctx, dto);
  }

  @Put('avatar')
  @RefuseInSupportSession()
  @ApiOperation({
    summary: 'Make the uploaded photo yours',
    description:
      '*Simpan foto*, second step: storage is asked what it holds under the key, and the type and size are checked '
      + 'against that (ADR-0040) before it becomes your photo. A key outside your own photo folder is `404 NOT_FOUND`; '
      + 'nothing there `409 ASSET_NOT_UPLOADED`; not a JPEG `415`, over 512 KB `413`. Answers the signed link every '
      + 'avatar of yours now draws. **Refused `403 PERM_DENIED` in any support session.**',
  })
  async attachAvatar(@Ctx() ctx: RequestContext, @Body() dto: AttachAvatarDto): Promise<AvatarDto> {
    return this.avatars.attach(ctx, dto.storageKey);
  }

  @Delete('avatar')
  @HttpCode(HttpStatus.OK)
  @RefuseInSupportSession()
  @ApiOperation({
    summary: 'Remove your profile photo',
    description:
      '*Hapus foto*: every avatar of yours draws your initials again. Answers `{ avatarUrl: null }`. **Refused `403 '
      + 'PERM_DENIED` in any support session.**',
  })
  async removeAvatar(@Ctx() ctx: RequestContext): Promise<AvatarDto> {
    return this.avatars.remove(ctx);
  }
}
