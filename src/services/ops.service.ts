import { FilterQuery, Types } from 'mongoose';
import { FeatureFlag, FraudCase } from '../models/admin.models';
import {
  Card,
  Charge,
  LooseDoc,
  MultichainsWallet,
  Notification,
  PayPalOrder,
  RainDispute,
  RainKyb,
  RainKyc,
  RainUser,
  SavingsPlan,
  StakingPosition,
  StripePayment,
  Subscription,
  SupportTicket,
  SwapTransaction,
  WalletServerTransaction,
  WalletTransaction,
  WertTransaction,
  USER_SECRET_FIELDS,
  docId,
} from '../models/domain.models';
import { ApiError } from '../utils/ApiError';
import { collectionExists } from '../utils/collectionExists';
import { createdAtRangeFilter, mergeFilters } from '../utils/dateFilter';
import { enrichWithUserDisplay } from '../utils/enrichUsers';
import { escapeRegex, parseObjectId } from '../utils/query';
import { Actor, recordAudit } from './audit.service';
import {
  explorerSupportsChain,
  fetchTransactionsForWallets,
  type ExplorerTx,
} from './cryptoExplorer.service';
import { fetchBalancesBatched, fetchBalancesForChains } from './walletBalances.service';

async function safePage(
  model: { countDocuments: Function; find: Function },
  filter: FilterQuery<LooseDoc>,
  skip: number,
  limit: number,
) {
  try {
    const [total, items] = await Promise.all([
      model.countDocuments(filter),
      model.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);
    return { items: items as object[], total: total as number };
  } catch {
    return { items: [] as object[], total: 0 };
  }
}

function userOrFilter(userId: string): FilterQuery<LooseDoc> {
  const or: FilterQuery<LooseDoc>[] = [
    { userId },
    { user_id: userId },
    { customerId: userId },
    { rainUserId: userId },
    { ownerId: userId },
  ];
  if (Types.ObjectId.isValid(userId)) {
    const oid = parseObjectId(userId, 'user id');
    or.push({ userId: oid }, { rainUser: oid }, { ownerId: oid }, { user: oid });
  }
  return { $or: or };
}

function walletQueryFilter(query: Record<string, unknown>): FilterQuery<LooseDoc> {
  const parts: FilterQuery<LooseDoc>[] = [createdAtRangeFilter(query)];
  const status = typeof query.status === 'string' ? query.status.trim() : '';
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (status) parts.push({ status });
  if (userId) parts.push(userOrFilter(userId));
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    parts.push({
      $or: [
        { address: pattern },
        { walletAddress: pattern },
        { chain: pattern },
        { email: pattern },
      ],
    });
  }
  return mergeFilters(...parts);
}

/**
 * Used only when `multichainswallets` does not exist.
 * userId, status, search, and the date range stay on the query.
 */
