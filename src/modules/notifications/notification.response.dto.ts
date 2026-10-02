import { ApiProperty } from '@nestjs/swagger';
import type { InboxItem, Inbox } from './notification.service';

/**
 * The inbox's response shapes. Each `implements` what the service returns — see
 * `tenants/tenant.response.dto.ts` for why that matters.
 */
export class InboxItemDto implements InboxItem {
  @ApiProperty({ type: String })
  notificationId!: string;

  @ApiProperty({ type: String })
  templateId!: string;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String, nullable: true })
  detail!: string | null;

  @ApiProperty({
    type: String, nullable: true, example: '/coaching/me?session=66f0000000000000000000d1',
    description: 'Where the item opens, in the app: a finalized coaching session opens on that session. `null` for every other item.',
  })
  href!: string | null;

  @ApiProperty({ type: String, nullable: true })
  kpmId!: string | null;

  @ApiProperty({ type: String })
  createdAt!: string;

  @ApiProperty({ type: String, nullable: true })
  readAt!: string | null;

}

export class InboxDto implements Inbox {
  @ApiProperty({ type: () => InboxItemDto, isArray: true })
  items!: InboxItem[];

  @ApiProperty({ type: Number })
  unread!: number;

}

