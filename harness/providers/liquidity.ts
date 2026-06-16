// Single-sided DIEM LP reinvestment into ETH/DIEM Uniswap v3 1% pool on Base.
//
// Strategy: deposit DIEM in a range below current tick (position is above current price).
// The position holds DIEM while price is above range. As DIEM appreciates (tick falls),
// price enters the range, the position earns fees and gradually converts DIEM → WETH.
//
// Pool:    ETH/DIEM v3 1%  (token0=WETH, token1=DIEM)
//          0x80d995189ecc593672aD4703b250a5e82672EB1D
// NFPM:    Uniswap v3 NonfungiblePositionManager on Base
//          0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1
//
// Tick direction: higher tick = more DIEM per WETH (DIEM cheaper).
//   "Less DIEM = more WETH" = DIEM appreciates = tick falls.
//
// Single-sided DIEM mint: tickUpper < currentTick, amount0=0, amount1=diemAmount.
// Each reinvestment mints a fresh position; the agent stores the tokenId in memory
// and can later collect fees or close via the NFPM.

import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ADDRESSES, ETH_DIEM_V3 } from '../../platform/constants.js';
import type { TxSender } from '../safety/wallet.js';

// Read at call time, not module load, so tests can override LP_POSITIONS_PATH
// per-test by setting the env in beforeEach.
function lpPositionsPath(): string {
  return process.env['LP_POSITIONS_PATH'] ?? 'memory/lp-positions.jsonl';
}

// ── ABIs ─────────────────────────────────────────────────────────────

const SLOT0_ABI = [{
  name: 'slot0', type: 'function', stateMutability: 'view',
  inputs: [],
  outputs: [
    { name: 'sqrtPriceX96',               type: 'uint160' },
    { name: 'tick',                        type: 'int24'   },
    { name: 'observationIndex',            type: 'uint16'  },
    { name: 'observationCardinality',      type: 'uint16'  },
    { name: 'observationCardinalityNext',  type: 'uint16'  },
    { name: 'feeProtocol',                 type: 'uint8'   },
    { name: 'unlocked',                    type: 'bool'    },
  ],
}] as const;

