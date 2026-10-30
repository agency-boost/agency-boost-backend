import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, MaxLength, Min } from 'class-validator';
import { AVATAR } from '@/domain/constants';

/** *Simpan foto* (UI-111), first step: what the browser is about to upload — the 256px JPEG crop. */
export class RequestAvatarUploadDto {
  @ApiProperty({ enum: AVATAR.MIME_TYPES, description: 'The crop is always a JPEG.' })
  @IsIn(AVATAR.MIME_TYPES as unknown as string[])
  mimeType!: string;

  @ApiProperty({
    example: 24576,
    description: 'What the browser is about to send: at most 512 KB (`AVATAR.MAX_BYTES`), checked here and again '
      + 'against what storage holds (ADR-0040).',
  })
  @IsInt() @Min(1)
  bytes!: number;
}

/** *Simpan foto*, second step: the key storage holds the bytes under, from the signed upload. */
export class AttachAvatarDto {
  @ApiProperty({ example: 'dev/user/66f0…/avatar/01JB…' })
  @IsString() @MaxLength(300)
  storageKey!: string;
}

/** The photo as every avatar of the person draws it (UI-111). */
export class AvatarDto {
  @ApiProperty({ type: String, nullable: true, description: 'A signed link valid 12 hours, or `null`: initials.' })
  avatarUrl!: string | null;
}

/** Who leads the reader, as *Leader Anda* names them. */
export class ProfileLeaderDto {
  @ApiProperty({ example: 'Wilson Tanoto' }) name!: string;
  @ApiProperty({ example: 'AB', description: 'Their rung’s code; the screen names it from the office’s ladder.' })
  orgLevelCode!: string;
}

/** *Grup Anda*: everybody below the reader, by role. */
export class ProfileGroupDto {
  @ApiProperty({ example: 11, description: 'Everybody the reader leads, at any depth, active.' }) people!: number;
  @ApiProperty({ example: 0 }) ab!: number;
  @ApiProperty({ example: 3 }) aab!: number;
  @ApiProperty({ example: 8 }) agents!: number;
}

/** *Profil saya*'s read-only facts (UI-111): what sign-up recorded and where the reader stands. */
export class ProfileFactsDto {
  @ApiProperty({ type: String, nullable: true, example: 'Prudential Indonesia', description: 'Their insurer, as the platform names it.' })
  companyName!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '70012345', description: 'The code their insurer issued; never changed here.' })
  agentCode!: string | null;

  @ApiProperty({ type: ProfileLeaderDto, nullable: true, description: '`null` with no leader, or no office.' })
  leader!: ProfileLeaderDto | null;

  @ApiProperty({ type: ProfileGroupDto, nullable: true, description: '`null` for somebody who leads nobody.' })
  group!: ProfileGroupDto | null;
}
