/**
 * Live on-chain activity for admin SEP / EVM analytics when Mongo
 * `wallettransactions` has not been bulk-synced yet (Biptap uses Bulk Sync;
 * US admin falls back to explorer reads against MultichainsWallet addresses).
 */

const EXPLORER_BY_CHAIN: Record<number, string> = {
  19518: process.env.STC_EXPLORER_URL || 'https://stcexplorer.io',
  19517: process.env.STC_TESTNET_EXPLORER_URL || 'https://testnet.stcexplorer.io',
  19516: process.env.SEC_EXPLORER_URL || 'https://secexplorer.io',
  1: 'https://eth.blockscout.com',
  56: 'https://bsc.blockscout.com',
  97: 'https://bsc-testnet.blockscout.com',
  8453: 'https://base.blockscout.com',
  84532: 'https://base-sepolia.blockscout.com',
};

const SYMBOL_BY_CHAIN: Record<number, string> = {
  19518: 'SEP',
  19517: 'SEP',
  19516: 'SEP',
  1: 'ETH',
  56: 'BNB',
  97: 'BNB',
  8453: 'ETH',
  84532: 'ETH',
};

const STAKING_CONTRACTS: Record<number, string> = {
  19518: '0x77a7fb325222215ab5dbf36d9f657342fc33a22b',
  19517: '0xb066ce5fb67cd60a749ada7382b706c28afa081a',
};

export type ExplorerTx = {
  chainId: number;
  type: 'incoming' | 'outgoing' | 'staking' | 'other';
  status: string;
  amount: number;
  currency: string;
  txHash: string;
  from: string;
  to: string;
  userId: string | null;
  walletAddress: string;
  explorerUrl: string;
  timestamp: Date | null;
  amountRaw?: string;
};

type BlockscoutTx = {
  hash?: string;
  from?: { hash?: string } | string;
  to?: { hash?: string } | string | null;
  value?: string;
  status?: string;
  timestamp?: string;
  method?: string;
};

function addrOf(value: BlockscoutTx['from'] | BlockscoutTx['to']): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.hash || '';
}

function formatUnits(raw: bigint, decimals: number): number {
  if (decimals <= 0) return Number(raw);
  const base = BigInt(10) ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw % base;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 8);
  return Number(`${whole}.${fracStr}`);
}

function classify(
  from: string,
  to: string,
  wallet: string,
  chainId: number,
  method?: string,
): ExplorerTx['type'] {
  const fromL = from.toLowerCase();
  const toL = to.toLowerCase();
  const userL = wallet.toLowerCase();
  const staking = STAKING_CONTRACTS[chainId]?.toLowerCase();
  if (staking && toL === staking) return 'staking';
  if (method && /stake|unstake|withdraw/i.test(method) && fromL === userL) return 'staking';
  if (fromL !== userL && toL === userL) return 'incoming';
  if (fromL === userL) return 'outgoing';
  return 'other';
}

async function fetchJson(url: string, timeoutMs = 10_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function explorerSupportsChain(chainId: number): boolean {
  return Boolean(EXPLORER_BY_CHAIN[chainId]);
}

export async function fetchAddressTransactions(
  chainId: number,
  address: string,
  userId: string | null,
  limit = 25,
): Promise<ExplorerTx[]> {
  const explorer = EXPLORER_BY_CHAIN[chainId];
  if (!explorer || !address) return [];
  const symbol = SYMBOL_BY_CHAIN[chainId] || 'TOKEN';
  const url = `${explorer.replace(/\/$/, '')}/api/v2/addresses/${encodeURIComponent(address)}/transactions?items_count=${Math.min(50, limit)}`;

  try {
    const data = (await fetchJson(url)) as { items?: BlockscoutTx[] };
    const items = data.items ?? [];
    const out: ExplorerTx[] = [];
    for (const item of items.slice(0, limit)) {
      const hash = (item.hash || '').trim();
      if (!hash) continue;
      const from = addrOf(item.from);
      const to = addrOf(item.to);
      let amount = 0;
      let amountRaw = '0';
      try {
        const wei = BigInt(item.value || '0');
        amountRaw = wei.toString();
        amount = formatUnits(wei, 18);
      } catch {
        amount = 0;
      }
      out.push({
        chainId,
        type: classify(from, to, address, chainId, item.method),
        status: item.status === 'ok' || item.status === 'success' ? 'success' : item.status || 'unknown',
        amount,
        currency: symbol,
        txHash: hash,
        from,
        to,
        userId,
        walletAddress: address,
        explorerUrl: `${explorer.replace(/\/$/, '')}/tx/${hash}`,
        timestamp: item.timestamp ? new Date(item.timestamp) : null,
        amountRaw,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Fetch explorer txs for many wallets with a concurrency cap. */
export async function fetchTransactionsForWallets(
  wallets: Array<{ chainId: number; address: string; userId: string | null }>,
  opts?: { perWallet?: number; concurrency?: number; maxWallets?: number },
): Promise<ExplorerTx[]> {
  const perWallet = opts?.perWallet ?? 20;
  const concurrency = opts?.concurrency ?? 6;
  const maxWallets = opts?.maxWallets ?? 60;
  const slice = wallets
    .filter((w) => w.address && explorerSupportsChain(w.chainId))
    .slice(0, maxWallets);

  const results: ExplorerTx[] = [];
  let next = 0;
  async function worker() {
    while (next < slice.length) {
      const index = next;
      next += 1;
      const w = slice[index];
      const txs = await fetchAddressTransactions(w.chainId, w.address, w.userId, perWallet);
      results.push(...txs);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, slice.length || 1) }, () => worker()),
  );
  results.sort((a, b) => {
    const ta = a.timestamp?.getTime() ?? 0;
    const tb = b.timestamp?.getTime() ?? 0;
    return tb - ta;
  });
  return results;
}
