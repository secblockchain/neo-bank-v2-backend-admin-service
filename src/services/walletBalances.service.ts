/**
 * Read-only native balances for admin wallet detail.
 * Uses public RPCs / explorers so SERVER_PRIVATE_KEY is not required.
 */

export type ChainBalance = {
  chainId: number;
  symbol: string;
  balance: number | null;
  balanceRaw: string | null;
  available: number | null;
  locked: number;
  error?: string;
};

const EVM_RPC: Record<number, string> = {
  1: process.env.ETH_RPC_URL || 'https://eth.llamarpc.com',
  56: process.env.BSC_RPC_URL || 'https://bsc.llamarpc.com',
  97: process.env.BSC_TESTNET_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545',
  8453: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  84532: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
  19518: process.env.STC_RPC_URL || 'https://rpc.stcexplorer.io',
  19517: process.env.STC_TESTNET_RPC_URL || 'https://testnet-rpc.stcexplorer.io',
  19516: process.env.SEC_RPC_URL || 'https://rpc.secexplorer.io',
};

const STC_EXPLORER: Record<number, string> = {
  19518: 'https://stcexplorer.io',
  19517: 'https://testnet.stcexplorer.io',
  19516: 'https://secexplorer.io',
};

const SYMBOL_BY_CHAIN: Record<number, string> = {
  1: 'ETH',
  56: 'BNB',
  97: 'BNB',
  8453: 'ETH',
  84532: 'ETH',
  19518: 'SEP',
  19517: 'SEP',
  19516: 'SEP',
  1001: 'BTC',
  1002: 'BTC',
  2001: 'XRP',
  2002: 'XRP',
  3001: 'SOL',
  3002: 'SOL',
  3003: 'SOL',
};

function formatUnits(raw: bigint, decimals: number): number {
  if (decimals <= 0) return Number(raw);
  const base = BigInt(10) ** BigInt(decimals);
  const whole = raw / base;
  const frac = raw % base;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 8);
  return Number(`${whole}.${fracStr}`);
}

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function evmBalance(chainId: number, address: string): Promise<{ raw: string; value: number }> {
  const rpc = EVM_RPC[chainId];
  if (rpc) {
    try {
      const body = {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [address, 'latest'],
      };
      const data = (await fetchJson(rpc, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })) as { result?: string; error?: { message?: string } };
      if (data.error?.message) throw new Error(data.error.message);
      if (typeof data.result === 'string' && data.result.startsWith('0x')) {
        const wei = BigInt(data.result);
        return { raw: wei.toString(), value: formatUnits(wei, 18) };
      }
    } catch {
      /* fall through to explorer for STC */
    }
  }

  const explorer = STC_EXPLORER[chainId];
  if (explorer) {
    const data = (await fetchJson(
      `${explorer}/api/v2/addresses/${encodeURIComponent(address)}`,
    )) as { coin_balance?: string };
    if (data.coin_balance == null || data.coin_balance === '') {
      throw new Error('Explorer returned empty balance');
    }
    const wei = BigInt(data.coin_balance);
    return { raw: wei.toString(), value: formatUnits(wei, 18) };
  }

  throw new Error(`No RPC/explorer for chain ${chainId}`);
}

async function bitcoinBalance(
  address: string,
  chainId: number,
): Promise<{ raw: string; value: number }> {
  const base =
    chainId === 1002
      ? 'https://blockstream.info/testnet/api'
      : 'https://blockstream.info/api';
  const data = (await fetchJson(
    `${base}/address/${encodeURIComponent(address)}`,
  )) as {
    chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
    mempool_stats?: { funded_txo_sum?: number; spent_txo_sum?: number };
  };
  const chain = data.chain_stats ?? {};
  const mempool = data.mempool_stats ?? {};
  const sats =
    (chain.funded_txo_sum ?? 0) -
    (chain.spent_txo_sum ?? 0) +
    (mempool.funded_txo_sum ?? 0) -
    (mempool.spent_txo_sum ?? 0);
  return { raw: String(sats), value: sats / 1e8 };
}

