// scripts/collect-lp-fees.ts
//
// Collects accrued LP trading fees from one or more NFPM positions, then
// swaps any DIEM received to WETH.
//
// Usage:
//   npx tsx scripts/collect-lp-fees.ts --token-id 5153290
//   npx tsx scripts/collect-lp-fees.ts --token-id 5153290 --dry-run
//   npx tsx scripts/collect-lp-fees.ts --token-id 5153290 --skip-swap
//
// Required env: PRIVY_APP_ID + PRIVY_APP_SECRET + PRIVY_WALLET_ID  (or AGENT_PRIVATE_KEY)
//               RPC_URL

import { createPublicClient, encodeFunctionData, http, formatUnits, type Address, type Hex } from 'viem';
import { base } from 'viem/chains';
import {
  loadPrivyConfig, makeTxSenderFromPrivy,
  loadSignerFromEnv, makeTxSenderFromEnv,
  type TxSender,
} from '../harness/safety/wallet.js';
import { ADDRESSES, ETH_DIEM_V3 } from '../platform/constants.js';

const MAX_UINT128 = (2n ** 128n) - 1n;
const SLIPPAGE    = 3n;

const NFPM_POSITIONS_ABI = [{
  name: 'positions', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'tokenId', type: 'uint256' }],
  outputs: [
    { name: 'nonce',                    type: 'uint96'  },
    { name: 'operator',                 type: 'address' },
    { name: 'token0',                   type: 'address' },
    { name: 'token1',                   type: 'address' },
    { name: 'fee',                      type: 'uint24'  },
    { name: 'tickLower',                type: 'int24'   },
    { name: 'tickUpper',                type: 'int24'   },
    { name: 'liquidity',                type: 'uint128' },
    { name: 'feeGrowthInside0LastX128', type: 'uint256' },
    { name: 'feeGrowthInside1LastX128', type: 'uint256' },
    { name: 'tokensOwed0',              type: 'uint128' },
    { name: 'tokensOwed1',              type: 'uint128' },
  ],
}] as const;

const NFPM_COLLECT_ABI = [{
  name: 'collect', type: 'function', stateMutability: 'payable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenId',    type: 'uint256' },
    { name: 'recipient',  type: 'address' },
    { name: 'amount0Max', type: 'uint128' },
    { name: 'amount1Max', type: 'uint128' },
  ]}],
  outputs: [{ name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }],
}] as const;

const ERC20_ABI = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}, {
  name: 'approve', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
}] as const;

const SLOT0_ABI = [{
  name: 'slot0', type: 'function', stateMutability: 'view',
  inputs: [],
  outputs: [
    { name: 'sqrtPriceX96', type: 'uint160' },
    { name: 'tick',         type: 'int24'   },
    { name: 'observationIndex',           type: 'uint16' },
    { name: 'observationCardinality',     type: 'uint16' },
    { name: 'observationCardinalityNext', type: 'uint16' },
    { name: 'feeProtocol', type: 'uint8'  },
    { name: 'unlocked',    type: 'bool'   },
  ],
}] as const;

const QUOTER_V2_ABI = [{
  name: 'quoteExactInputSingle', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenIn',           type: 'address' },
    { name: 'tokenOut',          type: 'address' },
    { name: 'amountIn',          type: 'uint256' },
    { name: 'fee',               type: 'uint24'  },
    { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ]}],
  outputs: [
    { name: 'amountOut',               type: 'uint256' },
    { name: 'sqrtPriceX96After',       type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32'  },
    { name: 'gasEstimate',             type: 'uint256' },
  ],
}] as const;

const SWAP_ROUTER_ABI = [{
  name: 'exactInputSingle', type: 'function', stateMutability: 'payable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenIn',           type: 'address' },
    { name: 'tokenOut',          type: 'address' },
    { name: 'fee',               type: 'uint24'  },
    { name: 'recipient',         type: 'address' },
    { name: 'amountIn',          type: 'uint256' },
    { name: 'amountOutMinimum',  type: 'uint256' },
    { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ]}],
  outputs: [{ name: 'amountOut', type: 'uint256' }],
}] as const;

function tsDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 600);
}

function parseTransferred(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  tokenAddress: string,
  to: string,
): bigint {
  const TRANSFER_SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  let total = 0n;
  for (const log of logs) {
    if (
      log.address.toLowerCase() === tokenAddress.toLowerCase() &&
      log.topics[0]?.toLowerCase() === TRANSFER_SIG &&
      log.topics[2]?.slice(-40).toLowerCase() === to.slice(2).toLowerCase()
    ) {
      total += BigInt(log.data);
    }
  }
  return total;
}

async function main() {
  const argv     = process.argv.slice(2);
  const dryRun   = argv.includes('--dry-run');
  const skipSwap = argv.includes('--skip-swap');
  const rpcUrl   = process.env['RPC_URL'] ?? 'https://mainnet.base.org';

  const tidIdx = argv.indexOf('--token-id');
  if (tidIdx === -1 || !argv[tidIdx + 1]) {
    console.error('Usage: collect-lp-fees.ts --token-id <tokenId> [--dry-run] [--skip-swap]');
    process.exit(1);
  }
  const tokenId = BigInt(argv[tidIdx + 1]!);

  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

  let txSender: TxSender;
  let agentAddress: Address;
  if (process.env['PRIVY_APP_ID']) {
    const cfg = loadPrivyConfig();
    const { loadSignerFromPrivy } = await import('../harness/safety/wallet.js');
    const signer = await loadSignerFromPrivy(cfg);
    agentAddress = signer.address;
    txSender = makeTxSenderFromPrivy(cfg);
  } else {
    const signer = loadSignerFromEnv();
    agentAddress = signer.address;
    txSender = makeTxSenderFromEnv(rpcUrl);
  }

  console.log(`\nAgent:    ${agentAddress}`);
  console.log(`TokenId:  ${tokenId}`);
  console.log(`Dry-run:  ${dryRun}\n`);

  // ── Read state ─────────────────────────────────────────────────────────

  const [pos, slot0, wethWallet, diemWallet] = await Promise.all([
    client.readContract({ address: ADDRESSES.NFPM_V3, abi: NFPM_POSITIONS_ABI, functionName: 'positions', args: [tokenId] }),
    client.readContract({ address: ADDRESSES.ETH_DIEM_V3, abi: SLOT0_ABI, functionName: 'slot0' }),
    client.readContract({ address: ADDRESSES.WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [agentAddress] }),
    client.readContract({ address: ADDRESSES.DIEM, abi: ERC20_ABI, functionName: 'balanceOf', args: [agentAddress] }),
  ]);

  const [,,,,,,,, , , tokensOwed0, tokensOwed1] = pos;
  const sqrtPriceX96 = slot0[0];
  const diemPerWeth  = Number(sqrtPriceX96 ** 2n * (10n ** 18n) / (2n ** 192n)) / 1e18;

  console.log(`Owed WETH:    ${formatUnits(tokensOwed0, 18)}`);
  console.log(`Owed DIEM:    ${formatUnits(tokensOwed1, 18)}`);
  console.log(`Wallet WETH:  ${formatUnits(wethWallet, 18)}`);
  console.log(`Wallet DIEM:  ${formatUnits(diemWallet, 18)}`);
  console.log(`DIEM/WETH:    ${diemPerWeth.toFixed(4)}\n`);

  if (tokensOwed0 === 0n && tokensOwed1 === 0n) {
    console.log('No fees owed — nothing to collect.');
    return;
  }

  if (dryRun) {
    const totalDiem = diemWallet + tokensOwed1;
    const wethOut = totalDiem / BigInt(Math.round(diemPerWeth * 1e9)) * BigInt(1e9);
    console.log(`[dry-run] collect(${tokenId}) → ${formatUnits(tokensOwed0, 18)} WETH  ${formatUnits(tokensOwed1, 18)} DIEM`);
    if (!skipSwap && totalDiem > 0n) {
      console.log(`[dry-run] swap ${formatUnits(totalDiem, 18)} DIEM → ~${formatUnits(wethOut, 18)} WETH`);
    }
    return;
  }

  // ── Step 1: Collect ────────────────────────────────────────────────────

  const send = async (label: string, to: Address, data: Hex, waitBlock = false) => {
    console.log(`[${label}] sending...`);
    const hash = await txSender({ to, data });
    console.log(`[${label}] hash: ${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status === 'reverted') throw new Error(`[${label}] tx reverted: ${hash}`);
    console.log(`[${label}] confirmed (block ${receipt.blockNumber})`);
    if (waitBlock) {
      process.stdout.write(`[${label}] waiting for next block...`);
      while ((await client.getBlockNumber()) <= receipt.blockNumber) {
        await new Promise(r => setTimeout(r, 500));
      }
      process.stdout.write(' ok\n');
    }
    return receipt;
  };

  console.log('Step 1: collect LP fees');
  const collectReceipt = await send('collect', ADDRESSES.NFPM_V3, encodeFunctionData({
    abi: NFPM_COLLECT_ABI, functionName: 'collect',
    args: [{ tokenId, recipient: agentAddress, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
  }));

  const wethCollected = parseTransferred(collectReceipt.logs, ADDRESSES.WETH, agentAddress);
  const diemCollected = parseTransferred(collectReceipt.logs, ADDRESSES.DIEM, agentAddress);
  console.log(`  received: ${formatUnits(wethCollected, 18)} WETH  ${formatUnits(diemCollected, 18)} DIEM`);

  // ── Step 2: Swap all DIEM to WETH ─────────────────────────────────────

  const totalDiem = diemWallet + diemCollected;

  if (skipSwap || totalDiem === 0n) {
    console.log('\nNo DIEM to swap — done.');
    return;
  }

  console.log(`\nStep 2: swap ${formatUnits(totalDiem, 18)} DIEM → WETH`);

  // QuoterV2 for accurate amountOutMin
  let amountOutMin = 0n;
  try {
    const quote = await client.simulateContract({
      address: ADDRESSES.QUOTER_V2,
      abi: QUOTER_V2_ABI,
      functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: ADDRESSES.DIEM, tokenOut: ADDRESSES.WETH, amountIn: totalDiem, fee: ETH_DIEM_V3.FEE, sqrtPriceLimitX96: 0n }],
    });
    const quoted = quote.result[0];
    amountOutMin = quoted * (100n - SLIPPAGE) / 100n;
    console.log(`  quote: ${formatUnits(quoted, 18)} WETH  min: ${formatUnits(amountOutMin, 18)}`);
  } catch {
    console.warn('  QuoterV2 failed, using 0 amountOutMin');
  }

  await send('approve-diem-router', ADDRESSES.DIEM, encodeFunctionData({
    abi: ERC20_ABI, functionName: 'approve',
    args: [ADDRESSES.SWAP_ROUTER_V3, 2n ** 256n - 1n],
  }), true);

  const swapReceipt = await send('exactInputSingle', ADDRESSES.SWAP_ROUTER_V3, encodeFunctionData({
    abi: SWAP_ROUTER_ABI, functionName: 'exactInputSingle',
    args: [{
      tokenIn:           ADDRESSES.DIEM,
      tokenOut:          ADDRESSES.WETH,
      fee:               ETH_DIEM_V3.FEE,
      recipient:         agentAddress,
      amountIn:          totalDiem,
      amountOutMinimum:  amountOutMin,
      sqrtPriceLimitX96: 0n,
    }],
  }));

  const wethReceived = parseTransferred(swapReceipt.logs, ADDRESSES.WETH, agentAddress);
  console.log(`\n✓ Done.`);
  console.log(`  WETH from fees:  ${formatUnits(wethCollected, 18)}`);
  console.log(`  WETH from swap:  ${formatUnits(wethReceived, 18)}`);
  console.log(`  Total WETH in:   ${formatUnits(wethWallet + wethCollected + wethReceived, 18)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
