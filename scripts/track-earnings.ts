/**
 * scripts/track-earnings.ts
 *
 * Snapshots LP earnings daily per position. Computes daily delta and cumulative totals.
 * Appends to memory/earnings.jsonl; prints a summary table.
 *
 * Usage:
 *   node --env-file=.env --import tsx scripts/track-earnings.ts
 *
 * Sources tracked:
 *   1. Uniswap v3 position tokensOwed0/1 (WETH + DIEM uncollected in NFPM)
 *   2. FeeLocker availableFees (DIEM from Liquid Protocol TOKEN/DIEM pool)
 *
 * Note: tokensOwed is only updated on collect()/decreaseLiquidity() calls.
 * The snapshot reflects the last on-chain update, not real-time accrual.
 */

import { createPublicClient, http, formatUnits, type Address } from 'viem';
import { base } from 'viem/chains';
import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { ADDRESSES } from '../platform/constants.js';

// ── ABIs ─────────────────────────────────────────────────────────────

const FEE_LOCKER_ABI = [{
  name: 'availableFees', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'feeOwner', type: 'address' }, { name: 'token', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}] as const;

const NFPM_ABI = [{
  name: 'positions', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'tokenId', type: 'uint256' }],
  outputs: [
    { name: 'nonce', type: 'uint96' }, { name: 'operator', type: 'address' },
    { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' },
    { name: 'fee', type: 'uint24' }, { name: 'tickLower', type: 'int24' },
    { name: 'tickUpper', type: 'int24' }, { name: 'liquidity', type: 'uint128' },
    { name: 'feeGrowthInside0LastX128', type: 'uint256' },
    { name: 'feeGrowthInside1LastX128', type: 'uint256' },
    { name: 'tokensOwed0', type: 'uint128' }, { name: 'tokensOwed1', type: 'uint128' },
  ],
}, {
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
}, {
  name: 'tokenOfOwnerByIndex', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'owner', type: 'address' }, { name: 'index', type: 'uint256' }],
  outputs: [{ name: '', type: 'uint256' }],
}] as const;

const POOL_ABI = [{
  name: 'slot0', type: 'function', stateMutability: 'view',
  inputs: [],
  outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
    { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' },
    { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' },
    { name: 'unlocked', type: 'bool' },
  ],
}] as const;

// ── Types ──────────────────────────────────────────────────────────────

type EarningsSnapshot = {
  date:        string;   // YYYY-MM-DD
  tokenId:     string;
  tickLower:   number;
  tickUpper:   number;
  currentTick: number;
  inRange:     boolean;
  liquidity:   string;   // bigint as string
  tokensOwed0: string;   // WETH wei
  tokensOwed1: string;   // DIEM wei
  feeLocker:   string;   // DIEM wei (Liquid Protocol pool fees)
  // Computed
  totalDiemWei:    string;
  deltaFromPrevWei: string;
  cumDiemCollectedWei: string;
};

type CollectEvent = {
  type:      'collect';
  date:      string;
  tokenId:   string;
  amount0:   string;   // WETH wei
  amount1:   string;   // DIEM wei
  source:    'nfpm' | 'fee_locker';
  txHash?:   string;
};

type LogEntry = EarningsSnapshot | CollectEvent;

// ── Helpers ────────────────────────────────────────────────────────────

function loadJSONL(path: string): LogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l) as LogEntry);
}

function latestSnapshot(entries: LogEntry[], tokenId: string): EarningsSnapshot | null {
  const snaps = entries
    .filter((e): e is EarningsSnapshot => !('type' in e) && e.tokenId === tokenId)
    .sort((a, b) => b.date.localeCompare(a.date));
  return snaps[0] ?? null;
}

