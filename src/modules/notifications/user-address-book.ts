import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from '@/modules/users/user.schema';
import { RecipientAddressBook } from './smtp.adapter';

/**
 * Where a person's mail goes.
 *
 * The notification service addresses people by `userId` — it has to, because email
 * verification and password reset are sent before anybody has joined an office, so there
 * is no membership to read a name off. This turns that id into an address at the moment
 * of sending rather than carrying one around in a payload, so a message is delivered to
 * the address the account has **now** and a changed address is not sent to the old one.
 *
 * `users` is platform-global: this is not a tenant-scoped read and needs no repository.
 */
@Injectable()
export class UserAddressBook extends RecipientAddressBook {
  constructor(@InjectModel(User.name) private readonly users: Model<UserDocument>) {
    super();
  }

  async addressOf(userId: string): Promise<string | null> {
    const user = await this.users.findById(userId).select('email deletedAt').exec();
    // A deleted account keeps its row for the audit trail. It does not keep its mail.
    if (!user || user.deletedAt) return null;
    return user.email;
  }
}
