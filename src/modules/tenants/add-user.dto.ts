import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean, IsEmail, IsMongoId, IsOptional, IsString, Matches, MaxLength, MinLength, ValidateNested,
} from 'class-validator';
import { field } from '@/common/validation/violations';
import { INVITES } from '@/domain/constants';
import { ADD_USER_REFUSALS } from './add-user.messages';

const SAY = ADD_USER_REFUSALS.VALIDATION_FAILED;
/** What a person types for a WhatsApp number: digits, spaces and dashes, a `+` in front at most (`normalisePhone` decides). */
const PHONE_SHAPE = /^\+?\d[\d -]{7,22}$/;
const trimmed = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** An empty email is no email: the field is optional on the sheet. */
const emailOrNothing = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const t = value.trim().toLowerCase();
  return t === '' ? undefined : t;
};

/** ***＋ KPM baru*** inline (P19.28-T1 AC-3): the branch name and the company; the code is made automatically. */
export class NewKpmInlineDto {
  @ApiProperty({ example: 'Bintaro Branch', maxLength: 120 })
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  branchName!: string;

  @ApiProperty({ description: 'The company (`companies._id`) whose template the KPM is made from.' })
  @IsMongoId()
  companyId!: string;
}

/** What *Tambah user* and *Masukkan* both say about where the person goes. */
class PlacementFields {
  @ApiPropertyOptional({
    description: 'The KPM. The Super Admin names any; an Owner or a KPM Admin their own (another is `404`). Absent with '
      + '`newKpm`, or for an Owner or an Admin, whose KPM it is.',
  })
  @IsOptional()
  @IsMongoId()
  kpmId?: string;

  @ApiPropertyOptional({
    type: NewKpmInlineDto,
    description: '*＋ KPM baru* (the Super Admin’s alone, `kpm:create`): the KPM is made from its company’s template, '
      + 'the person placed on its senior rung with no leader, and made its first owner — in one step, nothing left on '
      + 'a failure.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => NewKpmInlineDto)
  newKpm?: NewKpmInlineDto;

  @ApiPropertyOptional({
    example: 'AGENT',
    description: '*Peran*: a rung code of the KPM’s company ladder. Required with `kpmId`; ignored with `newKpm`, which '
      + 'is always the senior rung.',
  })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(32)
  role?: string;

  @ApiPropertyOptional({
    description: '*Leader*: an active AB or AAB of the KPM (`memberships._id`). Required for a rung that is not the '
      + 'senior one; refused for an AB.',
  })
  @IsOptional()
  @IsMongoId()
  leaderMembershipId?: string;

  @ApiPropertyOptional({
    description: '*Jadikan KPM Owner*, off by default. The Super Admin or an owner of the KPM; a KPM Admin is `403`. '
      + 'Always on with `newKpm`.',
  })
  @IsOptional()
  @IsBoolean()
  makeOwner?: boolean;
}

/** ***Tambah user*** (P19.28-T1 AC-1): a person who is not in this KPM yet, invited to it. */
export class AddUserDto extends PlacementFields {
  @ApiProperty({ example: 'Rina Kartika', maxLength: INVITES.NAME_MAX })
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(INVITES.NAME_MAX)
  fullName!: string;

  @ApiProperty({
    example: '0812-7788-4410',
    description: '*Nomor WhatsApp*, as typed after the fixed `+62`: a leading `0`, `62` or `+62`, spaces and dashes go '
      + '(`normalisePhone`); 9 to 13 digits stay. Stored `+62…`.',
  })
  @Transform(trimmed)
  @IsString()
  @Matches(PHONE_SHAPE, { message: field(SAY.phone) })
  phone!: string;

  @ApiPropertyOptional({ example: 'rina@email.com', description: '*Email · opsional*.' })
  @IsOptional()
  @Transform(emailOrNothing)
  @IsEmail()
  @MaxLength(254)
  email?: string;
}

/** ***Masukkan ke KPM*** (P19.28-T1 AC-2): an account that exists and is in no KPM, placed. */
export class PlaceUserDto extends PlacementFields {}

/** *Pilih KPM*'s next step: the ladder and the leaders of the chosen KPM. */
export class AddUserOptionsQueryDto {
  @ApiPropertyOptional({ description: 'The KPM. The Super Admin names any; an Owner or an Admin reads their own.' })
  @IsOptional()
  @IsMongoId()
  kpmId?: string;

  @ApiPropertyOptional({ description: 'A company with no KPM yet (*＋ KPM baru*): its ladder alone, no leaders.' })
  @IsOptional()
  @IsMongoId()
  companyId?: string;
}
