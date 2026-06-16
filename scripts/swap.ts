/**
 * scripts/swap.ts
 *
 * Swaps DIEM ↔ the agent token via Uniswap V4 Universal Router on Base.
 *
 * Usage:
 *   node --env-file=.env --import tsx scripts/swap.ts            # DIEM → AUTONO
 *   node --env-file=.env --import tsx scripts/swap.ts reverse    # AUTONO → DIEM
 *   node --env-file=.env --import tsx scripts/swap.ts --dry-run  # simulate only
 *
 * Required env vars (in scripts/.env or inherited):
 *   RPC_URL          Base mainnet RPC
 *   SWAP_PRIVATE_KEY Swapper wallet private key
 *   AUTONO_ADDRESS   The agent token to swap against DIEM
 *
 * Optional env vars:
 *   SWAP_AMOUNT      Amount of input token in human units (default: 0.001)
 *   SLIPPAGE_BPS     Slippage tolerance in bps (default: 100 = 1%)
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  maxUint256,
  encodePacked,
  encodeAbiParameters,
  parseAbiParameters,
  formatUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { DIEM_ADDRESS, requireAddressEnv, orderCurrencies } from './lib/resolve-addresses';

// ── Protocol addresses (fixed; not agent-specific) ─────────────────────
const UNIVERSAL_ROUTER = '0x6fF5693b99212Da76ad316178A184AB56D299b43' as const;
const PERMIT2          = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;
const DIEM             = DIEM_ADDRESS;
const HOOK             = '0x9811f10Cd549c754Fa9E5785989c422A762c28cc' as Address;
const POOL_FEE         = 8388608;  // 0x800000 — dynamic fee flag used by Liquid Protocol hook
const POOL_TICK_SPACING = 200;

// The agent token (AUTONO_ADDRESS) and its sorted pool key are resolved
// per-run inside main(), so the script never embeds a specific agent's token.

// ── Universal Router command ───────────────────────────────────────────
// Confirmed from decoding live on-chain V4 swap transactions on Base
const CMD_V4_SWAP = 0x10;

// ── V4 action codes (decoded from live swap: actions = [0x06, 0x0c, 0x0f]) ──
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;  // ExactInputSingleParams
const ACT_SETTLE_ALL           = 0x0c;  // (address currency, uint256 maxAmount) — pulls via Permit2
const ACT_TAKE_ALL             = 0x0f;  // (address currency, uint256 minAmount) — sends to msg.sender

// ── ABIs ──────────────────────────────────────────────────────────────
const ERC20_ABI = [
  { name: 'approve',   type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view',        inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'decimals',  type: 'function', stateMutability: 'view',        inputs: [], outputs: [{ name: '', type: 'uint8' }] },
] as const;

const PERMIT2_ABI = [
  {
    name: 'approve',
    type: 'function',
    inputs: [
      { name: 'token',      type: 'address' },
      { name: 'spender',    type: 'address' },
      { name: 'amount',     type: 'uint160' },
      { name: 'expiration', type: 'uint48'  },
    ],
    outputs: [],
  },
  {
    name: 'allowance',
    type: 'function',
    inputs: [
      { name: 'user',    type: 'address' },
      { name: 'token',   type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount',     type: 'uint160' },
      { name: 'expiration', type: 'uint48'  },
      { name: 'nonce',      type: 'uint48'  },
    ],
  },
] as const;

const ROUTER_ABI = [{
  name: 'execute',
  type: 'function',
  inputs: [
    { name: 'commands', type: 'bytes'   },
    { name: 'inputs',   type: 'bytes[]' },
    { name: 'deadline', type: 'uint256' },
  ],
  outputs: [],
}] as const;

// ── Encoding helpers ───────────────────────────────────────────────────

function encodeSwapParams(
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address },
  tokenIn: Address,
  tokenOut: Address,
  zeroForOne: boolean,
  amountIn: bigint,
  amountOutMin: bigint,
): Hex {
  // Actions: [SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]
  const actions = encodePacked(
    ['uint8', 'uint8', 'uint8'],
    [ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL],
  );

  // ExactInputSingleParams — struct with dynamic hookData, hence the outer offset in encoding
  const swapParam = encodeAbiParameters(
    parseAbiParameters(
      '((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)',
    ),
    [{
      poolKey,
      zeroForOne,
      amountIn,
      amountOutMinimum: amountOutMin,
      hookData: '0x',
    }],
  );

  // SETTLE_ALL: (address inputCurrency, uint256 maxAmount)
  const settleParam = encodeAbiParameters(
    parseAbiParameters('address, uint256'),
    [tokenIn, amountIn],
  );

  // TAKE_ALL: (address outputCurrency, uint256 minAmount)
  const takeParam = encodeAbiParameters(
    parseAbiParameters('address, uint256'),
    [tokenOut, amountOutMin],
  );

  return encodeAbiParameters(
    parseAbiParameters('bytes, bytes[]'),
    [actions, [swapParam, settleParam, takeParam]],
  );
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const reverse = args.includes('reverse');
  const dryRun  = args.includes('--dry-run');

  // Resolve the agent token (required) and build the V4 pool key. V4 sorts
  // currencies by address, so currency0/currency1 depend on the actual token.
  const AUTONO = requireAddressEnv(process.env, 'AUTONO_ADDRESS', 'the agent token to swap against DIEM');
  const { currency0, currency1 } = orderCurrencies(AUTONO, DIEM);
  const poolKey = { currency0, currency1, fee: POOL_FEE, tickSpacing: POOL_TICK_SPACING, hooks: HOOK };

  const rpcUrl     = process.env['RPC_URL'] ?? '';
  const privateKey = process.env['SWAP_PRIVATE_KEY'] as Hex | undefined;
  if (!rpcUrl)    throw new Error('RPC_URL is required');
  if (!privateKey) throw new Error('SWAP_PRIVATE_KEY is required');

  const account      = privateKeyToAccount(privateKey);
  const transport    = http(rpcUrl);
  const publicClient = createPublicClient({ chain: base, transport });
  const walletClient = createWalletClient({ chain: base, transport, account });

  // Direction
  const tokenIn  = reverse ? AUTONO : DIEM;
  const tokenOut = reverse ? DIEM   : AUTONO;
  // zeroForOne is true when the input token is currency0 (the lower address).
  const zeroForOne = tokenIn.toLowerCase() === currency0.toLowerCase();

  const inDecimals  = await publicClient.readContract({ address: tokenIn,  abi: ERC20_ABI, functionName: 'decimals' });
  const outDecimals = await publicClient.readContract({ address: tokenOut, abi: ERC20_ABI, functionName: 'decimals' });

  const humanAmount = process.env['SWAP_AMOUNT'] ?? '0.001';
  const slippageBps = BigInt(process.env['SLIPPAGE_BPS'] ?? '100');
  const amountIn    = parseUnits(humanAmount, inDecimals);
  const amountOutMin = amountIn * (10000n - slippageBps) / 10000n;

  const inBalance = await publicClient.readContract({ address: tokenIn, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });

  console.log(`\nSwap: ${formatUnits(amountIn, inDecimals)} ${reverse ? 'AUTONO' : 'DIEM'} → ${reverse ? 'DIEM' : 'AUTONO'}`);
  console.log(`Wallet : ${account.address}`);
  console.log(`Balance: ${formatUnits(inBalance, inDecimals)} ${reverse ? 'AUTONO' : 'DIEM'}`);
  if (inBalance < amountIn) throw new Error(`Insufficient balance: have ${formatUnits(inBalance, inDecimals)}, need ${humanAmount}`);

  // ── Step 1: ERC20 approve tokenIn → Permit2 ─────────────────────────
  console.log('\n[1/3] Approving input token to Permit2...');
  if (!dryRun) {
    const approveTx = await walletClient.writeContract({
      address: tokenIn, abi: ERC20_ABI, functionName: 'approve',
      args: [PERMIT2, maxUint256], account, chain: base,
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });
    console.log('      tx:', approveTx);
  } else {
    console.log('      [dry-run] skipped');
  }

  // ── Step 2: Permit2 approve Universal Router ─────────────────────────
  console.log('[2/3] Permit2 approve Universal Router...');
  if (!dryRun) {
    const expiration = Math.floor(Date.now() / 1000) + 86400 * 30; // 30 days
    const permit2Tx = await walletClient.writeContract({
      address: PERMIT2, abi: PERMIT2_ABI, functionName: 'approve',
      args: [tokenIn, UNIVERSAL_ROUTER, BigInt('0xffffffffffffffffffff'), expiration],
      account, chain: base,
    });
    await publicClient.waitForTransactionReceipt({ hash: permit2Tx });
    console.log('      tx:', permit2Tx);
  } else {
    console.log('      [dry-run] skipped');
  }

  // ── Step 3: Swap ─────────────────────────────────────────────────────
  const deadline  = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const v4Input   = encodeSwapParams(poolKey, tokenIn, tokenOut, zeroForOne, amountIn, amountOutMin);
  const commands  = encodePacked(['uint8'], [CMD_V4_SWAP]);

  console.log('[3/3] Simulating swap...');
  try {
    await publicClient.simulateContract({
      address: UNIVERSAL_ROUTER, abi: ROUTER_ABI, functionName: 'execute',
      args: [commands, [v4Input], deadline],
      account: account.address,
    });
    console.log('      simulation OK');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('      simulation FAILED:', msg);
    if (!dryRun) throw err;
    return;
  }

  if (dryRun) {
    console.log('\n[dry-run] No transactions sent.');
    return;
  }

  console.log('      Sending swap transaction...');
  const swapTx = await walletClient.writeContract({
    address: UNIVERSAL_ROUTER, abi: ROUTER_ABI, functionName: 'execute',
    args: [commands, [v4Input], deadline],
    account, chain: base,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: swapTx });

  const outBalance = await publicClient.readContract({ address: tokenOut, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] });

  console.log('\n✓ Swap complete');
  console.log('  tx     :', swapTx);
  console.log('  status :', receipt.status);
  console.log('  balance:', formatUnits(outBalance, outDecimals), reverse ? 'DIEM' : 'AUTONO');
}

main().catch(err => { console.error(err); process.exit(1); });
