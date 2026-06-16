/**
 * settle.ts — wstDIEM vault inference revenue settlement loop.
 *
 * Watches the keeper wallet's USDC balance on Base. When USDC accumulates
 * above MIN_SETTLE_USDC (from AntSeed x402 inference payments), calls
 * FeeRouter.settleAndHarvest(channelId, amount) which:
 *   USDC → (swap) WETH → DIEM → vault.creditDIEM() → wstDIEM rate rises
 *
 * Required env:
 *   KEEPER_PRIVATE_KEY   — keeper EOA private key (0x...)
 *   BASE_RPC_URL         — Base mainnet RPC
 *
 * Optional env:
 *   CHANNEL_ID           — AntSeed FeeRouter channel ID (default: 0)
 *   MIN_SETTLE_USDC      — minimum USDC to trigger settlement (default: 1.0)
 *   POLL_INTERVAL_MS     — polling interval in ms (default: 120000 = 2 min)
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  type Address,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

// ── Constants ────────────────────────────────────────────────────────────────

const USDC        = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const FEE_ROUTER  = '0x21fe048B10dC9bED2Ee0Ae76724C627CA7F35F61' as Address;

const CHANNEL_ID       = BigInt(process.env['CHANNEL_ID']      ?? '0');
const MIN_SETTLE_USDC  = Number(process.env['MIN_SETTLE_USDC'] ?? '1.0');
const POLL_INTERVAL_MS = Number(process.env['POLL_INTERVAL_MS'] ?? '120000');
const MIN_SETTLE_RAW   = BigInt(Math.floor(MIN_SETTLE_USDC * 1_000_000));

const USDC_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const FEE_ROUTER_ABI = parseAbi([
  'function settleAndHarvest(uint256 channelId, uint256 amount)',
]);

// ── Setup ────────────────────────────────────────────────────────────────────

const pk = process.env['KEEPER_PRIVATE_KEY'];
if (!pk) throw new Error('KEEPER_PRIVATE_KEY not set');

const rpcUrl = process.env['BASE_RPC_URL'];
if (!rpcUrl) throw new Error('BASE_RPC_URL not set');

const account  = privateKeyToAccount(pk as `0x${string}`);
const keeper   = account.address;

const publicClient = createPublicClient({
  chain: base,
  transport: http(rpcUrl),
});

const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http(rpcUrl),
});

// ── Settlement loop ──────────────────────────────────────────────────────────

// Approve FeeRouter for max USDC once at startup so settle() never hits allowance issues.
async function ensureApproval(): Promise<void> {
  const MAX = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
  const allowance = await publicClient.readContract({
    address: USDC, abi: USDC_ABI, functionName: 'allowance', args: [keeper, FEE_ROUTER],
  });
  if (allowance >= MAX / 2n) {
    console.log('  Max approval already set.');
    return;
  }
  console.log('  Setting max USDC approval for FeeRouter...');
  const tx = await walletClient.writeContract({
    address: USDC, abi: USDC_ABI, functionName: 'approve', args: [FEE_ROUTER, MAX],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== 'success') throw new Error(`Approve reverted: ${tx}`);
  console.log(`  Approved (max): ${tx}`);
}

async function settle(): Promise<void> {
  const balance = await publicClient.readContract({
    address: USDC, abi: USDC_ABI, functionName: 'balanceOf', args: [keeper],
  });

  const balanceFormatted = formatUnits(balance, 6);
  console.log(`[${new Date().toISOString()}] USDC balance: $${balanceFormatted}`);

  if (balance < MIN_SETTLE_RAW) {
    console.log(`  Below threshold ($${MIN_SETTLE_USDC}), skipping.`);
    return;
  }

  // settleAndHarvest: pulls USDC from keeper, swaps to DIEM, credits vault
  console.log(`  Settling $${balanceFormatted} via channel ${CHANNEL_ID}...`);
  const settleTx = await walletClient.writeContract({
    address: FEE_ROUTER, abi: FEE_ROUTER_ABI, functionName: 'settleAndHarvest',
    args:    [CHANNEL_ID, balance],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: settleTx });
  if (receipt.status !== 'success') throw new Error(`settleAndHarvest reverted: ${settleTx}`);
  console.log(`  Settled: ${settleTx}`);
  console.log(`  wstDIEM rate increased — $${balanceFormatted} USDC credited to vault.`);
}

async function loop(): Promise<void> {
  console.log(`wstDIEM keeper settle loop started`);
  console.log(`  keeper:   ${keeper}`);
  console.log(`  channel:  ${CHANNEL_ID} (AntSeed)`);
  console.log(`  min:      $${MIN_SETTLE_USDC} USDC`);
  console.log(`  interval: ${POLL_INTERVAL_MS / 1000}s`);

  // Set max approval once at startup
  try {
    await ensureApproval();
  } catch (err) {
    console.error('Approval failed — will retry next cycle:', err);
  }

  // Poll and settle on interval
  while (true) {
    try {
      await settle();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] settle error:`, err);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

loop().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
