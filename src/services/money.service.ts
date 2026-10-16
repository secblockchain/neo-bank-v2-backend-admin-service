import { FilterQuery, Model, Types } from 'mongoose';
import {
  Card,
  Charge,
  LooseDoc,
  PayPalOrder,
  RainUser,
  StripePayment,
  WertTransaction,
  docId,
} from '../models/domain.models';
import { ApiError } from '../utils/ApiError';
import { createdAtRangeFilter, mergeFilters } from '../utils/dateFilter';
import { enrichWithUserDisplay } from '../utils/enrichUsers';
import { escapeRegex, parseObjectId } from '../utils/query';

export type TransactionRail = 'charge' | 'stripe' | 'paypal' | 'wert' | 'all';

type UnifiedRow = Record<string, unknown> & {
  id: string;
  rail: Exclude<TransactionRail, 'all'>;
  amount: number | null;
  currency: string | null;
  status: string | null;
  createdAt: Date | string | null;
  userId: string | null;
};

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  return null;
}

function pickAmount(row: Record<string, unknown>): number | null {
  // Prefer fiat / USD display amount; fall back to SEP when that's all we have.
  return (
    asNumber(row.amount) ??
    asNumber(row.amountUsd) ??
    asNumber(row.baseCurrencyAmount) ??
    asNumber(row.usd_amount) ??
    asNumber(row.usdAmount) ??
    asNumber(row.total) ??
    asNumber(row.value) ??
    asNumber(row.grossAmount) ??
    asNumber(row.chargeAmount) ??
    asNumber(row.sepAmount) ??
    asNumber(row.sep_amount)
  );
}

function pickCurrency(row: Record<string, unknown>): string | null {
  const raw =
    row.currency ??
    row.baseCurrency ??
    row.currencyCode ??
    row.currency_code;
  if (typeof raw === 'string' && raw.trim()) return raw.trim().toUpperCase();
  // Infer from which amount field we resolved
  if (
    asNumber(row.amountUsd) != null ||
    asNumber(row.baseCurrencyAmount) != null ||
    asNumber(row.usd_amount) != null ||
    asNumber(row.usdAmount) != null
  ) {
    return 'USD';
  }
  if (asNumber(row.sepAmount) != null || asNumber(row.sep_amount) != null) {
    return 'SEP';
  }
  return null;
}

function pickStatus(row: Record<string, unknown>): string | null {
  const raw = row.status ?? row.state ?? row.paymentStatus;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function pickCreated(row: Record<string, unknown>): Date | string | null {
  const raw = row.createdAt ?? row.created_at ?? row.paidAt ?? row.updatedAt;
  if (raw instanceof Date) return raw;
  if (typeof raw === 'string' || typeof raw === 'number') return new Date(raw);
  return null;
}

function pickUserId(row: Record<string, unknown>): string | null {
  for (const key of ['userId', 'user_id', 'customerId', 'rainUser', 'user']) {
    const id = docId(row[key]);
    if (id) return id;
  }
  return null;
}

function normalizeRow(
  rail: Exclude<TransactionRail, 'all'>,
  row: Record<string, unknown>,
): UnifiedRow {
  const id = docId(row._id) || docId(row.id) || `${rail}-${Math.random()}`;
  return {
    ...row,
    id: `${rail}:${id}`,
    sourceId: id,
    rail,
    amount: pickAmount(row),
    currency: pickCurrency(row),
    status: pickStatus(row),
    createdAt: pickCreated(row),
    userId: pickUserId(row),
  };
}

async function loadRail(
  model: Model<LooseDoc>,
  rail: Exclude<TransactionRail, 'all'>,
  filter: FilterQuery<LooseDoc>,
  limit: number,
): Promise<UnifiedRow[]> {
  const items = await model.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  return (items as Record<string, unknown>[]).map((row) => normalizeRow(rail, row));
}

function userFilter(query: Record<string, unknown>): FilterQuery<LooseDoc> {
  const filter: FilterQuery<LooseDoc> = {};
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  if (!userId) return filter;
  const or: FilterQuery<LooseDoc>[] = [
    { userId },
    { user_id: userId },
    { customerId: userId },
  ];
  if (Types.ObjectId.isValid(userId)) {
    const oid = parseObjectId(userId, 'user id');
    or.push({ userId: oid }, { user_id: oid }, { customerId: oid }, { rainUser: oid });
  }
  filter.$or = or;
  return filter;
}

function statusFilter(
  base: FilterQuery<LooseDoc>,
  query: Record<string, unknown>,
): FilterQuery<LooseDoc> {
  if (typeof query.status === 'string' && query.status.trim()) {
    return { ...base, status: query.status.trim() };
  }
  return base;
}

function searchFilter(
  base: FilterQuery<LooseDoc>,
  query: Record<string, unknown>,
  fields: string[],
): FilterQuery<LooseDoc> {
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (!search) return base;
  const pattern = new RegExp(escapeRegex(search), 'i');
  const or = fields.map((field) => ({ [field]: pattern }));
  if (base.$or) {
    return { $and: [base, { $or: or }] };
  }
  return { ...base, $or: or };
}

async function statusCounts(model: Model<LooseDoc>, base: FilterQuery<LooseDoc>) {
  const rows = await model.aggregate<{ _id: string | null; count: number }>([
    ...(Object.keys(base).length ? [{ $match: base }] : []),
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id ?? 'unknown', r.count]));
}

