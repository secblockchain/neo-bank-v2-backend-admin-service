import { RainUser, Subscription, Card, USER_SECRET_FIELDS } from '../models/domain.models';
import { escapeRegex, parseObjectId } from '../utils/query';
import { Types } from 'mongoose';

export async function globalSearch(rawQuery: string) {
  const query = rawQuery.trim();
  if (query.length < 2) {
    return { users: [], subscriptions: [], cards: [] };
  }

  const pattern = new RegExp(escapeRegex(query), 'i');
  const id = Types.ObjectId.isValid(query) ? parseObjectId(query) : null;

  const [users, subscriptions, cards] = await Promise.all([
    RainUser.find(
      id
        ? { $or: [{ _id: id }, { email: pattern }, { firstName: pattern }, { lastName: pattern }] }
        : {
            $or: [
              { email: pattern },
              { firstName: pattern },
              { lastName: pattern },
              { displayName: pattern },
            ],
          },
    )
      .select(USER_SECRET_FIELDS)
      .limit(10)
      .lean(),
    Subscription.find(
      id
        ? { $or: [{ _id: id }, { user_id: id }, { plan_display_name: pattern }] }
        : { plan_display_name: pattern },
    )
      .limit(10)
      .lean(),
    Card.find(
      id ? { $or: [{ _id: id }, { customerId: query }, { last4: query }] } : { last4: query },
    )
      .limit(10)
      .lean(),
  ]);

  return { users, subscriptions, cards };
}
