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