async function listUnprovisionedWalletProxies(
  query: Record<string, unknown>,
  skip: number,
  limit: number,
) {
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  const status = typeof query.status === 'string' ? query.status.trim() : '';
  if (userId && !Types.ObjectId.isValid(userId)) {
    return { items: [], total: 0 };
  }

  const parts: FilterQuery<LooseDoc>[] = [createdAtRangeFilter(query)];
  if (userId) parts.push({ _id: parseObjectId(userId, 'user id') });
  if (status) parts.push({ accountStatus: status });
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    parts.push({
      $or: [
        { email: pattern },
        { firstName: pattern },
        { lastName: pattern },
        { displayName: pattern },
      ],
    });
  }

  const userFilter = mergeFilters(...parts);
  const [total, users] = await Promise.all([
    RainUser.countDocuments(userFilter),
    RainUser.find(userFilter)
      .select(
        'email firstName lastName displayName rainExternalUserId accountKind accountStatus createdAt',
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);
  return {
    total,
    items: users.map((u) => ({
      id: String(u._id),
      userId: String(u._id),
      email: u.email,
      displayName: u.displayName ?? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(),
      rainExternalUserId: u.rainExternalUserId ?? null,
      accountKind: u.accountKind,
      accountStatus: u.accountStatus ?? null,
      type: 'user_wallet_proxy',
      provisioned: false,
      chains: [],
      createdAt: u.createdAt,
    })),
  };
}

export async function listWallets(query: Record<string, unknown>, skip: number, limit: number) {
  if (!(await collectionExists(MultichainsWallet))) {
    return listUnprovisionedWalletProxies(query, skip, limit);
  }

  const filter = walletQueryFilter(query);
  const [total, docs] = await Promise.all([
    MultichainsWallet.countDocuments(filter),
    MultichainsWallet.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  const sanitized = (docs as Record<string, unknown>[]).map(sanitizeWalletSummary);
  return {
    total,
    items: await enrichWithUserDisplay(sanitized, ['userId', 'ownerId', 'customerId']),
  };
}

const WALLET_SENSITIVE_ROOT = new Set([
  'mnemonic',
  'twoFactorCode',
  'twoFactorCodeExpiry',
  'lastOtpSentAt',
]);

function sumLockEntries(entries: unknown): number {
  if (!Array.isArray(entries)) return 0;
  return entries.reduce((sum: number, entry) => {
    if (!entry || typeof entry !== 'object') return sum;
    const amount = (entry as { amount?: unknown }).amount;
    const n = typeof amount === 'number' ? amount : Number(amount);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
}

function sanitizeChainEntry(chainId: string, raw: unknown) {
  if (!raw || typeof raw !== 'object') return null;
  const chain = raw as Record<string, unknown>;
  const defaultAccount =
    chain.defaultAccount && typeof chain.defaultAccount === 'object'
      ? (chain.defaultAccount as Record<string, unknown>)
      : null;
  const extraAccounts = Array.isArray(chain.extraAccounts)
    ? (chain.extraAccounts as Record<string, unknown>[]).map((acc) => ({
        address: typeof acc.address === 'string' ? acc.address : null,
        publicKey: typeof acc.publicKey === 'string' ? acc.publicKey : null,
        isDefault: Boolean(acc.isDefault),
        label: typeof acc.label === 'string' ? acc.label : null,
      }))
    : [];

  const adminLocked = sumLockEntries(chain.lockAmountEntries);
  const subscriptionLocked = sumLockEntries(chain.subscriptionLockAmountEntries);
  const competitionLocked = sumLockEntries(chain.competitionLockAmountEntries);
  const lottery26Locked = sumLockEntries(chain.lottery26Entries);
  const totalLocked = adminLocked + subscriptionLocked + competitionLocked + lottery26Locked;

  return {
    chainId: Number(chain.chainId ?? chainId) || Number(chainId) || 0,
    chainKey: String(chainId),
    isTestnet: Boolean(chain.isTestnet),
    address: typeof defaultAccount?.address === 'string' ? defaultAccount.address : null,
    publicKey: typeof defaultAccount?.publicKey === 'string' ? defaultAccount.publicKey : null,
    label: typeof defaultAccount?.label === 'string' ? defaultAccount.label : null,
    extraAccounts,
    isWithdrawalAllowed:
      typeof chain.isWithdrawalAllowed === 'boolean' ? chain.isWithdrawalAllowed : null,
    isSoulboundNFTMinted:
      typeof chain.isSoulboundNFTMinted === 'boolean' ? chain.isSoulboundNFTMinted : null,
    isAmountLockedByAdmin:
      typeof chain.isAmountLockedByAdmin === 'boolean' ? chain.isAmountLockedByAdmin : null,
    locks: {
      admin: adminLocked,
      subscription: subscriptionLocked,
      competition: competitionLocked,
      lottery26: lottery26Locked,
      total: totalLocked,
    },
  };
}

function sanitizedChains(wallet: Record<string, unknown>) {
  const chainsRaw = wallet.chains;
  if (!chainsRaw || typeof chainsRaw !== 'object') return [];
  const pairs: Array<[string, unknown]> =
    chainsRaw instanceof Map
      ? Array.from(chainsRaw.entries())
      : Object.entries(chainsRaw as Record<string, unknown>);
  const chains = pairs
    .map(([key, value]) => sanitizeChainEntry(key, value))
    .filter((entry): entry is NonNullable<ReturnType<typeof sanitizeChainEntry>> => entry != null);
  chains.sort((a, b) => a.chainId - b.chainId);
  return chains;
}

function walletOwnerId(wallet: Record<string, unknown>): string | null {
  const raw =
    (typeof wallet.userId === 'string' && wallet.userId) ||
    docId(wallet.userId) ||
    docId(wallet.ownerId) ||
    docId(wallet.customerId);
  if (!raw) return null;
  return raw.replace(/\+business$/, '');
}

/** Allowlisted wallet fields. Root secrets and chain account secrets stay off the response. */
function sanitizeWalletSummary(wallet: Record<string, unknown>) {
  const chains = sanitizedChains(wallet);
  return {
    id: String(wallet._id ?? wallet.id ?? ''),
    userId: walletOwnerId(wallet),
    ownerId: docId(wallet.ownerId) || null,
    customerId: docId(wallet.customerId) || null,
    type: 'multichain' as const,
    provisioned: true,
    status: typeof wallet.status === 'string' ? wallet.status : null,
    twoFactorEnabled: Boolean(wallet.twoFactorEnabled),
    turnOnTestnets: Boolean(wallet.turnOnTestnets),
    chainCount: chains.length,
    chains,
    createdAt: wallet.createdAt ?? null,
    updatedAt: wallet.updatedAt ?? null,
  };
}

async function shapeMultichainWallet(
  wallet: Record<string, unknown>,
  user?: Record<string, unknown> | null,
) {
  const chainEntries = sanitizedChains(wallet);

  const balances = await fetchBalancesForChains(chainEntries);
  const balanceByChain = new Map(balances.map((b) => [b.chainId, b]));
  const chainsWithMoney = chainEntries.map((chain) => {
    const bal = balanceByChain.get(chain.chainId);
    return {
      ...chain,
      symbol: bal?.symbol ?? null,
      balance: bal?.balance ?? null,
      balanceRaw: bal?.balanceRaw ?? null,
      available: bal?.available ?? null,
      balanceError: bal?.error ?? null,
    };
  });

  // Prefer the resolved RainUser id; always strip `+business` so admin links hit /users/:id.
  const userId =
    (user && String(user._id || user.id || '')) ||
    walletOwnerId(wallet);

  const totalLocked = chainsWithMoney.reduce(
    (sum, c) => sum + Number(c.locks?.total ?? 0),
    0,
  );
  const balancesOk = chainsWithMoney.filter((c) => typeof c.balance === 'number');

  return {
    id: String(wallet._id ?? wallet.id ?? ''),
    userId,
    type: 'multichain',
    provisioned: true,
    twoFactorEnabled: Boolean(wallet.twoFactorEnabled),
    turnOnTestnets: Boolean(wallet.turnOnTestnets),
    chainCount: chainsWithMoney.length,
    chains: chainsWithMoney,
    balancesSummary: {
      chainsWithBalance: balancesOk.length,
      totalLockedSep: totalLocked,
      rows: balances,
    },
    createdAt: wallet.createdAt ?? null,
    updatedAt: wallet.updatedAt ?? null,
    user: user
      ? {
          id: String(user._id ?? user.id ?? ''),
          email: user.email ?? null,
          firstName: user.firstName ?? null,
          lastName: user.lastName ?? null,
          displayName: user.displayName ?? null,
          accountKind: user.accountKind ?? null,
          accountStatus: user.accountStatus ?? null,
          rainExternalUserId: user.rainExternalUserId ?? null,
        }
      : null,
  };
}

async function loadUserSummary(userId: string | null | undefined) {
  if (!userId || !Types.ObjectId.isValid(userId)) return null;
  return RainUser.findById(parseObjectId(userId, 'user id'))
    .select('email firstName lastName displayName accountKind accountStatus rainExternalUserId')
    .lean();
}

export async function getWallet(id: string) {
  let walletDoc: Record<string, unknown> | null = null;

  if (Types.ObjectId.isValid(id)) {
    try {
      walletDoc = (await MultichainsWallet.findById(parseObjectId(id, 'wallet id')).lean()) as
        | Record<string, unknown>
        | null;
    } catch {
      walletDoc = null;
    }
  }

  if (!walletDoc) {
    // List fallback uses Rain user ids — resolve multichain wallet by userId
    walletDoc = (await MultichainsWallet.findOne({
      $or: [{ userId: id }, { userId: `${id}+business` }],
    }).lean()) as Record<string, unknown> | null;
  }

  if (walletDoc) {
    const ownerId = walletOwnerId(walletDoc) || id;
    const user = await loadUserSummary(ownerId);
    // Drop sensitive root fields before shaping
    const cleaned = Object.fromEntries(
      Object.entries(walletDoc).filter(([key]) => !WALLET_SENSITIVE_ROOT.has(key)),
    );
    return shapeMultichainWallet(cleaned, user as Record<string, unknown> | null);
  }

  // No crypto wallet provisioned — return a clear proxy payload (not a raw user dump)
  if (!Types.ObjectId.isValid(id)) throw new ApiError(404, 'Wallet not found.');
  const user = await RainUser.findById(parseObjectId(id, 'wallet id'))
    .select('email firstName lastName displayName accountKind accountStatus rainExternalUserId createdAt')
    .lean();
  if (!user) throw new ApiError(404, 'Wallet not found.');
  return {
    id: String(user._id),
    userId: String(user._id),
    type: 'user_wallet_proxy',
    provisioned: false,
    chainCount: 0,
    chains: [],
    message:
      'No multichain crypto wallet is provisioned for this user yet. Open the user hub for Rain issuing / card activity.',
    user: {
      id: String(user._id),
      email: user.email ?? null,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      displayName: user.displayName ?? null,
      accountKind: user.accountKind ?? null,
      accountStatus: user.accountStatus ?? null,
      rainExternalUserId: user.rainExternalUserId ?? null,
    },
    createdAt: user.createdAt ?? null,
  };
}

function chainDataFromWallet(wallet: Record<string, unknown>, chainId: string) {
  const chainsRaw = wallet.chains;
  if (!chainsRaw || typeof chainsRaw !== 'object') return null;
  if (chainsRaw instanceof Map) {
    return (chainsRaw.get(chainId) as unknown) ?? (chainsRaw.get(Number(chainId)) as unknown) ?? null;
  }
  const obj = chainsRaw as Record<string, unknown>;
  return obj[chainId] ?? obj[String(Number(chainId))] ?? null;
}

type ChainAccountRow = {
  id: string;
  userId: string | null;
  chainId: number;
  address: string | null;
  locks: {
    admin: number;
    subscription: number;
    competition: number;
    lottery26: number;
    total: number;
    /** Biptap labels admin locks as OTC */
    otc: number;
  };
  balance: number | null;
  availableBalance: number | null;
  balanceError: string | null;
  lockAmount?: number;
  subscriptionLockAmount?: number;
  competitionLockAmount?: number;
  otcLockAmount?: number;
  lottery26LockAmount?: number;
  createdAt: unknown;
  user: Record<string, unknown> | null;
};

const SEP_CHAIN_IDS = [19518, 19516, 19517];
const MULTICHAIN_IDS = [1, 56, 97, 8453, 84532, 1001, 1002, 2001, 2002, 3001, 3002, 3003];

async function collectChainAccounts(chainId: string): Promise<
  Array<{
    walletId: string;
    userId: string | null;
    address: string | null;
    locks: ChainAccountRow['locks'];
    createdAt: unknown;
  }>
> {
  const wallets = (await MultichainsWallet.find({})
    .select('userId chains createdAt')
    .lean()) as Record<string, unknown>[];

  const rows: Array<{
    walletId: string;
    userId: string | null;
    address: string | null;
    locks: ChainAccountRow['locks'];
    createdAt: unknown;
  }> = [];

  for (const wallet of wallets) {
    const raw = chainDataFromWallet(wallet, chainId);
    const sanitized = sanitizeChainEntry(chainId, raw);
    if (!sanitized?.address && !sanitized) continue;
    if (!sanitized) continue;
    const locks = {
      admin: sanitized.locks.admin,
      subscription: sanitized.locks.subscription,
      competition: sanitized.locks.competition,
      lottery26: sanitized.locks.lottery26,
      total: sanitized.locks.total,
      otc: sanitized.locks.admin,
    };
    rows.push({
      walletId: String(wallet._id ?? ''),
      userId: typeof wallet.userId === 'string' ? wallet.userId.replace(/\+business$/, '') : null,
      address: sanitized.address,
      locks,
      createdAt: wallet.createdAt ?? null,
    });
  }
  return rows;
}

/**
 * Per-chain wallet overview (Biptap-style): account counts + lock buckets from Mongo,
 * plus live balance totals sampled with concurrency (capped for latency).
 */
export async function getWalletChainAnalytics(chainIdRaw: string) {
  const chainId = String(chainIdRaw || '19518').trim();
  const chainNum = Number(chainId);
  if (!Number.isFinite(chainNum)) throw new ApiError(400, 'Invalid chainId.');

  const accounts = await collectChainAccounts(chainId);
  const totalAccounts = accounts.length;

  const locks = accounts.reduce(
    (acc, row) => {
      acc.admin += row.locks.admin;
      acc.subscription += row.locks.subscription;
      acc.competition += row.locks.competition;
      acc.lottery26 += row.locks.lottery26;
      acc.total += row.locks.total;
      return acc;
    },
    { admin: 0, subscription: 0, competition: 0, lottery26: 0, total: 0 },
  );

  // Live balances: cap sample size so the overview stays responsive
  const SAMPLE_CAP = 250;
  const sample = accounts.slice(0, SAMPLE_CAP);
  const live = await fetchBalancesBatched(
    sample.map((a) => ({
      chainId: chainNum,
      address: a.address,
      locked: a.locks.total,
    })),
    12,
  );

  let totalBalance = 0;
  let totalAvailable = 0;
  let funded = 0;
  let balanceSamples = 0;
  for (const bal of live) {
    if (typeof bal.balance === 'number') {
      totalBalance += bal.balance;
      totalAvailable += bal.available ?? Math.max(0, bal.balance - bal.locked);
      balanceSamples += 1;
      if (bal.balance > 0) funded += 1;
    }
  }

  return {
    chainId,
    summary: {
      totalAccounts,
      totalBalance,
      totalAvailableBalance: totalAvailable,
      totalLockAmount: locks.total,
      averageBalance: totalAccounts > 0 ? totalBalance / totalAccounts : 0,
      fundedWallets: funded,
      sampledBalances: balanceSamples,
      sampledCap: SAMPLE_CAP,
      sampled: totalAccounts > SAMPLE_CAP,
    },
    locks: {
      total: locks.total,
      subscription: locks.subscription,
      competition: locks.competition,
      otc: locks.admin,
      admin: locks.admin,
      lottery26: locks.lottery26,
    },
    generatedAt: new Date().toISOString(),
  };
}

export async function listWalletChainBalances(
  query: Record<string, unknown>,
  skip: number,
  limit: number,
) {
  const chainId = String(query.chainId || '19518').trim();
  const chainNum = Number(chainId);
  if (!Number.isFinite(chainNum)) throw new ApiError(400, 'Invalid chainId.');

  const accounts = await collectChainAccounts(chainId);
  const search = typeof query.search === 'string' ? query.search.trim().toLowerCase() : '';
  let filtered = accounts;
  if (search) {
    filtered = accounts.filter(
      (a) =>
        (a.address && a.address.toLowerCase().includes(search)) ||
        (a.userId && a.userId.toLowerCase().includes(search)) ||
        a.walletId.toLowerCase().includes(search),
    );
  }

  const total = filtered.length;
  const page = filtered.slice(skip, skip + limit);
  const live = await fetchBalancesBatched(
    page.map((a) => ({
      chainId: chainNum,
      address: a.address,
      locked: a.locks.total,
    })),
    10,
  );

  const userIds = [
    ...new Set(page.map((a) => a.userId).filter((id): id is string => Boolean(id))),
  ];
  const users =
    userIds.length > 0
      ? await RainUser.find({
          _id: { $in: userIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => parseObjectId(id, 'user id')) },
        })
          .select('email firstName lastName displayName')
          .lean()
      : [];
  const userMap = new Map(users.map((u) => [String(u._id), u as Record<string, unknown>]));

  const items: ChainAccountRow[] = page.map((row, index) => {
    const bal = live[index];
    const userDoc = row.userId ? userMap.get(row.userId) : null;
    return {
      id: row.walletId,
      userId: row.userId,
      chainId: chainNum,
      address: row.address,
      locks: row.locks,
      balance: bal?.balance ?? null,
      availableBalance: bal?.available ?? null,
      balanceError: bal?.error ?? null,
      lockAmount: row.locks.total,
      subscriptionLockAmount: row.locks.subscription,
      competitionLockAmount: row.locks.competition,
      otcLockAmount: row.locks.otc,
      lottery26LockAmount: row.locks.lottery26,
      createdAt: row.createdAt,
      user: userDoc
        ? {
            id: String(userDoc._id ?? row.userId),
            email: userDoc.email ?? null,
            firstName: userDoc.firstName ?? null,
            lastName: userDoc.lastName ?? null,
            displayName: userDoc.displayName ?? null,
          }
        : row.userId
          ? { id: row.userId }
          : null,
    };
  });

  return { items, total };
}

/** Match chainId whether stored as number or string in Mongo. */
function chainIdMatch(ids: number | number[]): FilterQuery<LooseDoc> {
  const list = Array.isArray(ids) ? ids : [ids];
  const variants = list.flatMap((id) => [id, String(id)]);
  return { chainId: { $in: variants } };
}

function cryptoChainFilter(rail: string, chainIdParam?: string): FilterQuery<LooseDoc> {
  if (chainIdParam && Number.isFinite(Number(chainIdParam))) {
    return chainIdMatch(Number(chainIdParam));
  }
  if (rail === 'sep') return chainIdMatch(SEP_CHAIN_IDS);
  if (rail === 'multichain') return chainIdMatch(MULTICHAIN_IDS);
  return {};
}

function cryptoDateFilter(query: Record<string, unknown>): FilterQuery<LooseDoc> {
  const range = createdAtRangeFilter(query);
  if (!range.createdAt) return {};
  // Wallet txs often use `timestamp` instead of createdAt
  return {
    $or: [{ createdAt: range.createdAt }, { timestamp: range.createdAt }],
  };
}

function dateRangeBounds(query: Record<string, unknown>): { from?: Date; to?: Date } {
  const range = createdAtRangeFilter(query).createdAt as
    | { $gte?: Date; $lte?: Date }
    | undefined;
  return { from: range?.$gte, to: range?.$lte };
}

function inDateRange(ts: Date | null | undefined, from?: Date, to?: Date): boolean {
  if (!from && !to) return true;
  if (!ts || Number.isNaN(ts.getTime())) return !from && !to;
  if (from && ts < from) return false;
  if (to && ts > to) return false;
  return true;
}

function normalizeExplorerTx(tx: ExplorerTx) {
  return {
    id: `explorer:${tx.chainId}:${tx.txHash}:${tx.walletAddress}`,
    source: 'explorer' as const,
    rail: SEP_CHAIN_IDS.includes(tx.chainId) ? 'sep' : 'multichain',
    chainId: tx.chainId,
    type: tx.type,
    status: tx.status,
    amount: tx.amount,
    currency: tx.currency,
    txHash: tx.txHash,
    from: tx.from,
    to: tx.to,
    userId: tx.userId,
    walletAddress: tx.walletAddress,
    explorerUrl: tx.explorerUrl,
    createdAt: tx.timestamp,
  };
}

function sameWalletUser(rowUserId: string | null, requested: string): boolean {
  if (!rowUserId) return false;
  const normalize = (id: string) => id.replace(/\+business$/, '');
  return normalize(rowUserId) === normalize(requested);
}

async function loadExplorerCrypto(
  rail: string,
  chainIdParam: string | undefined,
  query: Record<string, unknown>,
  userId?: string,
): Promise<ReturnType<typeof normalizeExplorerTx>[]> {
  const { from, to } = dateRangeBounds(query);
  const chainIds =
    chainIdParam && Number.isFinite(Number(chainIdParam))
      ? [Number(chainIdParam)]
      : rail === 'sep'
        ? SEP_CHAIN_IDS
        : rail === 'multichain'
          ? MULTICHAIN_IDS.filter((id) => explorerSupportsChain(id))
          : [];

  const wallets: Array<{ chainId: number; address: string; userId: string | null }> = [];
  for (const chainId of chainIds) {
    if (!explorerSupportsChain(chainId)) continue;
    const accounts = await collectChainAccounts(String(chainId));
    for (const row of accounts) {
      if (!row.address) continue;
      if (userId && !sameWalletUser(row.userId, userId)) continue;
      wallets.push({ chainId, address: row.address, userId: row.userId });
    }
  }

  if (!wallets.length) return [];

  const live = await fetchTransactionsForWallets(wallets, {
    perWallet: 25,
    concurrency: 6,
    maxWallets: 80,
  });

  return live
    .filter((tx) => inDateRange(tx.timestamp, from, to))
    .map(normalizeExplorerTx);
}

function normalizeCryptoTx(row: Record<string, unknown>, source: 'wallet' | 'swap') {
  const id = docId(row._id) || docId(row.id);
  const chainId = Number(row.chainId ?? row.fromChainId ?? 0) || null;
  const amount =
    Number(row.amountFormatted ?? row.amount ?? row.fromAmountFormatted ?? 0) || 0;
  const type = String(row.type ?? row.swapType ?? row.direction ?? 'other').toLowerCase();
  return {
    id: `${source}:${id}`,
    source,
    rail: SEP_CHAIN_IDS.includes(Number(chainId))
      ? 'sep'
      : MULTICHAIN_IDS.includes(Number(chainId))
        ? 'multichain'
        : source,
    chainId,
    type,
    status: row.status ?? 'unknown',
    amount,
    currency: String(row.currency ?? row.fromTokenSymbol ?? (SEP_CHAIN_IDS.includes(Number(chainId)) ? 'SEP' : 'TOKEN')),
    txHash: row.txHash ?? row.hash ?? row.destinationTxHash ?? null,
    from: row.from ?? null,
    to: row.to ?? null,
    userId: row.userId ? String(row.userId) : null,
    walletAddress: row.walletAddress ?? null,
    explorerUrl: row.explorerUrl ?? null,
    createdAt: row.timestamp ?? row.createdAt ?? null,
  };
}

type NormalizedCryptoRow = ReturnType<typeof normalizeCryptoTx> | ReturnType<typeof normalizeExplorerTx>;

function txDay(tx: NormalizedCryptoRow): string | null {
  const raw = tx.createdAt;
  const d = raw instanceof Date ? raw : raw ? new Date(String(raw)) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function txAmount(tx: NormalizedCryptoRow): number {
  const n = typeof tx.amount === 'number' ? tx.amount : Number(tx.amount);
  return Number.isFinite(n) ? n : 0;
}

function normalizeTypeKey(type: unknown): string {
  const t = String(type || 'other').toLowerCase();
  if (t.includes('stake')) return 'staking';
  if (t.includes('subscri')) return 'subscription';
  if (t === 'incoming' || t === 'outgoing' || t === 'staking' || t === 'subscription') return t;
  return t || 'other';
}

async function knownSepWalletAddresses(): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    for (const chainId of SEP_CHAIN_IDS) {
      const accounts = await collectChainAccounts(String(chainId));
      for (const row of accounts) {
        if (row.address) set.add(row.address.toLowerCase());
      }
    }
  } catch {
    /* ignore */
  }
  return set;
}

/** Biptap-style analytics payload from a list of normalized txs. */
function buildRichCryptoAnalytics(
  rail: string,
  chainIdParam: string | undefined,
  items: NormalizedCryptoRow[],
  opts?: {
    source?: string;
    note?: string;
    sepWallets?: Set<string>;
    allTime?: {
      totalTransactions: number;
      totalVolumeSEP: number;
      uniqueUsers: number;
      cachedWallets: number;
      firstTransaction: string | null;
      lastTransaction: string | null;
    };
  },
) {
  const byType: Record<string, number> = {};
  const byChain: Record<string, number> = {};
  const users = new Set<string>();
  const wallets = new Set<string>();
  const dayCount = new Map<string, number>();
  const dayByType = new Map<string, Record<string, number>>();
  const dayVolume = new Map<
    string,
    { incomingSEP: number; outgoingSEP: number; stakingSEP: number; subscriptionSEP: number }
  >();
  const dayUsers = new Map<string, Set<string>>();
  const senderCount = new Map<string, number>();
  const receiverCount = new Map<string, number>();
  let totalVolume = 0;

  for (const tx of items) {
    const type = normalizeTypeKey(tx.type);
    const amount = txAmount(tx);
    totalVolume += amount;
    byType[type] = (byType[type] || 0) + 1;
    const cid = String(tx.chainId ?? 'unknown');
    byChain[cid] = (byChain[cid] || 0) + 1;
    if (tx.userId) users.add(String(tx.userId));
    if (tx.walletAddress) wallets.add(String(tx.walletAddress).toLowerCase());

    const from = String((tx as { from?: string }).from || '').toLowerCase();
    const to = String((tx as { to?: string }).to || '').toLowerCase();
    if (from) senderCount.set(from, (senderCount.get(from) || 0) + 1);
    if (to) receiverCount.set(to, (receiverCount.get(to) || 0) + 1);

    const day = txDay(tx);
    if (!day) continue;
    dayCount.set(day, (dayCount.get(day) || 0) + 1);
    const typeMap = dayByType.get(day) || {};
    typeMap[type] = (typeMap[type] || 0) + 1;
    dayByType.set(day, typeMap);

    const vol = dayVolume.get(day) || {
      incomingSEP: 0,
      outgoingSEP: 0,
      stakingSEP: 0,
      subscriptionSEP: 0,
    };
    if (type === 'incoming') vol.incomingSEP += amount;
    else if (type === 'outgoing') vol.outgoingSEP += amount;
    else if (type === 'staking') vol.stakingSEP += amount;
    else if (type === 'subscription') vol.subscriptionSEP += amount;
    dayVolume.set(day, vol);

    const uSet = dayUsers.get(day) || new Set<string>();
    if (tx.userId) uSet.add(String(tx.userId));
    else if (tx.walletAddress) uSet.add(String(tx.walletAddress).toLowerCase());
    dayUsers.set(day, uSet);
  }

  const labelFor = (address: string) =>
    opts?.sepWallets?.has(address.toLowerCase()) ? 'SEP Wallet' : undefined;

  const topFromMap = (map: Map<string, number>, limit = 5) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([address, count]) => ({
        address,
        count,
        label: labelFor(address),
      }));

  const sortedByAmount = [...items].sort((a, b) => txAmount(b) - txAmount(a));
  const sortedByTime = [...items].sort((a, b) => {
    const ta = txDay(a) || '';
    const tb = txDay(b) || '';
    // Prefer full timestamp when available
    const da = a.createdAt ? new Date(String(a.createdAt)).getTime() : 0;
    const db_ = b.createdAt ? new Date(String(b.createdAt)).getTime() : 0;
    return (db_ || 0) - (da || 0) || tb.localeCompare(ta);
  });

  const mapTxBrief = (tx: NormalizedCryptoRow) => ({
    id: tx.id,
    txHash: tx.txHash,
    type: normalizeTypeKey(tx.type),
    amount: txAmount(tx),
    amountFormatted: String(txAmount(tx)),
    currency: tx.currency,
    chainId: tx.chainId,
    explorerUrl: tx.explorerUrl,
    timestamp: tx.createdAt,
    createdAt: tx.createdAt,
    userId: tx.userId,
    walletAddress: tx.walletAddress,
  });

  const days = [...dayCount.keys()].sort();
  const timeSeries = days.map((date) => ({
    name: date,
    date,
    value: dayCount.get(date) || 0,
    total: dayCount.get(date) || 0,
    byType: Object.entries(dayByType.get(date) || {}).map(([type, count]) => ({
      type,
      count,
    })),
    incoming: dayByType.get(date)?.incoming || 0,
    outgoing: dayByType.get(date)?.outgoing || 0,
    staking: dayByType.get(date)?.staking || 0,
    subscription: dayByType.get(date)?.subscription || 0,
    other: dayByType.get(date)?.other || 0,
  }));

  const volumeByDirection = days.map((date) => ({
    date,
    name: date,
    ...(dayVolume.get(date) || {
      incomingSEP: 0,
      outgoingSEP: 0,
      stakingSEP: 0,
      subscriptionSEP: 0,
    }),
    Incoming: dayVolume.get(date)?.incomingSEP || 0,
    Outgoing: dayVolume.get(date)?.outgoingSEP || 0,
    Staking: dayVolume.get(date)?.stakingSEP || 0,
    Subscription: dayVolume.get(date)?.subscriptionSEP || 0,
  }));

  const activeUsers = days.map((date) => ({
    date,
    name: date,
    uniqueUsers: dayUsers.get(date)?.size || 0,
    users: dayUsers.get(date)?.size || 0,
    value: dayUsers.get(date)?.size || 0,
  }));

  return {
    rail,
    chainId: chainIdParam ?? null,
    summary: {
      totalTransactions: items.length,
      totalVolumeSEP: totalVolume,
      totalFeesSEP: 0,
      avgAmountSEP: items.length ? totalVolume / items.length : 0,
      uniqueUsers: users.size,
      uniqueWallets: wallets.size,
    },
    overview: {
      totalTransactions: items.length,
      totalVolumeSEP: totalVolume,
      totalFeesSEP: 0,
      avgAmountSEP: items.length ? totalVolume / items.length : 0,
      uniqueUsers: users.size,
      uniqueWallets: wallets.size,
    },
    allTime: opts?.allTime ?? {
      totalTransactions: items.length,
      totalVolumeSEP: totalVolume,
      uniqueUsers: users.size,
      cachedWallets: opts?.sepWallets?.size ?? wallets.size,
      firstTransaction: sortedByTime.at(-1)?.createdAt
        ? String(sortedByTime.at(-1)?.createdAt)
        : null,
      lastTransaction: sortedByTime[0]?.createdAt ? String(sortedByTime[0]?.createdAt) : null,
    },
    byType,
    byChain,
    timeSeries,
    volumeByDirection,
    activeUsers,
    topSenders: topFromMap(senderCount),
    topReceivers: topFromMap(receiverCount),
    largestTransactions: sortedByAmount.slice(0, 8).map(mapTxBrief),
    recentTransactions: sortedByTime.slice(0, 8).map(mapTxBrief),
    recent: sortedByTime.slice(0, 8).map(mapTxBrief),
    generatedAt: new Date().toISOString(),
    source: opts?.source ?? 'mixed',
    note: opts?.note,
  };
}

async function loadServerCryptoRows(
  rail: string,
  chainIdParam: string | undefined,
  query: Record<string, unknown>,
): Promise<ReturnType<typeof normalizeCryptoTx>[]> {
  const serverBase = mergeFilters(
    cryptoChainFilter(rail, chainIdParam),
    createdAtRangeFilter(query),
  );
  const rows = (await WalletServerTransaction.find(serverBase)
    .sort({ createdAt: -1 })
    .limit(2000)
    .lean()) as Record<string, unknown>[];
  return rows.map((row) =>
    normalizeCryptoTx(
      {
        ...row,
        type: row.transactionType ?? row.type,
        txHash: row.transactionHash ?? row.txHash,
        amountFormatted: row.amountInString || row.amount,
        currency: row.from_currency ?? 'SEP',
        from: row.from ?? row.source_account ?? '',
        to: row.to ?? row.receipient ?? '',
      },
      'wallet',
    ),
  );
}

function textSearchFilter(fields: string[], search: string): FilterQuery<LooseDoc> {
  const pattern = new RegExp(escapeRegex(search), 'i');
  return { $or: fields.map((field) => ({ [field]: pattern })) };
}

function cryptoActivityFilter(
  query: Record<string, unknown>,
  rail: string,
  chainIdParam: string | undefined,
): FilterQuery<LooseDoc> {
  const parts: FilterQuery<LooseDoc>[] = [
    cryptoChainFilter(rail, chainIdParam),
    cryptoDateFilter(query),
  ];
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  if (userId) parts.push(userOrFilter(userId));
  const type = typeof query.type === 'string' ? query.type.trim() : '';
  if (type) parts.push({ type: type.toLowerCase() });
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    parts.push(textSearchFilter(['txHash', 'hash', 'from', 'to', 'walletAddress'], search));
  }
  return mergeFilters(...parts);
}

function walletServerActivityFilter(
  query: Record<string, unknown>,
  rail: string,
  chainIdParam: string | undefined,
): FilterQuery<LooseDoc> {
  const parts: FilterQuery<LooseDoc>[] = [
    cryptoChainFilter(rail, chainIdParam),
    createdAtRangeFilter(query),
  ];
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  if (userId) parts.push(userOrFilter(userId));
  const type = typeof query.type === 'string' ? query.type.trim() : '';
  if (type) parts.push({ transactionType: type });
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    parts.push(
      textSearchFilter(
        ['transactionHash', 'txHash', 'from', 'to', 'source_account', 'receipient'],
        search,
      ),
    );
  }
  return mergeFilters(...parts);
}