export async function getTransactionAnalytics(query: Record<string, unknown> = {}) {
  const base = mergeFilters(userFilter(query), createdAtRangeFilter(query));
  const [charges, stripe, paypal, wert, chargeStatus, stripeStatus, paypalStatus, wertStatus] =
    await Promise.all([
      Charge.countDocuments(base),
      StripePayment.countDocuments(base),
      PayPalOrder.countDocuments(base),
      WertTransaction.countDocuments(base),
      statusCounts(Charge, base),
      statusCounts(StripePayment, base),
      statusCounts(PayPalOrder, base),
      statusCounts(WertTransaction, base),
    ]);

  const byStatus: Record<string, number> = {};
  for (const map of [chargeStatus, stripeStatus, paypalStatus, wertStatus]) {
    for (const [key, count] of Object.entries(map)) {
      byStatus[key] = (byStatus[key] ?? 0) + count;
    }
  }

  return {
    total: charges + stripe + paypal + wert,
    byRail: { charge: charges, stripe, paypal, wert },
    byStatus,
  };
}

export async function listTransactions(
  query: Record<string, unknown>,
  skip: number,
  limit: number,
) {
  const railParam = typeof query.rail === 'string' ? query.rail.trim().toLowerCase() : 'all';
  const rail = (
    ['charge', 'stripe', 'paypal', 'wert', 'all'].includes(railParam) ? railParam : 'all'
  ) as TransactionRail;

  const fetchCap = Math.min(500, skip + limit + 50);
  const base = mergeFilters(
    statusFilter(userFilter(query), query),
    createdAtRangeFilter(query),
  );

  const loaders: Promise<UnifiedRow[]>[] = [];
  if (rail === 'all' || rail === 'charge') {
    loaders.push(
      loadRail(
        Charge,
        'charge',
        searchFilter(base, query, ['status', 'type', 'description', 'txHash', 'hash']),
        fetchCap,
      ),
    );
  }
  if (rail === 'all' || rail === 'stripe') {
    loaders.push(
      loadRail(
        StripePayment,
        'stripe',
        searchFilter(base, query, ['status', 'paymentIntentId', 'sessionId', 'email']),
        fetchCap,
      ),
    );
  }
  if (rail === 'all' || rail === 'paypal') {
    loaders.push(
      loadRail(
        PayPalOrder,
        'paypal',
        searchFilter(base, query, ['status', 'orderId', 'paypalOrderId', 'email']),
        fetchCap,
      ),
    );
  }
  if (rail === 'all' || rail === 'wert') {
    loaders.push(
      loadRail(
        WertTransaction,
        'wert',
        searchFilter(base, query, ['status', 'orderId', 'clickId', 'email']),
        fetchCap,
      ),
    );
  }

  const batches = await Promise.all(loaders);
  const merged = batches
    .flat()
    .sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt as string | Date).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt as string | Date).getTime() : 0;
      return tb - ta;
    });

  const total = merged.length;
  const slice = merged.slice(skip, skip + limit);
  const items = await enrichWithUserDisplay(slice, ['userId', 'user_id', 'customerId', 'rainUser']);

  return { items, total };
}

export async function getTransaction(compositeId: string) {
  const [rail, ...rest] = compositeId.split(':');
  const sourceId = rest.join(':');
  if (!rail || !sourceId) throw new ApiError(400, 'Invalid transaction id.');

  const modelMap: Record<string, Model<LooseDoc>> = {
    charge: Charge,
    stripe: StripePayment,
    paypal: PayPalOrder,
    wert: WertTransaction,
  };
  const model = modelMap[rail];
  if (!model) throw new ApiError(400, `Unknown transaction rail: ${rail}`);

  const doc = await model.findById(parseObjectId(sourceId, 'transaction id')).lean();
  if (!doc) throw new ApiError(404, 'Transaction not found.');
  const row = normalizeRow(rail as Exclude<TransactionRail, 'all'>, doc as Record<string, unknown>);
  const [enriched] = await enrichWithUserDisplay([row], ['userId', 'customerId', 'rainUserId']);
  return enriched ?? row;
}

