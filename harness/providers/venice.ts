// Venice provider — claim LP DIEM fees → mint Venice API key → call inference.
//
// Required env vars:
//   DIEM_TOKEN_ADDRESS     — Liquid Protocol DIEM ERC-20 on Base mainnet (fee token)
//   VVV_STAKING_ADDRESS    — Venice VVV staking contract on Base (sVVV balance gates key mint)
//                            Fallback alias: VENICE_STAKING_ADDRESS
//   RPC_URL                — Base mainnet JSON-RPC endpoint
//
// Optional env vars:
//   VENICE_API_KEY           — Skip autonomous key mint; use this key directly (MVP fast path)
//   VENICE_STAKE_THRESHOLD   — min sVVV wei before Venice key mint triggers (default: 1e18 = 1 VVV)
//   VENICE_BEARER_CACHE_PATH — where to persist the minted key (default: memory/venice-bearer.json)
//   VENICE_API_BASE          — Venice API base URL (default: https://api.venice.ai/api/v1)
//   VENICE_MODEL             — inference model slug (default: llama-3.3-70b)
//
// Venice two-step model:
//   • API key mint  — requires sVVV balance (staked VVV); one-time per agent
//   • Inference spend — draws from Venice DIEM credits (earned via VVV staking); separate from LP DIEM
//
// Key mint flow: GET /api_keys/generate_web3_key → personal_sign(token) → POST /api_keys/generate_web3_key
//
// On-chain write functions accept a TxSender (from wallet.ts), abstracting the signing substrate.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseEther,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import { ADDRESSES } from '../../platform/constants.js';
import { assertAllowed } from '../safety/allowlist.js';
import { emit, type ToolRoutingEntry } from '../observability/tool-routing.js';
import type { Signer, TxSender } from '../safety/wallet.js';

// ── Minimal ABIs ────────────────────────────────────────────────────