function swapActivityFilter(
  query: Record<string, unknown>,
  chainIdParam: string | undefined,
): FilterQuery<LooseDoc> {
  const parts: FilterQuery<LooseDoc>[] = [cryptoDateFilter(query)];
  if (chainIdParam && Number.isFinite(Number(chainIdParam))) {
    const chainNum = Number(chainIdParam);
    parts.push({
      $or: [
        { fromChainId: chainNum },
        { toChainId: chainNum },
        { chainId: chainNum },
        { fromChainId: String(chainIdParam) },
        { toChainId: String(chainIdParam) },
        { chainId: String(chainIdParam) },
      ],
    });
  }
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  if (userId) parts.push(userOrFilter(userId));
  const type = typeof query.type === 'string' ? query.type.trim().toLowerCase() : '';
  if (type) parts.push({ $or: [{ type }, { swapType: type }, { direction: type }] });
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    parts.push(textSearchFilter(['txHash', 'hash', 'from', 'to', 'walletAddress'], search));
  }
  return mergeFilters(...parts);
}

function explorerApplies(rail: string, chainIdParam?: string): boolean {
  if (chainIdParam && Number.isFinite(Number(chainIdParam))) {
    return explorerSupportsChain(Number(chainIdParam));
  }
  if (rail === 'sep') return SEP_CHAIN_IDS.some((id) => explorerSupportsChain(id));
  if (rail === 'multichain') return MULTICHAIN_IDS.some((id) => explorerSupportsChain(id));
  return false;
}

