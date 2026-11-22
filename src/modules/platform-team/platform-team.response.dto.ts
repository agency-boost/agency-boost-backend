import { ApiProperty } from '@nestjs/swagger';

/** One Super Admin on *Tim Super Admin* (P19.23-T6 AC-2): who, how to reach them, and whether it is the reader. */
export class SuperAdminRowDto {
  @ApiProperty({ type: String })
  userId!: string;

  @ApiProperty({ type: String, example: 'Dina Kusuma' })
  fullName!: string;

  @ApiProperty({ type: String, example: 'dina@agencyboost.id' })
  email!: string;

  @ApiProperty({
    enum: ['invited', 'active', 'deactivated'],
    description: 'The account’s status. A deactivated Super Admin keeps the role and cannot sign in.',
  })
  status!: 'invited' | 'active' | 'deactivated';

  @ApiProperty({ type: Boolean, description: '*Anda*: the reader. Their own row has no *Cabut*.' })
  isYou!: boolean;
}
