// scripts/close-and-add.ts
//
// Closes an out-of-range position, claims FeeLocker fees, then adds all
// available WETH + DIEM to an existing in-range position via increaseLiquidity.
//
// Usage:
//   npx tsx scripts/close-and-add.ts --close-id 5157087 --add-id 5153290
//   npx tsx scripts/close-and-add.ts --close-id 5157087 --add-id 5153290 --dry-run
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
const SLIPPAGE    = 3n;  // % tolerance on increaseLiquidity amounts

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

const ERC20_ABI = [{
  name: 'balanceOf', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'account', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}, {
  name: 'approve', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
}] as const;

const FEE_LOCKER_ABI = [{
  name: 'availableFees', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'feeOwner', type: 'address' }, { name: 'token', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}, {
  name: 'claim', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'feeOwner', type: 'address' }, { name: 'token', type: 'address' }],
  outputs: [],
}] as const;

const NFPM_DECREASE_ABI = [{
  name: 'decreaseLiquidity', type: 'function', stateMutability: 'payable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenId',    type: 'uint256' },
    { name: 'liquidity',  type: 'uint128' },
    { name: 'amount0Min', type: 'uint256' },
    { name: 'amount1Min', type: 'uint256' },
    { name: 'deadline',   type: 'uint256' },
  ]}],
  outputs: [{ name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }],
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

const NFPM_INCREASE_ABI = [{
  name: 'increaseLiquidity', type: 'function', stateMutability: 'payable',
  inputs: [{ name: 'params', type: 'tuple', components: [
    { name: 'tokenId',        type: 'uint256' },
    { name: 'amount0Desired', type: 'uint256' },
    { name: 'amount1Desired', type: 'uint256' },
    { name: 'amount0Min',     type: 'uint256' },
    { name: 'amount1Min',     type: 'uint256' },
    { name: 'deadline',       type: 'uint256' },
  ]}],
  outputs: [
    { name: 'liquidity', type: 'uint128' },
    { name: 'amount0',   type: 'uint256' },
    { name: 'amount1',   type: 'uint256' },
  ],
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

function tsDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 600);
}