const ERC20_APPROVE_ABI = [{
  name: 'approve', type: 'function', stateMutability: 'nonpayable',
  inputs: [
    { name: 'spender', type: 'address' },
    { name: 'amount',  type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bool' }],
}] as const;

const NFPM_MINT_ABI = [{
  name: 'mint', type: 'function', stateMutability: 'payable',
  inputs: [{
    name: 'params', type: 'tuple',
    components: [
      { name: 'token0',         type: 'address' },
      { name: 'token1',         type: 'address' },
      { name: 'fee',            type: 'uint24'  },
      { name: 'tickLower',      type: 'int24'   },
      { name: 'tickUpper',      type: 'int24'   },
      { name: 'amount0Desired', type: 'uint256' },
      { name: 'amount1Desired', type: 'uint256' },
      { name: 'amount0Min',     type: 'uint256' },
      { name: 'amount1Min',     type: 'uint256' },
      { name: 'recipient',      type: 'address' },
      { name: 'deadline',       type: 'uint256' },
    ],
  }],
  outputs: [
    { name: 'tokenId',   type: 'uint256' },
    { name: 'liquidity', type: 'uint128' },
    { name: 'amount0',   type: 'uint256' },
    { name: 'amount1',   type: 'uint256' },
  ],
}] as const;

// IncreaseLiquidity event on NFPM — fires both on mint() and on
// increaseLiquidity(). The mint receipt's IncreaseLiquidity log carries
// the new tokenId, which we need to address the position in subsequent
// adds / collects / decreases.
const NFPM_INCREASE_LIQUIDITY_EVENT_ABI = [{
  type: 'event', name: 'IncreaseLiquidity',
  inputs: [
    { name: 'tokenId',   type: 'uint256', indexed: true  },
    { name: 'liquidity', type: 'uint128', indexed: false },
    { name: 'amount0',   type: 'uint256', indexed: false },
    { name: 'amount1',   type: 'uint256', indexed: false },
  ],
}] as const;

// Top up an EXISTING position by tokenId — single-sided DIEM only
// (amount0Desired=0). Use this instead of mint() when the agent already
// has a position whose tick range still aligns with current strategy,
// to save the cost of opening a fresh NFT each tick.
const NFPM_INCREASE_LIQUIDITY_ABI = [{
  name: 'increaseLiquidity', type: 'function', stateMutability: 'payable',
  inputs: [{
    name: 'params', type: 'tuple',
    components: [
      { name: 'tokenId',        type: 'uint256' },
      { name: 'amount0Desired', type: 'uint256' },
      { name: 'amount1Desired', type: 'uint256' },
      { name: 'amount0Min',     type: 'uint256' },
      { name: 'amount1Min',     type: 'uint256' },
      { name: 'deadline',       type: 'uint256' },
    ],
  }],
  outputs: [
    { name: 'liquidity', type: 'uint128' },
    { name: 'amount0',   type: 'uint256' },
    { name: 'amount1',   type: 'uint256' },
  ],
}] as const;

// ── Tick helpers ──────────────────────────────────────────────────────

// Largest multiple of spacing that is strictly less than tick.
// For DIEM single-sided deposit (token1): tickUpper must be < currentTick.
function tickBelowCurrent(currentTick: number, spacing: number): number {
  return Math.floor((currentTick - 1) / spacing) * spacing;
}

// ── Types ─────────────────────────────────────────────────────────────

export type TickRange = 'short' | 'medium';  // short=2 spacings, medium=5 spacings

export type ReinvestResult = {
  approveTxHash: Hex;
  mintTxHash:    Hex;
  /** NFPM tokenId of the newly-minted position, parsed from the mint
   *  receipt's IncreaseLiquidity event. Persisted to
   *  memory/lp-positions.jsonl so subsequent ticks can address the
   *  position for fee-collect / increase / close without re-minting. */
  tokenId:       bigint;
  /** Liquidity units minted (uint128). */
  liquidity:     bigint;
  tickLower:     number;
  tickUpper:     number;
  currentTick:   number;
};

/** One row in memory/lp-positions.jsonl. Append-only log; latest line is the
 *  freshest. Persisted as strings so BigInts survive JSON round-trips. */
export interface LpPosition {
  tokenId:     string;     // uint256 as decimal string
  liquidity:   string;     // uint128 as decimal string
  tickLower:   number;
  tickUpper:   number;
  amount1Wei:  string;     // DIEM deposited at mint, decimal string
  mintTxHash:  Hex;
  mintedAt:    string;     // ISO-8601
}

function appendLpPosition(row: LpPosition): void {
  const path = lpPositionsPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(row) + '\n', 'utf8');
}

/** Read the most recent position from the log. Returns null when the
 *  file doesn't exist OR is empty. Newest line wins — append-only
 *  semantics mean we never have to scan the whole file looking for "the
 *  latest" except on cold start; in practice the tick loop will cache. */
export function loadLatestLpPosition(): LpPosition | null {
  const path = lpPositionsPath();
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(last) as LpPosition;
  } catch {
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────

export async function reinvestToLP(
  rpcUrl:        string,
  agentAddress:  Address,
  diemAmount:    bigint,
  range:         TickRange,
  txSender:      TxSender,
  publicClient?: ReturnType<typeof createPublicClient>,
): Promise<ReinvestResult> {
  const client = publicClient ?? createPublicClient({ chain: base, transport: http(rpcUrl) });

  // 1. Read current tick from pool slot0.
  const slot0 = await client.readContract({
    address: ADDRESSES.ETH_DIEM_V3,
    abi:     SLOT0_ABI,
    functionName: 'slot0',
  });
  const currentTick = slot0[1];  // int24 returned as number by viem

  // 2. Compute tick range below current tick for single-sided DIEM deposit.
  //    tickUpper < currentTick  →  position holds only token1 (DIEM) at mint.
  //    As DIEM appreciates (tick falls), position earns fees converting DIEM → WETH.
  const n = range === 'short' ? 2 : 5;
  const tickUpper = tickBelowCurrent(currentTick, ETH_DIEM_V3.TICK_SPACING);
  const tickLower = tickUpper - n * ETH_DIEM_V3.TICK_SPACING;

  // 3. Approve DIEM to NonfungiblePositionManager.
  const approveData = encodeFunctionData({
    abi:          ERC20_APPROVE_ABI,
    functionName: 'approve',
    args:         [ADDRESSES.NFPM_V3, diemAmount],
  });
  const approveTxHash = await txSender({ to: ADDRESSES.DIEM, data: approveData });

  // Wait for approve to land before minting.
  await client.waitForTransactionReceipt({ hash: approveTxHash });

  // 4. Mint single-sided DIEM position.
  //    amount0Desired = 0 (no WETH needed), amount1Desired = diemAmount.
  //    amount1Min = 0 to tolerate minor price drift between approve and mint.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);  // 10 min
  const mintData = encodeFunctionData({
    abi:          NFPM_MINT_ABI,
    functionName: 'mint',
    args: [{
      token0:         ADDRESSES.WETH,
      token1:         ADDRESSES.DIEM,
      fee:            ETH_DIEM_V3.FEE,
      tickLower,
      tickUpper,
      amount0Desired: 0n,
      amount1Desired: diemAmount,
      amount0Min:     0n,
      amount1Min:     diemAmount * 99n / 100n,  // 1% slippage tolerance
      recipient:      agentAddress,
      deadline,
    }],
  });
  const mintTxHash = await txSender({ to: ADDRESSES.NFPM_V3, data: mintData });

  // Wait for the mint to land and decode the IncreaseLiquidity log so we
  // can persist the tokenId. The agent needs the tokenId to address the
  // position in future collect / increase / decrease / burn calls.
  const receipt = await client.waitForTransactionReceipt({ hash: mintTxHash });
  const logs = parseEventLogs({
    abi:    NFPM_INCREASE_LIQUIDITY_EVENT_ABI,
    logs:   receipt.logs,
    eventName: 'IncreaseLiquidity',
  });
  // NFPM.mint() emits exactly one IncreaseLiquidity per call, addressed
  // from the NFPM contract. If we see zero, the mint didn't land cleanly.
  const ours = logs.find((l) => l.address.toLowerCase() === ADDRESSES.NFPM_V3.toLowerCase());
  if (!ours) {
    throw new Error(
      `mint receipt for ${mintTxHash} contained no IncreaseLiquidity log from NFPM ${ADDRESSES.NFPM_V3}`,
    );
  }
  const tokenId = ours.args.tokenId;
  const liquidity = ours.args.liquidity;

  appendLpPosition({
    tokenId:    tokenId.toString(),
    liquidity:  liquidity.toString(),
    tickLower,
    tickUpper,
    amount1Wei: diemAmount.toString(),
    mintTxHash,
    mintedAt:   new Date().toISOString(),
  });

  console.log(
    `[liquidity] reinvested ${diemAmount} DIEM | ` +
    `pool=ETH/DIEM v3 1% | ` +
    `ticks=[${tickLower}, ${tickUpper}] currentTick=${currentTick} | ` +
    `tokenId=${tokenId}`,
  );

  return {
    approveTxHash,
    mintTxHash,
    tokenId,
    liquidity,
    tickLower,
    tickUpper,
    currentTick,
  };
}

// ── increaseLiquidity ────────────────────────────────────────────────

/**
 * Top up an existing NFPM position (single-sided DIEM) by tokenId.
 * Caller is responsible for choosing a tokenId whose tick range still
 * makes sense for the current strategy — typically a position whose
 * `tickUpper < currentTick` (still single-sided DIEM).
 *
 * Not auto-wired into the tick loop yet: the agent decides whether to
 * topup an existing position vs mint fresh based on tick-range fit +
 * gas economics. The tick.ts accumulate-mode currently always mints
 * fresh; flip to `loadLatestLpPosition()` + this helper when ready.
 */
export async function increaseLpLiquidity(
  rpcUrl:       string,
  tokenId:      bigint,
  diemAmount:   bigint,
  txSender:     TxSender,
  publicClient?: ReturnType<typeof createPublicClient>,
): Promise<{ approveTxHash: Hex; addTxHash: Hex; liquidityAdded: bigint }> {
  const client = publicClient ?? createPublicClient({ chain: base, transport: http(rpcUrl) });

  const approveData = encodeFunctionData({
    abi:          ERC20_APPROVE_ABI,
    functionName: 'approve',
    args:         [ADDRESSES.NFPM_V3, diemAmount],
  });
  const approveTxHash = await txSender({ to: ADDRESSES.DIEM, data: approveData });
  await client.waitForTransactionReceipt({ hash: approveTxHash });

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const addData = encodeFunctionData({
    abi:          NFPM_INCREASE_LIQUIDITY_ABI,
    functionName: 'increaseLiquidity',
    args: [{
      tokenId,
      amount0Desired: 0n,
      amount1Desired: diemAmount,
      amount0Min:     0n,
      amount1Min:     diemAmount * 99n / 100n,
      deadline,
    }],
  });
  const addTxHash = await txSender({ to: ADDRESSES.NFPM_V3, data: addData });

  const receipt = await client.waitForTransactionReceipt({ hash: addTxHash });
  const logs = parseEventLogs({
    abi:       NFPM_INCREASE_LIQUIDITY_EVENT_ABI,
    logs:      receipt.logs,
    eventName: 'IncreaseLiquidity',
  });
  const ours = logs.find(
    (l) =>
      l.address.toLowerCase() === ADDRESSES.NFPM_V3.toLowerCase() &&
      l.args.tokenId === tokenId,
  );
  const liquidityAdded = ours?.args.liquidity ?? 0n;

  console.log(
    `[liquidity] increased tokenId=${tokenId} +${diemAmount} DIEM | liquidity+=${liquidityAdded}`,
  );

  return { approveTxHash, addTxHash, liquidityAdded };
}
