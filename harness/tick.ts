// Main tick loop — one execution per Modal invocation (v0).
//
// Inference routing:
//   fast   → llama-3.3-70b (free under VVV staking) — planning, classification, cheap calls
//   reason → claude-opus-4-7 (6/30 DIEM per 1M in/out) — reasoning, only when warranted
//
// Flow per tick:
//   1. Claim LP DIEM fees if ≥ threshold
//   2. Verify sVVV balance gates Venice key access
//   3. Load or mint Venice bearer
//   4. Fast call: classify the tick task and decide if deep reasoning is needed
//   5. Reason call (conditional): do the substantive work with Opus 4.7
//
// Run locally:  npm run harness:tick

import { mkdirSync } from 'node:fs';
import { encodeFunctionData } from 'viem';
import { ADDRESSES } from '../platform/constants.js';
import {
  loadConfig as loadVeniceConfig,
  makePublicClient,
  getClaimable,
  getDiemBalance,
  getSvvvBalance,
  getSdiemStaked,
  claimDiem,
  stakeDiem,
  loadOrMintBearer,
  callInference,
  FAST_MODEL,
  REASONING_MODEL,
} from './providers/venice.js';
import { reinvestToLP } from './providers/liquidity.js';
import {
  loadPrivyConfig,
  loadSignerFromPrivy,
  makeTxSenderFromPrivy,
  loadSignerFromEnv,
  makeTxSenderFromEnv,
  type Signer,
  type TxSender,
} from './safety/wallet.js';

// ── Types ────────────────────────────────────────────────────────────

export type TickDeps = {
  signer: Signer;
  txSender: TxSender;
};

// ── Mode ─────────────────────────────────────────────────────────────

// accumulate: LP claimed DIEM into ETH/DIEM v3 pool; run on free llama only.
// build:      stake yield for Venice Opus credits; run product-building ticks.
// Controlled by AGENT_MODE env var until on-chain daily-rate determination is wired.
const AGENT_MODE = (process.env['AGENT_MODE'] ?? 'accumulate') as 'accumulate' | 'build';

// ── Bootstrap ────────────────────────────────────────────────────────

export async function loadTickDeps(): Promise<TickDeps> {
  if (process.env['PRIVY_APP_ID']) {
    const cfg = loadPrivyConfig();
    const signer = await loadSignerFromPrivy(cfg);
    // Pass the agent's own address so it joins the destination allowlist.
    const txSender = makeTxSenderFromPrivy(cfg, fetch, signer.address);
    return { signer, txSender };
  }
  const signer = loadSignerFromEnv();
  const { rpcUrl } = loadVeniceConfig();
  const txSender = makeTxSenderFromEnv(rpcUrl);
  return { signer, txSender };
}

// ── Model routing helpers ────────────────────────────────────────────

const LOG_PATH = process.env['TOOL_ROUTING_LOG'] ?? 'memory/tool-routing.jsonl';

type InferCtx = { config: ReturnType<typeof loadVeniceConfig>; bearer: string };

async function callFast(ctx: InferCtx, prompt: string, opts: { maxTokens?: number; systemPrompt?: string } = {}): Promise<string> {
  return callInference(ctx.config, ctx.bearer, { ...opts, model: FAST_MODEL, prompt }, LOG_PATH);
}

async function callReason(ctx: InferCtx, prompt: string, opts: { maxTokens?: number; systemPrompt?: string } = {}): Promise<string> {
  return callInference(ctx.config, ctx.bearer, { ...opts, model: REASONING_MODEL, prompt }, LOG_PATH);
}

// ── Tick ─────────────────────────────────────────────────────────────

// Fast model returns a JSON decision: { needs_reasoning: bool, task: string, rationale: string }
const PLAN_SYSTEM = `You are the agent's planning layer.
Given the current tick context, decide whether this tick requires deep reasoning (claude-opus-4-7) or a simple fast response (llama).
Respond with valid JSON only:
{ "needs_reasoning": <bool>, "task": "<one-line task description>", "rationale": "<why>" }`;

const REASON_SYSTEM = `You are a self-funding autonomous agent on Base.
You earn LP DIEM fees, stake them for Venice inference credits, and grow your capabilities over time.
Complete the assigned task thoughtfully. Be concrete and brief.`;

