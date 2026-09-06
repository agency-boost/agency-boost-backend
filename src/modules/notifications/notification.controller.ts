import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Ctx, RequirePermission } from '@/common/auth/auth.decorators';
import { RequestContext } from '@/common/context/request-context';
import { NotificationService } from './notification.service';

export class InboxQueryDto {
  @ApiPropertyOptional({ example: 50, minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
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
    summary: 'Your notifications, newest first',
    description:
      'With the unread count, so the nav badge and the list can never disagree — they come from one ' +
      'read rather than two.',
  })
  async inbox(@Ctx() ctx: RequestContext, @Query() query: InboxQueryDto) {
    return this.notifications.inbox(ctx, query.limit);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('notification:mark_read')
  @ApiOperation({ summary: 'Mark everything read' })
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
      'Marking one that is already read settles rather than complains.',
  })
  async read(@Ctx() ctx: RequestContext, @Param('notificationId') notificationId: string) {
    return this.notifications.markRead(ctx, notificationId);
  }
}
