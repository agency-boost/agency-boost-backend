import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { INBOX_PAGE } from '@/domain/constants';
import { NotificationService } from './notification.service';

/**
 * `GET /notifications?page=&pageSize=` (P12.1-T4). Both optional; any other parameter is refused by
 * name, by the global pipe's `forbidNonWhitelisted`.
 */
export class InboxQueryDto {
  @ApiPropertyOptional({ type: Number, minimum: 1, default: 1, description: 'Which page, from 1.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    type: Number, minimum: 1, maximum: INBOX_PAGE.MAX_SIZE, default: INBOX_PAGE.DEFAULT_SIZE,
    description: 'Items per page.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(INBOX_PAGE.MAX_SIZE)
  pageSize?: number;
}

/**
 * A person's own notifications.
 *
 * `notifications` belongs to a **person**, not to a tenant: `kpmId` is nullable because
 * email verification and password reset are sent before anybody has joined an office.
 * Every route here reads `ctx.userId` and nothing else — there is no id a caller can
 * supply to reach somebody else's inbox, which is why the isolation test asserts the
 * absence of a door rather than that a door is locked.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @RequirePermission('notification:read_inbox')
  @ApiOperation({
    summary: 'One page of your notifications, newest first',
    description:
      'With the unread count of the whole inbox, so the nav badge and the list can never disagree — ' +
      'they come from one read rather than two — and the total, for the pager.',
  })
  async inbox(@Ctx() ctx: RequestContext, @Query() query: InboxQueryDto) {
    return this.notifications.inbox(ctx, query.page, query.pageSize);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('notification:mark_read')
  @ApiOperation({ summary: 'Mark everything read', description: 'Answers the unread count it leaves.' })
  async readAll(@Ctx() ctx: RequestContext) {
    return this.notifications.markAllRead(ctx);
  }

  @Post(':notificationId/read')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('notification:mark_read')
  @ApiOperation({
    summary: 'Mark one read',
    description:
      'A notification that is not yours is a 404, never a 403 — a 403 would confirm it exists. ' +
      'Marking one that is already read settles rather than complains, and keeps when it was first read.',
  })
  async read(@Ctx() ctx: RequestContext, @Param('notificationId') notificationId: string) {
    return this.notifications.markRead(ctx, notificationId);
  }

  @Post(':notificationId/unread')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('notification:mark_read')
  @ApiOperation({
    summary: 'Mark one unread',
    description:
      'It counts on the badge again until it is read. A notification that is not yours is a 404, never ' +
      'a 403; marking one that is already unread settles rather than complains.',
  })
  async unread(@Ctx() ctx: RequestContext, @Param('notificationId') notificationId: string) {
    return this.notifications.markUnread(ctx, notificationId);
  }
}