async function xrpBalance(
  address: string,
  chainId: number,
): Promise<{ raw: string; value: number }> {
  const rpc =
    chainId === 2002
      ? process.env.XRP_TESTNET_RPC_URL || 'https://s.altnet.rippletest.net:51234/'
      : process.env.XRP_RPC_URL || 'https://s1.ripple.com:51234/';
  const data = (await fetchJson(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      method: 'account_info',
      params: [{ account: address, ledger_index: 'validated', strict: true }],
    }),
  })) as {
    result?: { account_data?: { Balance?: string }; status?: string; error?: string };
  };
  const balanceDrops = data.result?.account_data?.Balance;
  if (!balanceDrops) {
    throw new Error(data.result?.error || 'XRP account_info failed');
  }
  const drops = BigInt(balanceDrops);
  return { raw: drops.toString(), value: formatUnits(drops, 6) };
}

function solanaRpcForChain(chainId: number): string {
  if (chainId === 3002) {
    return process.env.SOLANA_TESTNET_RPC_URL || 'https://api.testnet.solana.com';
  }
  if (chainId === 3003) {
    return process.env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com';
  }
  return process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}

async function solanaBalance(
  address: string,
  chainId: number,
): Promise<{ raw: string; value: number }> {
  const rpc = solanaRpcForChain(chainId);
  const data = (await fetchJson(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [address],
    }),
  })) as { result?: { value?: number }; error?: { message?: string } };
  if (data.error?.message) throw new Error(data.error.message);
  const lamports = Number(data.result?.value ?? 0);
  return { raw: String(lamports), value: lamports / 1e9 };
}

async function fetchNativeBalance(
  chainId: number,
  address: string,
): Promise<{ raw: string; value: number }> {
  if (EVM_RPC[chainId] || STC_EXPLORER[chainId]) return evmBalance(chainId, address);
  if (chainId === 1001 || chainId === 1002) return bitcoinBalance(address, chainId);
  if (chainId === 2001 || chainId === 2002) return xrpBalance(address, chainId);
  if (chainId === 3001 || chainId === 3002 || chainId === 3003) {
    return solanaBalance(address, chainId);
  }
  throw new Error(`Unsupported chain ${chainId}`);
}

export async function fetchBalanceForAddress(
  chainId: number,
  address: string | null | undefined,
  locked = 0,
): Promise<ChainBalance> {
  const symbol = SYMBOL_BY_CHAIN[chainId] || 'TOKEN';
  if (!address) {
    return {
      chainId,
      symbol,
      balance: null,
      balanceRaw: null,
      available: null,
      locked,
      error: 'No address',
    };
  }
  try {
    const { raw, value } = await fetchNativeBalance(chainId, address);
    return {
      chainId,
      symbol,
      balance: value,
      balanceRaw: raw,
      available: Math.max(0, value - locked),
      locked,
    };
  } catch (err) {
    return {
      chainId,
      symbol,
      balance: null,
      balanceRaw: null,
      available: null,
      locked,
      error: err instanceof Error ? err.message : 'Balance fetch failed',
    };
  }
}

export async function fetchBalancesForChains(
  chains: Array<{ chainId: number; address?: string | null; locks?: { total?: number } }>,
): Promise<ChainBalance[]> {
  return Promise.all(
    chains.map((chain) =>
      fetchBalanceForAddress(chain.chainId, chain.address, Number(chain.locks?.total ?? 0) || 0),
    ),
  );
}

/** Run balance fetches with a concurrency limit (avoids hammering RPCs). */
export async function fetchBalancesBatched(
  items: Array<{ chainId: number; address?: string | null; locked?: number }>,
  concurrency = 12,
): Promise<ChainBalance[]> {
  const results: ChainBalance[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      results[index] = await fetchBalanceForAddress(
        item.chainId,
        item.address,
        Number(item.locked ?? 0) || 0,
      );
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