function totalCollected(entries: LogEntry[], tokenId: string): bigint {
  return entries
    .filter((e): e is CollectEvent => 'type' in e && e.type === 'collect' && e.tokenId === tokenId)
    .reduce((sum, e) => sum + BigInt(e.amount1), 0n);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const rpcUrl = process.env['RPC_URL'] ?? 'https://mainnet.base.org';
  const agentAddress = process.env['AGENT_WALLET'] as Address | undefined;
  if (!agentAddress) throw new Error('AGENT_WALLET env var required');

  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const today = new Date().toISOString().slice(0, 10);

  mkdirSync('memory', { recursive: true });
  const earningsPath = 'memory/earnings.jsonl';
  const existing = loadJSONL(earningsPath);

  // ── Enumerate LP positions ────────────────────────────────────────
  const nfpmBal = await client.readContract({
    address: ADDRESSES.NFPM_V3, abi: NFPM_ABI, functionName: 'balanceOf', args: [agentAddress],
  });

  // ── FeeLocker ─────────────────────────────────────────────────────
  const feeLockerWei = await client.readContract({
    address: ADDRESSES.FEE_LOCKER, abi: FEE_LOCKER_ABI,
    functionName: 'availableFees', args: [agentAddress, ADDRESSES.DIEM],
  });

  const rows: string[] = [];
  rows.push(`\nEarnings snapshot — ${today}`);
  rows.push(`FeeLocker (Liquid Protocol): ${formatUnits(feeLockerWei, 18)} DIEM claimable`);
  rows.push('');
  rows.push(`${'tokenId'.padEnd(10)} ${'range'.padEnd(14)} ${'tick'.padEnd(6)} ${'status'.padEnd(12)} ${'tokensOwed0 WETH'.padEnd(20)} ${'tokensOwed1 DIEM'.padEnd(20)} ${'daily delta'.padEnd(15)} ${'cumulative'}`);
  rows.push('-'.repeat(120));

  for (let i = 0n; i < nfpmBal; i++) {
    const tokenId = await client.readContract({
      address: ADDRESSES.NFPM_V3, abi: NFPM_ABI,
      functionName: 'tokenOfOwnerByIndex', args: [agentAddress, i],
    });

    const pos = await client.readContract({
      address: ADDRESSES.NFPM_V3, abi: NFPM_ABI,
      functionName: 'positions', args: [tokenId],
    });
    const [, , , token1, , tickLower, tickUpper, liquidity, , , tokensOwed0, tokensOwed1] = pos;

    // Get current tick (assume ETH/DIEM pool if token1 = DIEM)
    let currentTick = 0;
    let inRange = false;
    if (token1.toLowerCase() === ADDRESSES.DIEM.toLowerCase()) {
      const slot0 = await client.readContract({
        address: ADDRESSES.ETH_DIEM_V3, abi: POOL_ABI, functionName: 'slot0',
      });
      currentTick = slot0[1];
      inRange = currentTick > tickLower && currentTick < tickUpper;
    }

    const tokenIdStr = tokenId.toString();
    const prev = latestSnapshot(existing, tokenIdStr);
    const cumCollected = totalCollected(existing, tokenIdStr);

    // total DIEM-equivalent = tokensOwed1 + feeLocker
    const totalDiemWei = tokensOwed1 + feeLockerWei;
    const prevTotal = prev ? BigInt(prev.totalDiemWei) : 0n;
    const delta = totalDiemWei - prevTotal;

    const snap: EarningsSnapshot = {
      date: today,
      tokenId: tokenIdStr,
      tickLower, tickUpper, currentTick, inRange,
      liquidity:           liquidity.toString(),
      tokensOwed0:         tokensOwed0.toString(),
      tokensOwed1:         tokensOwed1.toString(),
      feeLocker:           feeLockerWei.toString(),
      totalDiemWei:        totalDiemWei.toString(),
      deltaFromPrevWei:    delta.toString(),
      cumDiemCollectedWei: cumCollected.toString(),
    };

    // Skip if we already have today's snapshot for this tokenId
    const alreadyToday = existing.some(e => !('type' in e) && e.tokenId === tokenIdStr && e.date === today);
    if (!alreadyToday) {
      appendFileSync(earningsPath, JSON.stringify(snap) + '\n');
    }

    const status = liquidity === 0n ? 'BURNED' : inRange ? 'IN RANGE' : 'OUT';
    const deltaStr = delta >= 0n ? `+${formatUnits(delta, 18)}` : formatUnits(delta, 18);
    const cumStr = formatUnits(cumCollected, 18);

    rows.push(
      `${tokenIdStr.padEnd(10)} ` +
      `[${tickLower},${tickUpper}]`.padEnd(14) + ' ' +
      `${currentTick}`.padEnd(6) + ' ' +
      status.padEnd(12) + ' ' +
      formatUnits(tokensOwed0, 18).slice(0, 18).padEnd(20) + ' ' +
      formatUnits(tokensOwed1, 18).slice(0, 18).padEnd(20) + ' ' +
      deltaStr.slice(0, 13).padEnd(15) + ' ' +
      `${cumStr} DIEM collected`
    );
  }

  console.log(rows.join('\n'));
  console.log(`\nAppended to ${earningsPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