function extractTransferAmount(
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
  const argv   = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const rpcUrl = process.env['RPC_URL'] ?? 'https://mainnet.base.org';

  const closeIdx = argv.indexOf('--close-id');
  const addIdx   = argv.indexOf('--add-id');
  if (closeIdx === -1 || !argv[closeIdx + 1] || addIdx === -1 || !argv[addIdx + 1]) {
    console.error('Usage: close-and-add.ts --close-id <tokenId> --add-id <tokenId> [--dry-run]');
    process.exit(1);
  }
  const closeId = BigInt(argv[closeIdx + 1]!);
  const addId   = BigInt(argv[addIdx + 1]!);

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
  console.log(`Close:    tokenId ${closeId}`);
  console.log(`Add to:   tokenId ${addId}`);
  console.log(`Dry-run:  ${dryRun}\n`);

  // ── Read chain state ───────────────────────────────────────────────────

  const [closePos, addPos, slot0, claimable, wethBal, diemBal, ethBal] = await Promise.all([
    client.readContract({ address: ADDRESSES.NFPM_V3, abi: NFPM_POSITIONS_ABI, functionName: 'positions', args: [closeId] }),
    client.readContract({ address: ADDRESSES.NFPM_V3, abi: NFPM_POSITIONS_ABI, functionName: 'positions', args: [addId] }),
    client.readContract({ address: ADDRESSES.ETH_DIEM_V3, abi: SLOT0_ABI, functionName: 'slot0' }),
    client.readContract({ address: ADDRESSES.FEE_LOCKER, abi: FEE_LOCKER_ABI, functionName: 'availableFees', args: [agentAddress, ADDRESSES.DIEM] }),
    client.readContract({ address: ADDRESSES.WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [agentAddress] }),
    client.readContract({ address: ADDRESSES.DIEM, abi: ERC20_ABI, functionName: 'balanceOf', args: [agentAddress] }),
    client.getBalance({ address: agentAddress }),
  ]);

  const [,,,, , closeLower, closeUpper, closeLiquidity] = closePos;
  const [,,,, , addLower, addUpper, addLiquidity] = addPos;
  const currentTick = slot0[1];

  const ETH_RESERVE = 3_000_000_000_000_000n; // 0.003 ETH gas reserve

  console.log(`Current tick:  ${currentTick}`);
  console.log(`Close pos:     [${closeLower}, ${closeUpper}]  liquidity=${closeLiquidity}`);
  console.log(`Add-to pos:    [${addLower}, ${addUpper}]  liquidity=${addLiquidity}`);
  console.log(`WETH wallet:   ${formatUnits(wethBal, 18)}`);
  console.log(`DIEM wallet:   ${formatUnits(diemBal, 18)}`);
  console.log(`FeeLocker:     ${formatUnits(claimable, 18)} DIEM claimable`);
  console.log(`ETH:           ${formatUnits(ethBal, 18)}  (reserve: 0.003)\n`);

  if (closeLiquidity === 0n) {
    console.error(`Close position ${closeId} has 0 liquidity — already closed?`);
    process.exit(1);
  }
  if (currentTick >= addLower && currentTick <= addUpper) {
    console.log(`Add-to position is IN RANGE ✓`);
  } else {
    console.error(`Add-to position ${addId} is NOT in range (tick ${currentTick} outside [${addLower}, ${addUpper}])`);
    process.exit(1);
  }
  if (currentTick <= closeUpper) {
    console.error(`Close position ${closeId} is still IN range — aborting. Use reposition.ts with --force if intended.`);
    process.exit(1);
  }
  if (ethBal < ETH_RESERVE) {
    console.error(`ETH balance ${formatUnits(ethBal, 18)} below 0.003 reserve — top up before proceeding`);
    process.exit(1);
  }

  if (dryRun) {
    console.log(`[dry-run] Step 1: decreaseLiquidity(${closeId}, ${closeLiquidity})`);
    console.log(`[dry-run]         collect → receive DIEM (position above range)`);
    if (claimable > 0n) {
      console.log(`[dry-run] Step 2: claim ${formatUnits(claimable, 18)} DIEM from FeeLocker`);
    }
    const estimatedDiem = diemBal + claimable; // rough floor (excludes OOR recovery)
    console.log(`[dry-run] Step 3: approve WETH + DIEM to NFPM`);
    console.log(`[dry-run] Step 4: increaseLiquidity(${addId})`);
    console.log(`[dry-run]         amount0Desired = ${formatUnits(wethBal, 18)} WETH (all)`);
    console.log(`[dry-run]         amount1Desired = ${formatUnits(estimatedDiem, 18)}+ DIEM (all, incl. recovered)`);
    console.log(`[dry-run]         NFPM refunds whatever the pool math doesn't consume`);
    return;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

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

  // ── Step 1: Close OOR position ─────────────────────────────────────────

  console.log(`Step 1: close position ${closeId}`);

  await send('decreaseLiquidity', ADDRESSES.NFPM_V3, encodeFunctionData({
    abi: NFPM_DECREASE_ABI, functionName: 'decreaseLiquidity',
    args: [{ tokenId: closeId, liquidity: closeLiquidity, amount0Min: 0n, amount1Min: 0n, deadline: tsDeadline() }],
  }));

  const collectReceipt = await send('collect', ADDRESSES.NFPM_V3, encodeFunctionData({
    abi: NFPM_COLLECT_ABI, functionName: 'collect',
    args: [{ tokenId: closeId, recipient: agentAddress, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
  }));

  const diemFromClose = extractTransferAmount(collectReceipt.logs, ADDRESSES.DIEM, agentAddress);
  const wethFromClose = extractTransferAmount(collectReceipt.logs, ADDRESSES.WETH, agentAddress);
  console.log(`        collected: ${formatUnits(wethFromClose, 18)} WETH  ${formatUnits(diemFromClose, 18)} DIEM`);

  // ── Step 2: Claim FeeLocker ────────────────────────────────────────────

  let claimedDiem = 0n;
  if (claimable > 0n) {
    console.log(`\nStep 2: claim ${formatUnits(claimable, 18)} DIEM from FeeLocker`);
    await send('claim', ADDRESSES.FEE_LOCKER, encodeFunctionData({
      abi: FEE_LOCKER_ABI, functionName: 'claim',
      args: [agentAddress, ADDRESSES.DIEM],
    }));
    claimedDiem = claimable;
  } else {
    console.log('\nStep 2: FeeLocker empty, skipping');
  }

  // ── Step 3: Compute post-close balances from receipts ─────────────────

  const wethForAdd = wethBal + wethFromClose;
  const diemForAdd = diemBal + diemFromClose + claimedDiem;

  console.log(`\nStep 3: balances for increaseLiquidity`);
  console.log(`        WETH: ${formatUnits(wethForAdd, 18)}`);
  console.log(`        DIEM: ${formatUnits(diemForAdd, 18)}`);

  // ── Step 4: IncreaseLiquidity on existing in-range position ───────────

  console.log(`\nStep 4: approve + increaseLiquidity on tokenId ${addId}`);

  await send('approve-weth-nfpm', ADDRESSES.WETH, encodeFunctionData({
    abi: ERC20_ABI, functionName: 'approve',
    args: [ADDRESSES.NFPM_V3, 2n ** 256n - 1n],
  }), true);

  await send('approve-diem-nfpm', ADDRESSES.DIEM, encodeFunctionData({
    abi: ERC20_ABI, functionName: 'approve',
    args: [ADDRESSES.NFPM_V3, 2n ** 256n - 1n],
  }), true);

  const addReceipt = await send('increaseLiquidity', ADDRESSES.NFPM_V3, encodeFunctionData({
    abi: NFPM_INCREASE_ABI, functionName: 'increaseLiquidity',
    args: [{
      tokenId:        addId,
      amount0Desired: wethForAdd,
      amount1Desired: diemForAdd,
      amount0Min:     wethForAdd * (100n - SLIPPAGE) / 100n,
      amount1Min:     diemForAdd * (100n - SLIPPAGE) / 100n,
      deadline:       tsDeadline(),
    }],
  }));

  const wethDeposited = extractTransferAmount(addReceipt.logs, ADDRESSES.WETH, ADDRESSES.NFPM_V3);
  const diemDeposited = extractTransferAmount(addReceipt.logs, ADDRESSES.DIEM, ADDRESSES.NFPM_V3);
  console.log(`\n✓ Done. Deposited into tokenId ${addId}:`);
  console.log(`  WETH: ${formatUnits(wethDeposited, 18)}`);
  console.log(`  DIEM: ${formatUnits(diemDeposited, 18)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