export async function exportTransactionsCsv(query: Record<string, unknown>) {
  const { items } = await listTransactions(query, 0, 500);
  const header = ['id', 'rail', 'amount', 'currency', 'status', 'userId', 'createdAt'];
  const lines = [header.join(',')];
  for (const row of items) {
    const values = [
      row.id,
      row.rail,
      row.amount ?? '',
      row.currency ?? '',
      row.status ?? '',
      row.userId ?? '',
      row.createdAt ? new Date(row.createdAt as string | Date).toISOString() : '',
    ].map((value) => {
      const text = String(value).replace(/"/g, '""');
      return `"${text}"`;
    });
    lines.push(values.join(','));
  }
  return lines.join('\n');
}

export async function listAccounts(query: Record<string, unknown>, skip: number, limit: number) {
  const filter: FilterQuery<LooseDoc> = mergeFilters(
    {
      rainExternalUserId: { $exists: true, $nin: [null, ''] },
    },
    createdAtRangeFilter(query),
  );
  if (typeof query.accountKind === 'string' && query.accountKind.trim()) {
    filter.accountKind = query.accountKind.trim();
  }
  if (typeof query.status === 'string' && query.status.trim()) {
    filter.accountStatus = query.status.trim();
  }
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = [
      { email: pattern },
      { firstName: pattern },
      { lastName: pattern },
      { displayName: pattern },
      { rainExternalUserId: pattern },
    ];
  }
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  if (userId && Types.ObjectId.isValid(userId)) {
    filter._id = parseObjectId(userId, 'user id');
  }

  const [total, users] = await Promise.all([
    RainUser.countDocuments(filter),
    RainUser.find(filter)
      .select('-password -totpSecret -totpSecretIv -totpPendingSecret -totpPendingSecretIv -twoFactorCode -totpBackupCodes')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const userIds = users.map((u) => String(u._id));
  const cardCounts = await Promise.all(
    userIds.map(async (id) => {
      const count = await Card.countDocuments({
        $or: [{ rainUserId: id }, { customerId: id }, { userId: id }, { rainUser: id }],
      });
      return [id, count] as const;
    }),
  );
  const countMap = new Map(cardCounts);

  const items = users.map((user) => {
    const row = user as Record<string, unknown>;
    const id = String(user._id);
    return {
      id,
      userId: id,
      email: row.email ?? null,
      displayName:
        typeof row.displayName === 'string'
          ? row.displayName
          : `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim() || null,
      accountKind: row.accountKind ?? null,
      accountStatus: row.accountStatus ?? 'active',
      rainExternalUserId: row.rainExternalUserId ?? null,
      issuerCountry: row.issuerCountry ?? null,
      cardCount: countMap.get(id) ?? 0,
      createdAt: row.createdAt ?? null,
      rail: 'rain',
      type: 'issuing_identity',
    };
  });

  return { items, total };
}

export async function getAccount(userId: string) {
  const user = await RainUser.findById(parseObjectId(userId, 'user id'))
    .select(
      'email firstName lastName displayName phoneNumber country accountKind accountStatus issuerCountry rainExternalUserId isEmailVerified twoFactorEnabled userGroup referalCode referredBy createdAt updatedAt',
    )
    .lean();
  if (!user) throw new ApiError(404, 'Account not found.');
  const cards = await Card.find({
    $or: [
      { rainUserId: userId },
      { customerId: userId },
      { userId },
      { rainUser: parseObjectId(userId, 'user id') },
    ],
  })
    .limit(50)
    .lean();
  const row = user as Record<string, unknown>;
  return {
    id: String(user._id),
    userId: String(user._id),
    type: 'issuing_identity',
    rail: 'rain',
    email: row.email ?? null,
    firstName: row.firstName ?? null,
    lastName: row.lastName ?? null,
    displayName:
      typeof row.displayName === 'string'
        ? row.displayName
        : `${row.firstName ?? ''} ${row.lastName ?? ''}`.trim() || null,
    phoneNumber: row.phoneNumber ?? null,
    country: row.country ?? null,
    accountKind: row.accountKind ?? null,
    accountStatus: row.accountStatus ?? 'active',
    issuerCountry: row.issuerCountry ?? null,
    rainExternalUserId: row.rainExternalUserId ?? null,
    isEmailVerified: Boolean(row.isEmailVerified),
    twoFactorEnabled: Boolean(row.twoFactorEnabled),
    userGroup: row.userGroup ?? null,
    referralCode: row.referalCode ?? null,
    referredBy: row.referredBy ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    cards: cards.map((card) => {
      const c = card as Record<string, unknown>;
      return {
        id: String(c._id ?? c.id ?? ''),
        status: c.status ?? null,
        type: c.type ?? null,
        last4: c.last4 ?? c.last_4 ?? null,
        createdAt: c.createdAt ?? null,
      };
    }),
    cardCount: cards.length,
  };
}

export async function listTransfers(query: Record<string, unknown>, skip: number, limit: number) {
  const { RainTransfer } = await import('../models/domain.models');
  const filter: FilterQuery<LooseDoc> = { ...createdAtRangeFilter(query) };
  if (typeof query.status === 'string' && query.status.trim()) filter.status = query.status.trim();
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  if (userId) {
    filter.$or = [{ userId }, { customerId: userId }, { rainUserId: userId }];
    if (Types.ObjectId.isValid(userId)) {
      filter.$or.push({ userId: parseObjectId(userId, 'user id') });
    }
  }

  try {
    const [total, items] = await Promise.all([
      RainTransfer.countDocuments(filter),
      RainTransfer.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);
    if (total > 0) {
      return {
        items: await enrichWithUserDisplay(items as Record<string, unknown>[], [
          'userId',
          'customerId',
          'rainUserId',
        ]),
        total,
      };
    }
  } catch {
    /* collection may not exist yet */
  }

  // Fallback: charges that look like money movement
  const chargeFilter: FilterQuery<LooseDoc> = {
    ...userFilter(query),
    $or: [
      { type: /transfer|withdraw|deposit|ach|wire/i },
      { description: /transfer|withdraw|deposit|ach|wire/i },
      { category: /transfer|payout/i },
    ],
  };
  if (typeof query.status === 'string' && query.status.trim()) {
    chargeFilter.status = query.status.trim();
  }
  const [total, items] = await Promise.all([
    Charge.countDocuments(chargeFilter),
    Charge.find(chargeFilter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  const normalized = (items as Record<string, unknown>[]).map((row) => ({
    ...normalizeRow('charge', row),
    kind: 'charge_fallback',
  }));
  return {
    items: await enrichWithUserDisplay(normalized, ['userId', 'user_id', 'customerId']),
    total,
  };
}

export async function getTransfer(id: string) {
  const { RainTransfer } = await import('../models/domain.models');
  try {
    const doc = await RainTransfer.findById(parseObjectId(id, 'transfer id')).lean();
    if (doc) return doc;
  } catch {
    /* ignore */
  }
  return getTransaction(id.includes(':') ? id : `charge:${id}`);
}

export async function listStatements(query: Record<string, unknown>, skip: number, limit: number) {
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  const now = new Date();
  const periods: Record<string, unknown>[] = [];
  for (let i = 0; i < 24; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    periods.push({
      id: `${year}-${String(month).padStart(2, '0')}`,
      year,
      month,
      label: d.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      userId: userId || null,
      available: true,
      source: 'rain',
    });
  }

  let filtered = periods;
  if (typeof query.year === 'string' && query.year.trim()) {
    const year = Number(query.year);
    filtered = filtered.filter((p) => p.year === year);
  }

  if (userId && Types.ObjectId.isValid(userId)) {
    const user = await RainUser.findById(parseObjectId(userId, 'user id'))
      .select('email firstName lastName displayName rainExternalUserId createdAt')
      .lean();
    if (user) {
      const created = user.createdAt ? new Date(user.createdAt as Date) : null;
      if (created) {
        filtered = filtered.filter((p) => {
          const periodStart = new Date(Date.UTC(p.year as number, (p.month as number) - 1, 1));
          return periodStart >= new Date(Date.UTC(created.getUTCFullYear(), created.getUTCMonth(), 1));
        });
      }
      filtered = filtered.map((p) => ({
        ...p,
        userEmail: user.email,
        rainExternalUserId: user.rainExternalUserId ?? null,
      }));
    }
  }

  const total = filtered.length;
  return { items: filtered.slice(skip, skip + limit), total };
}

export async function getStatementMeta(year: number, month: number, userId?: string) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new ApiError(400, 'Invalid year.');
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new ApiError(400, 'Invalid month.');
  }
  let user: Record<string, unknown> | null = null;
  if (userId && Types.ObjectId.isValid(userId)) {
    user = (await RainUser.findById(parseObjectId(userId, 'user id'))
      .select('email firstName lastName rainExternalUserId')
      .lean()) as Record<string, unknown> | null;
    if (!user) throw new ApiError(404, 'User not found.');
  }
  return {
    id: `${year}-${String(month).padStart(2, '0')}`,
    year,
    month,
    userId: userId || null,
    user,
    downloadAvailable: Boolean(user?.rainExternalUserId),
    note: 'PDF download is proxied via Rain when US_PROVIDER_BASE_URL is configured.',
  };
}
