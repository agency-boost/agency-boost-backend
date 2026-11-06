import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { isLanguage, type Language } from '@/domain/constants/language';
import { User, UserDocument } from '@/modules/users/user.schema';

/**
 * **The language a person's mail is written in** (P18.10-T5 AC-5; ADR-0179 §7): their saved `users.locale`, or `null`
 * for somebody who has chosen none. Read when an email is rendered — off the request that caused it, as the email
 * itself is sent — so a choice made since the notice was raised is the one the email follows.
 */
export abstract class RecipientLanguages {
  abstract languageOf(userId: string): Promise<Language | null>;
}

/** `users.locale`, by the person's id. `users` is platform-global: not a tenant-scoped read (as `UserAddressBook`). */
@Injectable()
export class UserLanguages extends RecipientLanguages {
  constructor(@InjectModel(User.name) private readonly users: Model<UserDocument>) {
    super();
  }

  async languageOf(userId: string): Promise<Language | null> {
    const user = await this.users.findById(userId).select('locale').exec();
    return isLanguage(user?.locale) ? user.locale : null;
  }
}