export async function listCryptoTransactions(
  query: Record<string, unknown>,
  skip: number,
  limit: number,
) {
  const rail = String(query.rail || 'sep').toLowerCase();
  const chainIdParam = typeof query.chainId === 'string' ? query.chainId : undefined;
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  const type = typeof query.type === 'string' ? query.type.trim().toLowerCase() : '';
  const search = typeof query.search === 'string' ? query.search.trim() : '';

  if (await collectionExists(WalletTransaction)) {
    const filter = cryptoActivityFilter(query, rail, chainIdParam);
    const [total, items] = await Promise.all([
      WalletTransaction.countDocuments(filter),
      WalletTransaction.find(filter)
        .sort({ timestamp: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);
    return {
      total,
      items: (items as Record<string, unknown>[]).map((row) => normalizeCryptoTx(row, 'wallet')),
    };
  }

  if (await collectionExists(WalletServerTransaction)) {
    const filter = walletServerActivityFilter(query, rail, chainIdParam);
    const [total, items] = await Promise.all([
      WalletServerTransaction.countDocuments(filter),
      WalletServerTransaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);
    return {
      total,
      source: 'wallet-server' as const,
      items: (items as Record<string, unknown>[]).map((row) => {
        const normalized = normalizeCryptoTx(
          {
            ...row,
            type: row.transactionType ?? row.type,
            txHash: row.transactionHash ?? row.txHash,
            amountFormatted: row.amountInString ?? row.amount,
            currency: row.from_currency ?? row.to_currency ?? 'SEP',
          },
          'wallet',
        );
        return { ...normalized, source: 'wallet-server' };
      }),
    };
  }

  if (explorerApplies(rail, chainIdParam)) {
    let live = await loadExplorerCrypto(rail, chainIdParam, query, userId || undefined);
    if (type) live = live.filter((tx) => tx.type === type);
    if (search) {
      const q = search.toLowerCase();
      live = live.filter(
        (tx) =>
          tx.txHash.toLowerCase().includes(q) ||
          tx.from.toLowerCase().includes(q) ||
          tx.to.toLowerCase().includes(q) ||
          String(tx.walletAddress).toLowerCase().includes(q),
      );
    }
    return {
      total: live.length,
      items: live.slice(skip, skip + limit),
      source: 'explorer' as const,
    };
  }

  if ((rail === 'multichain' || rail === 'all') && (await collectionExists(SwapTransaction))) {
    const filter = swapActivityFilter(query, chainIdParam);
    const [total, items] = await Promise.all([
      SwapTransaction.countDocuments(filter),
      SwapTransaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);
    return {
      total,
      items: (items as Record<string, unknown>[]).map((row) => normalizeCryptoTx(row, 'swap')),
    };
  }

  return { items: [], total: 0 };
}

export async function getCryptoTransactionAnalytics(query: Record<string, unknown>) {
  const rail = String(query.rail || 'sep').toLowerCase();
  const chainIdParam = typeof query.chainId === 'string' ? query.chainId : undefined;
  const base = mergeFilters(cryptoChainFilter(rail, chainIdParam), cryptoDateFilter(query));
  const sepWallets = await knownSepWalletAddresses();

  // 1) Synced explorer cache
  try {
    const cached = (await WalletTransaction.find(base)
      .sort({ timestamp: -1 })
      .limit(5000)
      .lean()) as Record<string, unknown>[];
    if (cached.length > 0) {
      const rows = cached.map((row) => normalizeCryptoTx(row, 'wallet'));
      return buildRichCryptoAnalytics(rail, chainIdParam, rows, {
        source: 'cache',
        sepWallets,
        allTime: {
          totalTransactions: await WalletTransaction.countDocuments(
            cryptoChainFilter(rail, chainIdParam),
          ),
          totalVolumeSEP: rows.reduce((s, r) => s + txAmount(r), 0),
          uniqueUsers: new Set(rows.map((r) => r.userId).filter(Boolean)).size,
          cachedWallets: sepWallets.size,
          firstTransaction: null,
          lastTransaction: rows[0]?.createdAt ? String(rows[0].createdAt) : null,
        },
      });
    }
  } catch {
    /* continue */
  }

  // 2) Wallet-server log + live explorer (merge / dedupe by hash)
  const merged = new Map<string, NormalizedCryptoRow>();
  try {
    for (const row of await loadServerCryptoRows(rail, chainIdParam, query)) {
      const key = String(row.txHash || row.id);
      if (key) merged.set(key, row);
    }
  } catch {
    /* ignore */
  }
  try {
    for (const row of await loadExplorerCrypto(rail, chainIdParam, query)) {
      const key = String(row.txHash || row.id);
      if (key && !merged.has(key)) merged.set(key, row);
    }
  } catch {
    /* ignore */
  }

  const items = [...merged.values()];
  if (items.length > 0) {
    return buildRichCryptoAnalytics(rail, chainIdParam, items, {
      source: merged.size ? 'wallet-server+explorer' : 'mixed',
      sepWallets,
      note:
        'Combined wallet-server log and live explorer (wallettransactions sync cache empty).',
    });
  }

  return buildRichCryptoAnalytics(rail, chainIdParam, [], {
    source: 'empty',
    sepWallets,
    note: 'No crypto transactions found for this rail/chain yet.',
  });
}

function normalizeStakingRow(row: Record<string, unknown>) {
  const amount =
    (typeof row.stakeAmountSEP === 'number' ? row.stakeAmountSEP : null) ??
    (typeof row.amount === 'number' ? row.amount : null) ??
    (typeof row.stakedAmount === 'number' ? row.stakedAmount : null);
  const withdrawn = Boolean(row.isWithdrawn);
  return {
    ...row,
    id: docId(row._id) || docId(row.id),
    amount,
    currency: 'SEP',
    packageName: row.packageName ?? row.package ?? row.plan ?? null,
    status: withdrawn ? 'withdrawn' : row.status ?? null,
    chainId: row.chainId ?? null,
    walletAddress: row.walletAddress ?? null,
    txHash: row.transactionHash ?? row.txHash ?? null,
  };
}

export async function listStaking(query: Record<string, unknown>, skip: number, limit: number) {
  const filter: FilterQuery<LooseDoc> = { ...createdAtRangeFilter(query) };
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  if (userId) Object.assign(filter, userOrFilter(userId));
  if (typeof query.status === 'string' && query.status.trim()) {
    const status = query.status.trim().toLowerCase();
    if (status === 'withdrawn') filter.isWithdrawn = true;
    else if (status === 'active') {
      filter.isWithdrawn = { $ne: true };
      filter.status = { $in: ['confirmed', 'pending'] };
    } else {
      filter.status = query.status.trim();
    }
  }
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = [
      ...(Array.isArray(filter.$or) ? filter.$or : []),
      { walletAddress: pattern },
      { transactionHash: pattern },
      { packageName: pattern },
      { userId: pattern },
    ];
  }
  const result = await safePage(StakingPosition, filter, skip, limit);
  if (result.total > 0) {
    const enriched = await enrichWithUserDisplay(
      (result.items as Record<string, unknown>[]).map(normalizeStakingRow),
      ['userId', 'ownerId', 'customerId'],
    );
    return { ...result, items: enriched };
  }
  return { items: [], total: 0 };
}

export async function getStaking(id: string) {
  try {
    const pos = await StakingPosition.findById(parseObjectId(id, 'staking id')).lean();
    if (pos) {
      const row = normalizeStakingRow(pos as Record<string, unknown>);
      const [enriched] = await enrichWithUserDisplay([row], ['userId', 'ownerId', 'customerId']);
      return enriched ?? row;
    }
  } catch {
    /* ignore */
  }
  throw new ApiError(404, 'Staking position not found.');
}

export async function listBusiness(query: Record<string, unknown>, skip: number, limit: number) {
  const filter: FilterQuery<LooseDoc> = mergeFilters(
    { accountKind: 'business' },
    createdAtRangeFilter(query),
  );
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
    ];
  }
  const [total, users] = await Promise.all([
    RainUser.countDocuments(filter),
    RainUser.find(filter)
      .select(USER_SECRET_FIELDS)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
  ]);

  const items = await Promise.all(
    users.map(async (user) => {
      const id = String(user._id);
      const [kyb, cards, teamHint] = await Promise.all([
        RainKyb.findOne({
          $or: [{ userId: id }, { rainUser: id }, { user: parseObjectId(id, 'user id') }],
        }).lean(),
        Card.countDocuments({
          $or: [{ rainUserId: id }, { customerId: id }, { userId: id }, { companyId: id }],
        }),
        RainUser.countDocuments({
          $or: [{ parentUserId: id }, { companyOwnerId: id }, { businessOwnerId: id }],
        }).catch(() => 0),
      ]);
      return {
        id,
        userId: id,
        email: user.email,
        displayName: user.displayName ?? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim(),
        accountStatus: user.accountStatus ?? 'active',
        rainExternalUserId: user.rainExternalUserId ?? null,
        kybStatus:
          (kyb as Record<string, unknown> | null)?.status ??
          (kyb as Record<string, unknown> | null)?.kybStatus ??
          null,
        cardCount: cards,
        teamCount: teamHint,
        createdAt: user.createdAt,
      };
    }),
  );

  return { items, total };
}

export async function getBusiness(userId: string) {
  const user = await RainUser.findById(parseObjectId(userId, 'user id'))
    .select(USER_SECRET_FIELDS)
    .lean();
  if (!user) throw new ApiError(404, 'Business not found.');
  const [kyb, cards, team] = await Promise.all([
    RainKyb.findOne({
      $or: [
        { userId },
        { rainUser: userId },
        { user: parseObjectId(userId, 'user id') },
      ],
    }).lean(),
    Card.find({
      $or: [
        { rainUserId: userId },
        { customerId: userId },
        { userId },
        { companyId: userId },
        { rainUser: parseObjectId(userId, 'user id') },
      ],
    })
      .limit(100)
      .lean(),
    RainUser.find({
      $or: [
        { parentUserId: userId },
        { companyOwnerId: userId },
        { businessOwnerId: userId },
      ],
    })
      .select('email firstName lastName displayName accountStatus createdAt')
      .limit(100)
      .lean()
      .catch(() => []),
  ]);
  return {
    user,
    kyb,
    cards,
    team,
    id: String(user._id),
  };
}

export async function listDisputes(query: Record<string, unknown>, skip: number, limit: number) {
  const filter: FilterQuery<LooseDoc> = { ...createdAtRangeFilter(query) };
  if (typeof query.status === 'string' && query.status.trim()) filter.status = query.status.trim();
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  if (userId) Object.assign(filter, userOrFilter(userId));
  const result = await safePage(RainDispute, filter, skip, limit);
  return {
    ...result,
    items: await enrichWithUserDisplay(result.items as Record<string, unknown>[], [
      'userId',
      'customerId',
      'rainUserId',
      'cardholderUserId',
    ]),
  };
}

export async function getDispute(id: string) {
  try {
    const doc = await RainDispute.findById(parseObjectId(id, 'dispute id')).lean();
    if (doc) return doc;
  } catch {
    /* ignore */
  }
  throw new ApiError(404, 'Dispute not found.');
}

export async function listSupportTickets(
  query: Record<string, unknown>,
  skip: number,
  limit: number,
) {
  const filter: FilterQuery<LooseDoc> = { ...createdAtRangeFilter(query) };
  if (typeof query.status === 'string' && query.status.trim()) filter.status = query.status.trim();
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  if (userId) Object.assign(filter, userOrFilter(userId));
  const search = typeof query.search === 'string' ? query.search.trim() : '';
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    filter.$or = [
      ...(Array.isArray(filter.$or) ? filter.$or : []),
      { subject: pattern },
      { title: pattern },
      { description: pattern },
      { zendeskId: pattern },
      { email: pattern },
    ];
  }
  const result = await safePage(SupportTicket, filter, skip, limit);
  if (result.total > 0) {
    return {
      ...result,
      items: await enrichWithUserDisplay(result.items as Record<string, unknown>[], [
        'userId',
        'requesterId',
        'customerId',
      ]),
    };
  }

  // Fallback: recent notifications as ops inbox signal
  const [total, items] = await Promise.all([
    Notification.countDocuments({}),
    Notification.find({}).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return {
    total,
    items: (items as Record<string, unknown>[]).map((n) => ({
      id: docId(n._id),
      subject: n.title ?? n.subject ?? 'Notification',
      status: n.status ?? 'open',
      channel: 'notification_fallback',
      userId: pickUser(n),
      createdAt: n.createdAt,
      body: n.message ?? n.body ?? '',
    })),
  };
}

function pickUser(row: Record<string, unknown>): string | null {
  return docId(row.userId) || docId(row.user_id) || docId(row.customerId) || null;
}

export async function getSupportTicket(id: string) {
  try {
    const doc = await SupportTicket.findById(parseObjectId(id, 'ticket id')).lean();
    if (doc) return doc;
  } catch {
    /* ignore */
  }
  const note = await Notification.findById(parseObjectId(id, 'ticket id')).lean();
  if (note) {
    return {
      id: String(note._id),
      subject: (note as Record<string, unknown>).title ?? 'Notification',
      status: 'open',
      channel: 'notification_fallback',
      body: (note as Record<string, unknown>).message ?? '',
      createdAt: (note as Record<string, unknown>).createdAt,
    };
  }
  throw new ApiError(404, 'Support ticket not found.');
}

export async function replySupportTicket(
  actor: Actor,
  id: string,
  body: string,
) {
  const ticket = await SupportTicket.findById(parseObjectId(id, 'ticket id'));
  if (!ticket) throw new ApiError(404, 'Support ticket not found (live Zendesk reply requires ticket sync).');
  const replies = Array.isArray(ticket.get('replies')) ? (ticket.get('replies') as object[]) : [];
  replies.push({
    authorEmail: actor.email,
    body: body.trim(),
    createdAt: new Date(),
  });
  ticket.set('replies', replies);
  ticket.set('status', ticket.get('status') === 'closed' ? 'open' : ticket.get('status') ?? 'pending');
  await ticket.save();
  await recordAudit(actor, 'support.reply', 'support_ticket', id, { preview: body.slice(0, 80) });
  return ticket;
}

export async function updateSupportTicketStatus(actor: Actor, id: string, status: string) {
  const ticket = await SupportTicket.findById(parseObjectId(id, 'ticket id'));
  if (!ticket) throw new ApiError(404, 'Support ticket not found.');
  const from = String(ticket.get('status') ?? '');
  ticket.set('status', status);
  await ticket.save();
  await recordAudit(actor, 'support.status', 'support_ticket', id, { from, status });
  return ticket;
}

/** Customer 360 aggregate for user hub. */
export async function getCustomer360(userId: string) {
  const oid = parseObjectId(userId, 'user id');
  const userFilter = userOrFilter(userId);

  const [
    user,
    kyc,
    kyb,
    subscriptions,
    cards,
    charges,
    paypal,
    stripe,
    wert,
    savings,
    fraud,
  ] = await Promise.all([
    RainUser.findById(oid).select(USER_SECRET_FIELDS).lean(),
    RainKyc.findOne({ $or: [{ userId }, { user: oid }, { rainUser: oid }] }).lean(),
    RainKyb.findOne({ $or: [{ userId }, { user: oid }, { rainUser: oid }] }).lean(),
    Subscription.find(userFilter).sort({ createdAt: -1 }).limit(20).lean(),
    Card.find({
      $or: [
        { rainUserId: userId },
        { customerId: userId },
        { userId },
        { rainUser: oid },
      ],
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean(),
    Charge.find(userFilter).sort({ createdAt: -1 }).limit(20).lean(),
    PayPalOrder.find(userFilter).sort({ createdAt: -1 }).limit(10).lean(),
    StripePayment.find(userFilter).sort({ createdAt: -1 }).limit(10).lean(),
    WertTransaction.find(userFilter).sort({ createdAt: -1 }).limit(10).lean(),
    SavingsPlan.find(userFilter).sort({ createdAt: -1 }).limit(10).lean(),
    FraudCase.find({ userId: oid }).sort({ updatedAt: -1 }).limit(10).lean(),
  ]);

  if (!user) throw new ApiError(404, 'User not found.');

  return {
    user,
    compliance: { kyc, kyb },
    subscriptions,
    cards,
    money: { charges, paypal, stripe, wert },
    savings,
    fraud,
    counts: {
      subscriptions: subscriptions.length,
      cards: cards.length,
      charges: charges.length,
      purchases: paypal.length + stripe.length + wert.length,
      savings: savings.length,
      fraud: fraud.length,
    },
  };
}

export async function getReportsSummary() {
  const [
    users,
    businessUsers,
    cardsActive,
    subscriptionsActive,
    savingsActive,
    charges,
    paypal,
    stripe,
    wert,
    kycPending,
    fraudOpen,
  ] = await Promise.all([
    RainUser.countDocuments(),
    RainUser.countDocuments({ accountKind: 'business' }),
    Card.countDocuments({ status: 'active' }),
    Subscription.countDocuments({ status: { $in: ['active', 'ACTIVE', 'trialing'] } }),
    SavingsPlan.countDocuments({ status: { $in: ['ACTIVE', 'active'] } }),
    Charge.countDocuments(),
    PayPalOrder.countDocuments(),
    StripePayment.countDocuments(),
    WertTransaction.countDocuments(),
    RainKyc.countDocuments({
      kycApprovedStatus: { $in: ['pending', 'PENDING', 'in_review', 'submitted'] },
    }),
    FraudCase.countDocuments({ status: { $in: ['open', 'investigating'] } }),
  ]);

  return {
    users: { total: users, business: businessUsers },
    cards: { active: cardsActive },
    subscriptions: { active: subscriptionsActive },
    savings: { active: savingsActive },
    commerce: { charges, paypal, stripe, wert, purchases: paypal + stripe + wert },
    compliance: { kycPending },
    risk: { fraudOpen },
    generatedAt: new Date().toISOString(),
  };
}

export async function getGrowthInsights() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [
    newUsers30d,
    newSubs30d,
    newCards30d,
    usersByKind,
    subsByStatus,
    cardsByStatus,
    usersDaily,
  ] = await Promise.all([
    RainUser.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
    Subscription.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
    Card.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),
    RainUser.aggregate([{ $group: { _id: '$accountKind', count: { $sum: 1 } } }]),
    Subscription.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    Card.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    RainUser.aggregate([
      { $match: { createdAt: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  return {
    windowDays: 30,
    newUsers30d,
    newSubs30d,
    newCards30d,
    usersByKind: Object.fromEntries(usersByKind.map((r) => [r._id ?? 'unknown', r.count])),
    subscriptionsByStatus: Object.fromEntries(
      subsByStatus.map((r) => [r._id ?? 'unknown', r.count]),
    ),
    cardsByStatus: Object.fromEntries(cardsByStatus.map((r) => [r._id ?? 'unknown', r.count])),
    usersDaily: usersDaily.map((r) => ({ name: r._id, value: r.count })),
    generatedAt: new Date().toISOString(),
  };
}

export async function getFraudSignals(userId?: string) {
  const filter = userId && Types.ObjectId.isValid(userId) ? { userId: parseObjectId(userId, 'user id') } : {};
  const cases = await FraudCase.find(filter).sort({ updatedAt: -1 }).limit(100).lean();
  const open = cases.filter((c) => c.status === 'open' || c.status === 'investigating').length;
  let riskScore = Math.min(100, open * 25 + cases.length * 5);
  if (userId && Types.ObjectId.isValid(userId)) {
    const [lockedCards, suspended] = await Promise.all([
      Card.countDocuments({
        status: 'locked',
        $or: [{ rainUserId: userId }, { customerId: userId }, { userId }],
      }),
      RainUser.countDocuments({ _id: parseObjectId(userId, 'user id'), accountStatus: 'suspended' }),
    ]);
    riskScore = Math.min(100, riskScore + lockedCards * 15 + suspended * 40);
  }
  return {
    userId: userId || null,
    riskScore,
    openCases: open,
    totalCases: cases.length,
    cases,
    signals: [
      ...(open > 0 ? [{ code: 'OPEN_FRAUD_CASE', severity: 'high' as const }] : []),
      ...(riskScore >= 50 ? [{ code: 'ELEVATED_RISK', severity: 'medium' as const }] : []),
    ],
  };
}

export async function listPhysicalCardOrders(
  query: Record<string, unknown>,
  skip: number,
  limit: number,
) {
  const filter: FilterQuery<LooseDoc> = {
    $or: [
      { type: { $in: ['physical', 'plastic', 'metal'] } },
      { cardType: { $in: ['physical', 'plastic', 'metal'] } },
      { productType: { $in: ['PLASTIC', 'METAL', 'physical'] } },
      { form: 'physical' },
    ],
  };
  if (typeof query.status === 'string' && query.status.trim()) filter.status = query.status.trim();
  const userId = typeof query.userId === 'string' ? query.userId.trim() : '';
  if (userId) {
    filter.$and = [
      {
        $or: [
          { rainUserId: userId },
          { customerId: userId },
          { userId },
          ...(Types.ObjectId.isValid(userId)
            ? [{ rainUser: parseObjectId(userId, 'user id') }]
            : []),
        ],
      },
    ];
  }
  const [total, items] = await Promise.all([
    Card.countDocuments(filter),
    Card.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return {
    items: await enrichWithUserDisplay(items as Record<string, unknown>[], [
      'customerId',
      'userId',
      'rainUser',
    ]),
    total,
  };
}

export async function getMaintenanceState() {
  const flag = await FeatureFlag.findOne({ key: 'maintenance_mode' }).lean();
  return {
    enabled: Boolean(flag?.enabled),
    flag: flag ?? null,
    key: 'maintenance_mode',
  };
}

export async function setMaintenanceState(actor: Actor, enabled: boolean) {
  const flag = await FeatureFlag.findOneAndUpdate(
    { key: 'maintenance_mode' },
    {
      $set: {
        description: 'Platform maintenance mode',
        enabled,
        updatedBy: actor.email,
      },
    },
    { new: true, upsert: true },
  );
  await recordAudit(actor, 'maintenance.set', 'feature_flag', 'maintenance_mode', { enabled });
  return { enabled: Boolean(flag.enabled), flag };
}