export async function runTick(deps: TickDeps): Promise<void> {
  const { signer, txSender } = deps;
  const agentAddress = signer.address;
  const config = loadVeniceConfig();
  const publicClient = makePublicClient(config.rpcUrl);

  // Guarantee memory/ exists before any write — tool-routing log,
  // bearer cache, lp-positions, etc. all land here. A fresh agent
  // repo doesn't have this dir until something creates it.
  mkdirSync('memory', { recursive: true });

  console.log(`[tick] mode=${AGENT_MODE}`);

  // 1. Claim LP DIEM fees from FeeLocker whenever above the per-tick
  //    minimum (don't burn gas on dust amounts).
  const claimable = await getClaimable(config, agentAddress, publicClient);
  if (claimable >= config.minDiemWei) {
    const claimHash = await claimDiem(config, agentAddress, txSender);
    await publicClient.waitForTransactionReceipt({ hash: claimHash });
    console.log(`[tick] claimed ${claimable} DIEM`);
  }

  // 1a. Accumulate mode: LP any DIEM sitting in wallet (from this claim or a prior
  //     incomplete tick where RPC lag caused getDiemBalance to return 0).
  //     If no DIEM to LP, fall through to llama maintenance inference (free).
  if (AGENT_MODE === 'accumulate') {
    const diemBalance = await getDiemBalance(config, agentAddress, publicClient);
    console.log(`[tick] wallet DIEM: ${diemBalance}`);
    if (diemBalance >= config.minDiemWei) {
      const lp = await reinvestToLP(config.rpcUrl, agentAddress, diemBalance, 'short', txSender);
      await publicClient.waitForTransactionReceipt({ hash: lp.mintTxHash });
      console.log(`[tick] LP reinvested | ticks=[${lp.tickLower},${lp.tickUpper}] currentTick=${lp.currentTick}`);
      return;  // LP done — skip inference this tick
    }
    console.log(`[tick] wallet DIEM below threshold — running maintenance inference`);
  }

  // 1c. Per-tick DIEM stake — grows the agent's compute budget. DIEM
  //     is its own staking contract per Architecture v2; stake(uint256)
  //     directly, no approve. Compute is paid at $1/staked-DIEM/day, so
  //     every DIEM we move from wallet → staked extends our inference
  //     runway. NOT the same as sVVV staking (one-time, separate
  //     contract, governs API-key access — handled at provisioning, not
  //     here).
  const walletDiem = await getDiemBalance(config, agentAddress, publicClient);
  if (walletDiem >= config.minDiemWei) {
    const stakeHash = await stakeDiem(config, walletDiem, txSender);
    await publicClient.waitForTransactionReceipt({ hash: stakeHash });
    console.log(`[tick] staked ${walletDiem} DIEM → sDIEM (compute budget)`);
  }

  // 2. sVVV gates the Venice API key mint. This is the one-time access
  //    gate (separate from sDIEM compute budget); if it's not satisfied,
  //    the agent was never provisioned with enough VVV-staking. Don't
  //    auto-stake VVV from the tick — that's a deliberate setup step
  //    (cli-launcher / scripts/stake-vvv.ts via the stakeVvv helper).
  const svvv = await getSvvvBalance(config, agentAddress, publicClient);
  if (svvv < config.svvvThreshold) {
    console.log(`[tick] sVVV=${svvv} below threshold=${config.svvvThreshold} — agent not provisioned with VVV stake; skipping inference`);
    return;
  }

  // 3. sDIEM is the compute budget. Logging only — Venice meters from
  //    staked DIEM at the $1/day rate, so a thin budget produces fewer
  //    Opus calls. The fast-path llama is free regardless.
  const sdiem = await getSdiemStaked(config, agentAddress, publicClient);
  console.log(`[tick] compute budget: sDIEM=${sdiem} (~ \$${Number(sdiem) / 1e18}/day at the load-bearing rate)`);

  // 3. Load bearer (cached after first mint).
  const bearer = await loadOrMintBearer(config, signer);
  const ctx: InferCtx = { config, bearer };

  // 4. Fast call: plan the tick — decide if Opus 4.7 is needed.
  const tickContext = `Current tick. Agent wallet: ${agentAddress}. claimable DIEM: ${claimable}. sVVV (API gate): ${svvv}. sDIEM (compute budget): ${sdiem}.`;
  const planRaw = await callFast(ctx, tickContext, { systemPrompt: PLAN_SYSTEM, maxTokens: 128 });
  console.log(`[tick] fast plan: ${planRaw.trim()}`);

  let plan: { needs_reasoning: boolean; task: string; rationale: string };
  try {
    plan = JSON.parse(planRaw) as typeof plan;
  } catch {
    // If fast model didn't return valid JSON, skip reasoning and log the raw reply.
    console.log('[tick] plan parse failed — skipping reason step');
    return;
  }

  // 5. Reason call (conditional): Opus 4.7 only when the fast model says it's warranted.
  if (plan.needs_reasoning) {
    console.log(`[tick] routing to ${REASONING_MODEL}: ${plan.task}`);
    const result = await callReason(ctx, plan.task, { systemPrompt: REASON_SYSTEM, maxTokens: 512 });
    console.log(`[tick] reason: ${result.trim()}`);
  } else {
    console.log(`[tick] fast path sufficient: ${plan.task}`);
  }

  // 6. Revoke any lingering ERC-20 approvals left by LP/swap ops this tick.
  {
    const allowanceAbi = [{
      name: 'allowance', type: 'function', stateMutability: 'view',
      inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
      outputs: [{ name: '', type: 'uint256' }],
    }, {
      name: 'approve', type: 'function', stateMutability: 'nonpayable',
      inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
      outputs: [{ name: '', type: 'bool' }],
    }] as const;
    const pairs = [
      { token: ADDRESSES.WETH, spender: ADDRESSES.NFPM_V3,        label: 'WETH→NFPM'       },
      { token: ADDRESSES.WETH, spender: ADDRESSES.SWAP_ROUTER_V3, label: 'WETH→SwapRouter'  },
      { token: ADDRESSES.DIEM, spender: ADDRESSES.NFPM_V3,        label: 'DIEM→NFPM'       },
      { token: ADDRESSES.DIEM, spender: ADDRESSES.SWAP_ROUTER_V3, label: 'DIEM→SwapRouter' },
    ];
    for (const { token, spender, label } of pairs) {
      const val = await publicClient.readContract({ address: token, abi: allowanceAbi, functionName: 'allowance', args: [agentAddress, spender] });
      if (val > 0n) {
        const hash = await txSender({ to: token, data: encodeFunctionData({ abi: allowanceAbi, functionName: 'approve', args: [spender, 0n] }) });
        await publicClient.waitForTransactionReceipt({ hash });
        console.log(`[tick] revoked ${label}`);
      }
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────

if (process.argv[1] === new URL(import.meta.url).pathname) {
  loadTickDeps()
    .then(runTick)
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('[tick] fatal:', err);
      process.exit(1);
    });
}