const FEE_LOCKER_ABI = [
  {
    type: 'function', name: 'availableFees',
    inputs: [{ name: 'feeOwner', type: 'address' }, { name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view',
  },
  {
    type: 'function', name: 'claim',
    inputs: [{ name: 'feeOwner', type: 'address' }, { name: 'token', type: 'address' }],
    outputs: [], stateMutability: 'nonpayable',
  },
] as const;

const ERC20_ABI = [
  {
    type: 'function', name: 'decimals',
    inputs: [], outputs: [{ name: '', type: 'uint8' }], stateMutability: 'view',
  },
  {
    type: 'function', name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view',
  },
] as const;

// ── Staking contracts (two distinct systems) ────────────────────────
//
// An agent participates in TWO independent stakes in the Venice ecosystem:
//
//   1. VVV → sVVV   (one-time, API-key gate)
//      Stake VVV on the sVVV contract (0x321b7ff75…) to mint sVVV tokens.
//      sVVV balance gates `mintVeniceKey` — without enough sVVV, the API
//      key request is rejected. ERC-20: VVV ➜ approve ➜ stake(address, uint256).
//      sVVV holds the receipt; balanceOf(account) on the sVVV contract
//      returns the staked amount.
//
//   2. DIEM → staked DIEM   (per-tick, compute budget)
//      Per Architecture v2, the DIEM contract IS its own staking contract.
//      Call stake(uint256) directly on the DIEM token (0xF4d97F2d…) with
//      no approve step. The DIEM contract tracks staked positions via
//      `stakedInfos(address)` which returns (amountStaked, coolDownEnd,
//      coolDownAmount). Note: balanceOf(address) on DIEM returns LIQUID
//      wallet balance, NOT staked — using balanceOf for the staked check
//      is a bug. Use stakedInfos(account).amountStaked.
//
// Compute is paid from staked DIEM at the $1/DIEM/day rate. sVVV is the
// access gate; sDIEM is the spend mechanism. sVVV ≠ sDIEM.

const DIEM_STAKING_ABI = [
  {
    type: 'function', name: 'stake',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [], stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'stakedInfos',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [
      { name: 'amountStaked', type: 'uint256' },
      { name: 'coolDownEnd', type: 'uint256' },
      { name: 'coolDownAmount', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
] as const;

const SVVV_STAKING_ABI = [
  {
    type: 'function', name: 'stake',
    inputs: [
      { name: 'staker', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [], stateMutability: 'nonpayable',
  },
  {
    type: 'function', name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view',
  },
] as const;

const VVV_ERC20_APPROVE_ABI = [
  {
    type: 'function', name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }], stateMutability: 'nonpayable',
  },
] as const;

// ── Model constants ──────────────────────────────────────────────────

export const FAST_MODEL = 'llama-3.3-70b';
export const REASONING_MODEL = 'claude-opus-4-7';

// DIEM per 1M tokens (Venice rates, 2026-05). llama is free under VVV staking.
const DIEM_PRICE: Record<string, { input: number; output: number }> = {
  'claude-opus-4-7': { input: 6, output: 30 },
  'llama-3.3-70b':   { input: 0, output: 0 },
};

function diemCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = DIEM_PRICE[model] ?? { input: 0, output: 0 };
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

// ── Config ──────────────────────────────────────────────────────────

export type VeniceConfig = {
  diemAddress: Address;        // DIEM token = its own staking contract
  vvvAddress: Address;         // VVV ERC-20 token (for stakeVvv approve)
  vvvStakingAddress: Address;  // sVVV contract (mints sVVV from staked VVV)
  rpcUrl: string;
  svvvThreshold: bigint;       // min sVVV wei to pass Venice API key gate
  minDiemWei: bigint;          // min DIEM amount to bother claiming / LPing / staking per tick
  bearerCachePath: string;
  veniceApiBase: string;
  model: string;
};

export function loadConfig(): VeniceConfig {
  const diemAddress = process.env['DIEM_TOKEN_ADDRESS'];
  // Default to known mainnet addresses if unset — these are well-known
  // public contracts, not secrets. Env override is for testnets / forks.
  const vvvAddress =
    process.env['VVV_TOKEN_ADDRESS'] ?? '0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf';
  const vvvStakingAddress =
    process.env['VVV_STAKING_ADDRESS'] ??
    process.env['VENICE_STAKING_ADDRESS'] ??
    '0x321b7ff75154472b18edb199033ff4d116f340ff';
  const rpcUrl = process.env['RPC_URL'];
  if (!diemAddress) throw new Error('DIEM_TOKEN_ADDRESS is required');
  if (!rpcUrl) throw new Error('RPC_URL is required');
  return {
    diemAddress: diemAddress as Address,
    vvvAddress: vvvAddress as Address,
    vvvStakingAddress: vvvStakingAddress as Address,
    rpcUrl,
    svvvThreshold: BigInt(process.env['VENICE_STAKE_THRESHOLD'] ?? String(parseEther('1'))),
    minDiemWei: BigInt(process.env['MIN_DIEM_WEI'] ?? String(parseEther('0.01'))),
    bearerCachePath: process.env['VENICE_BEARER_CACHE_PATH'] ?? 'memory/venice-bearer.json',
    veniceApiBase: process.env['VENICE_API_BASE'] ?? 'https://api.venice.ai/api/v1',
    model: process.env['VENICE_MODEL'] ?? 'llama-3.3-70b',
  };
}

// ── On-chain reads ──────────────────────────────────────────────────

export function makePublicClient(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

type BasePublicClient = ReturnType<typeof makePublicClient>;

export async function getClaimable(
  config: VeniceConfig,
  agentAddress: Address,
  publicClient: BasePublicClient = makePublicClient(config.rpcUrl),
): Promise<bigint> {
  const decimals = await publicClient.readContract({
    address: config.diemAddress,
    abi: ERC20_ABI,
    functionName: 'decimals',
  });
  if (decimals !== 18) throw new Error(`DIEM decimals() = ${decimals}, expected 18`);

  return publicClient.readContract({
    address: ADDRESSES.FEE_LOCKER,
    abi: FEE_LOCKER_ABI,
    functionName: 'availableFees',
    args: [agentAddress, config.diemAddress],
  });
}

// Actual DIEM wallet balance — read after claim to get the real mintable amount.
export async function getDiemBalance(
  config: VeniceConfig,
  agentAddress: Address,
  publicClient: BasePublicClient = makePublicClient(config.rpcUrl),
): Promise<bigint> {
  return publicClient.readContract({
    address: config.diemAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [agentAddress],
  });
}

/**
 * sVVV balance on the Venice staking contract — gates Venice API key mint.
 * sVVV is the receipt token: balanceOf(account) on the sVVV contract IS
 * the staked-VVV amount (1:1). This is the gate; if it's above
 * `svvvThreshold` the agent can mint a Venice API key. Growing it is a
 * one-time operation via `stakeVvv` at agent provisioning — NOT
 * something tick.ts should do per cycle.
 */
export async function getSvvvBalance(
  config: VeniceConfig,
  agentAddress: Address,
  publicClient: BasePublicClient = makePublicClient(config.rpcUrl),
): Promise<bigint> {
  return publicClient.readContract({
    address: config.vvvStakingAddress,
    abi: SVVV_STAKING_ABI,
    functionName: 'balanceOf',
    args: [agentAddress],
  });
}

/**
 * Staked DIEM amount. DIEM is its own staking contract per Architecture v2;
 * the staked balance is exposed through `stakedInfos(address)` which
 * returns a struct (amountStaked, coolDownEnd, coolDownAmount). DO NOT
 * use `balanceOf(account)` on the DIEM contract for this — that returns
 * the LIQUID wallet balance (separate from staked).
 *
 * sDIEM is the agent's compute budget: each staked DIEM unlocks $1/day
 * of Venice inference (the load-bearing economic assumption — see
 * dune/agent-fleet-overview.sql).
 */
export async function getSdiemStaked(
  config: VeniceConfig,
  agentAddress: Address,
  publicClient: BasePublicClient = makePublicClient(config.rpcUrl),
): Promise<bigint> {
  const [amountStaked] = (await publicClient.readContract({
    address: config.diemAddress,
    abi: DIEM_STAKING_ABI,
    functionName: 'stakedInfos',
    args: [agentAddress],
  })) as [bigint, bigint, bigint];
  return amountStaked;
}

// ── On-chain writes ─────────────────────────────────────────────────

// Claim accrued LP DIEM fees from FeeLocker to agent wallet.
export async function claimDiem(
  config: VeniceConfig,
  agentAddress: Address,
  txSender: TxSender,
): Promise<Hex> {
  const data = encodeFunctionData({
    abi: FEE_LOCKER_ABI,
    functionName: 'claim',
    args: [agentAddress, config.diemAddress],
  });
  return txSender({ to: ADDRESSES.FEE_LOCKER, data });
}

/**
 * Stake DIEM directly on the DIEM contract (it's its own staking contract
 * per Architecture v2; no ERC-20 approve required). Grows the agent's
 * sDIEM balance, which is its compute budget at $1/DIEM/day. Called
 * per-tick from `tick.ts` to convert claimed fees into ongoing inference
 * runway.
 *
 * Read the result via `getSdiemStaked` (stakedInfos.amountStaked) — NOT
 * `getDiemBalance` (which returns liquid wallet balance, separate from
 * staked).
 */
export async function stakeDiem(
  config: VeniceConfig,
  amount: bigint,
  txSender: TxSender,
): Promise<Hex> {
  const data = encodeFunctionData({
    abi: DIEM_STAKING_ABI,
    functionName: 'stake',
    args: [amount],
  });
  return txSender({ to: config.diemAddress, data });
}

/**
 * Stake VVV on the sVVV contract — one-time setup, NOT called per tick.
 * Required to unlock the Venice API key mint (sVVV-gate). Two on-chain
 * txs: ERC-20 approve of the sVVV contract on the VVV token, then
 * stake(staker, amount) on the sVVV contract. Caller waits for the
 * approve receipt before calling stake.
 *
 * Returns BOTH tx hashes so the caller can confirm each step. Lives in
 * this module for parity with stakeDiem, but the lifecycle owner is
 * provisioning (cli-launcher / `scripts/stake-vvv.ts`) rather than the
 * tick loop.
 */
export async function stakeVvv(
  config: VeniceConfig,
  staker: Address,
  amount: bigint,
  txSender: TxSender,
): Promise<{ approveHash: Hex; stakeHash: Hex }> {
  const approveHash = await txSender({
    to: config.vvvAddress,
    data: encodeFunctionData({
      abi: VVV_ERC20_APPROVE_ABI,
      functionName: 'approve',
      args: [config.vvvStakingAddress, amount],
    }),
  });
  const stakeHash = await txSender({
    to: config.vvvStakingAddress,
    data: encodeFunctionData({
      abi: SVVV_STAKING_ABI,
      functionName: 'stake',
      args: [staker, amount],
    }),
  });
  return { approveHash, stakeHash };
}

// ── Venice key mint ─────────────────────────────────────────────────

// Flow: GET /api_keys/generate_web3_key → personal_sign(token) → POST /api_keys/generate_web3_key
// Requires sVVV balance on Base (staked VVV via Venice staking contract).
export async function mintVeniceKey(
  config: VeniceConfig,
  signer: Signer,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  // 1. Get a short-lived JWT (15-min expiry, unauthenticated).
  const tokenRes = await fetchFn(`${config.veniceApiBase}/api_keys/generate_web3_key`);
  if (!tokenRes.ok) throw new Error(`Venice token fetch failed: ${tokenRes.status}`);
  const { data: { token } } = await tokenRes.json() as { data: { token: string } };

  // 2. Sign the raw token string — proves ownership of a wallet with sVVV balance.
  const signature = await signer.signMessage({ message: token });

  // 3. Mint a durable inference API key.
  const mintRes = await fetchFn(`${config.veniceApiBase}/api_keys/generate_web3_key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: signer.address,
      signature,
      token,
      apiKeyType: 'INFERENCE',
      description: 'agent-autonomous',
    }),
  });
  if (!mintRes.ok) throw new Error(`Venice key mint failed: ${mintRes.status}`);
  const mintBody = await mintRes.json() as { data?: { apiKey?: string }; apiKey?: string };
  const apiKey = mintBody.data?.apiKey ?? mintBody.apiKey;
  if (!apiKey) throw new Error(`Venice key mint: no apiKey in response: ${JSON.stringify(mintBody)}`);
  return apiKey;
}

// ── Bearer cache ────────────────────────────────────────────────────

export function loadCachedBearer(cachePath: string): string | null {
  if (!existsSync(cachePath)) return null;
  try {
    const data = JSON.parse(readFileSync(cachePath, 'utf8')) as { bearer: string };
    return data.bearer ?? null;
  } catch {
    return null;
  }
}

export function saveBearer(cachePath: string, bearer: string): void {
  assertAllowed(cachePath);
  writeFileSync(cachePath, JSON.stringify({ bearer }), 'utf8');
}

export async function loadOrMintBearer(
  config: VeniceConfig,
  signer: Signer,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  // Fast path: manually provided key (MVP fallback; autonomous mint is the production path).
  const envKey = process.env['VENICE_API_KEY'];
  if (envKey) return envKey;

  const cached = loadCachedBearer(config.bearerCachePath);
  if (cached) return cached;

  const bearer = await mintVeniceKey(config, signer, fetchFn);
  saveBearer(config.bearerCachePath, bearer);
  return bearer;
}

// ── Inference ───────────────────────────────────────────────────────

export type InferenceOpts = {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  model?: string;  // overrides config.model for this call
};

export async function callInference(
  config: VeniceConfig,
  bearer: string,
  opts: InferenceOpts,
  logPath: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const model = opts.model ?? config.model;
  const start = Date.now();
  const res = await fetchFn(`${config.veniceApiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({
      model,
      messages: [
        ...(opts.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : []),
        { role: 'user', content: opts.prompt },
      ],
      max_tokens: opts.maxTokens ?? 512,
      stream: false,
    }),
  });
  if (!res.ok) throw new Error(`Venice inference failed: ${res.status}`);

  const latency_ms = Date.now() - start;
  const data = await res.json() as {
    choices: { message: { content: string } }[];
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  const entry: ToolRoutingEntry = {
    ts: new Date().toISOString(),
    provider: 'venice',
    variant: `:${model}`,
    cache_hit: false,
    latency_ms,
    tokens: { input: data.usage.prompt_tokens, output: data.usage.completion_tokens },
    cost_usd: 0,
    cost_diem: diemCost(model, data.usage.prompt_tokens, data.usage.completion_tokens),
  };
  emit(entry, logPath);

  return data.choices[0]?.message.content ?? '';
}
