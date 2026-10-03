import { ApiProperty } from '@nestjs/swagger';
import { INBOX_PAGE } from '@/domain/constants';
import type { InboxItem, Inbox, NotificationReadState, UnreadCount } from './notification.service';

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
    description:
      'Where the item opens, in the app: a finalized coaching session on that session, a calendar notice on its '
      + 'entry or its week. `null` for an item with nowhere to go, which opens in a box on the screen.',
  })
  href!: string | null;

  @ApiProperty({ type: String, nullable: true })
  kpmId!: string | null;

  @ApiProperty({ type: String })
  createdAt!: string;

  @ApiProperty({ type: String, nullable: true })
  readAt!: string | null;

}

/** One page of the reader's own inbox (P12.1-T4). */
export class InboxDto implements Inbox {
  @ApiProperty({ type: () => InboxItemDto, isArray: true, description: 'This page, newest first.' })
  items!: InboxItem[];

  @ApiProperty({ type: Number, description: 'Unread in the whole inbox, not on this page.' })
  unread!: number;

  @ApiProperty({ type: Number, description: 'Items in the whole inbox.' })
  total!: number;

  @ApiProperty({ type: Number, minimum: 1, description: 'The page answered, from 1.' })
  page!: number;

  @ApiProperty({ type: Number, minimum: 1, maximum: INBOX_PAGE.MAX_SIZE, description: 'Items per page.' })
  pageSize!: number;
}

/** One notification marked read or unread, with the inbox's unread count after it (P12.1-T4). */
export class NotificationReadStateDto implements NotificationReadState {
  @ApiProperty({ type: String })
  notificationId!: string;

  @ApiProperty({
    type: String, nullable: true, format: 'date-time',
    description: 'When it was first read; `null` when it is unread.',
  })
  readAt!: string | null;

  @ApiProperty({ type: Number, description: 'Unread in the whole inbox, after this mark.' })
  unread!: number;
}

/** The inbox's unread count after *Mark all read* (P12.1-T4). */
export class UnreadCountDto implements UnreadCount {
  @ApiProperty({
    type: Number, example: 0,
    description: '`0`, unless a notification arrived between the write and the count.',
  })
  unread!: number;
}
