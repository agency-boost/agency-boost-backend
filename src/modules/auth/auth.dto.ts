import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
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
  @ApiProperty({ description: 'The refresh token returned by /auth/login.' })
  @IsString()
  refreshToken!: string;
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
