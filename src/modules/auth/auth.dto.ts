import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail, IsEnum, IsInt, IsMongoId, IsOptional, IsString, Matches, Max, MaxLength, Min,
  MinLength,
} from 'class-validator';
import { PasswordService } from './password.service';

export class RegisterDto {
  @ApiProperty({ example: 'rina@kpm0417.test' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'correct horse battery', minLength: PasswordService.MIN_LENGTH })
  @IsString()
  @MinLength(PasswordService.MIN_LENGTH)
  password!: string;

  @ApiProperty({ example: 'Rina Wijaya' })
  @IsString()
  @MinLength(1)
  fullName!: string;

  @ApiProperty({ description: 'From GET /companies.', example: '65f1a0c2e4b0a1b2c3d4e5f6' })
  @IsMongoId()
  companyId!: string;

  /**
   * The producer id the insurer issued them (ADR-0017).
   *
   * Upper-cased on the way in, because it is read off a contract and typed by hand, and
   * `pru-88213` and `PRU-88213` are the same code to everybody except a unique index.
   * The pattern is deliberately loose — every insurer numbers its own way, and refusing
   * a real code because it does not match our idea of one is worse than storing it.
   */
  @ApiProperty({ example: 'PRU-88213', maxLength: 32 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[A-Z0-9][A-Z0-9./-]*$/, {
    message: 'agentCode may contain letters, digits, and . / - only',
  })
  agentCode!: string;
}

export class LoginDto {
  @ApiProperty({ example: 'owner@kpm0417.test' })
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'demo password 0417' })
  @IsString()
  password!: string;
}

export class RefreshDto {
  @ApiPropertyOptional({
    description:
      'Only for non-browser clients. A browser sends the httpOnly cookie set at login ' +
      'and should omit this entirely.',
  })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}

export class TokenDto {
  @ApiProperty({ description: 'Send as `Authorization: Bearer <token>`. Expires in 15 minutes.' })
  @IsString()
  token!: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ example: 'owner@kpm0417.test' })
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: 'From the password-reset email.' })
  @IsString()
  token!: string;

  @ApiProperty({ minLength: PasswordService.MIN_LENGTH })
  @IsString()
  @MinLength(PasswordService.MIN_LENGTH)
  newPassword!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  currentPassword!: string;

  @ApiProperty({ minLength: PasswordService.MIN_LENGTH })
  @IsString()
  @MinLength(PasswordService.MIN_LENGTH)
  newPassword!: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Rina Wijaya' })
  @IsOptional()
  @IsString()
  fullName?: string;

  @ApiPropertyOptional({ example: 'Rina' })
  @IsOptional()
  @IsString()
  preferredName?: string;

  @ApiPropertyOptional({
    enum: ['she', 'he', 'they'],
    description: 'Yours to set. It appears in the coaching commitment sentence your leader reads.',
  })
  @IsOptional()
  @IsEnum(['she', 'he', 'they'])
  pronoun?: 'she' | 'he' | 'they';
}

export class ImpersonateDto {
  @ApiProperty({ description: 'Recorded in the audit log. Required.', example: 'support ticket 42' })
  @IsString()
  @MinLength(3)
  reason!: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 60, default: 60 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  durationMinutes?: number;
}


/**
 * Approving a support session to write (P4-T10, §3.13).
 *
 * The reason is typed **again** rather than carried over from the session's own: the
 * approver is a different person answering a different question — not "why look at this
 * office" but "why is looking not enough". The office's Owner reads both.
 */
export class ElevateImpersonationDto {
  @ApiProperty({
    example: 'Their activity types were saved with a duplicate code and cannot be fixed from the screen.',
    minLength: 10,
    maxLength: 500,
  })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}
