/**
 * scripts/stake-diem.ts
 *
 * Claims FeeLocker DIEM, withdraws enough liquidity from an in-range V3 LP
 * position to reach a target DIEM balance, then stakes on the DIEM contract.
 *
 * DIEM is its own staking contract — stake(uint256) directly, no approve needed.
 *
 * Usage:
 *   npx tsx scripts/stake-diem.ts --token-id 5153290 --target 5
 *   npx tsx scripts/stake-diem.ts --token-id 5153290 --target 5 --live
 *
 * Required env: PRIVY_APP_ID + PRIVY_APP_SECRET + PRIVY_WALLET_ID  (or AGENT_PRIVATE_KEY)
 *               RPC_URL  AGENT_WALLET
 */

import {
  createPublicClient, encodeFunctionData, formatUnits, http, parseUnits,
  type Address, type Hex,
} from 'viem';
import { base } from 'viem/chains';
import {
  loadPrivyConfig, makeTxSenderFromPrivy,
  loadSignerFromEnv, makeTxSenderFromEnv,
  type TxSender,
} from '../harness/safety/wallet.js';
import { ADDRESSES } from '../platform/constants.js';

// ── Args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const live = args.includes('--live');
const dry  = !live;

function argVal(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}

const tokenIdArg = argVal('--token-id');   // optional — omit to skip LP withdrawal
const targetArg  = argVal('--target');
if (!targetArg)  { console.error('--target required (DIEM amount, e.g. 5)'); process.exit(1); }

const TOKEN_ID    = tokenIdArg ? BigInt(tokenIdArg) : null;
const TARGET_DIEM = parseUnits(targetArg, 18);
const SLIPPAGE    = 3n;     // % tolerance on decreaseLiquidity amounts
const LIQ_BUFFER  = 12n;    // withdraw 12% extra liquidity to absorb slippage

// ── ABIs ──────────────────────────────────────────────────────────────
const FEE_LOCKER_ABI = [
  { type: 'function', name: 'availableFees',
    inputs: [{ name: 'feeOwner', type: 'address' }, { name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'claim',
    inputs: [{ name: 'feeOwner', type: 'address' }, { name: 'token', type: 'address' }],
    outputs: [], stateMutability: 'nonpayable' },
] as const;

const DIEM_ABI = [
  { type: 'function', name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'stake',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'stakedInfos',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [
      { name: 'amountStaked', type: 'uint256' },
      { name: 'coolDownEnd', type: 'uint256' },
      { name: 'coolDownAmount', type: 'uint256' },
    ], stateMutability: 'view' },
] as const;

const NFPM_ABI = [
  { type: 'function', name: 'positions', stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' }, { name: 'operator', type: 'address' },
      { name: 'token0', type: 'address' }, { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' }, { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' }, { name: 'tokensOwed1', type: 'uint128' },
    ] },
  { type: 'function', name: 'decreaseLiquidity', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'tokenId', type: 'uint256' }, { name: 'liquidity', type: 'uint128' },
      { name: 'amount0Min', type: 'uint256' }, { name: 'amount1Min', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ]}],
    outputs: [{ name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }] },
  { type: 'function', name: 'collect', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'tokenId', type: 'uint256' }, { name: 'recipient', type: 'address' },
      { name: 'amount0Max', type: 'uint128' }, { name: 'amount1Max', type: 'uint128' },
    ]}],
    outputs: [{ name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }] },
] as const;

const POOL_ABI = [
  { type: 'function', name: 'slot0', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' }, { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' }, { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ] },
] as const;

const MAX_UINT128 = (2n ** 128n) - 1n;
const Q96 = 2n ** 96n;

// ── V3 amount estimation ───────────────────────────────────────────────
// Estimate token1 (DIEM) held in a position given sqrtPriceX96 + ticks + L.
// Returns wei amount.
function estimateDiemInPosition(
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): bigint {
  const sqrtRatio = (tick: number) => {
    // Approximate sqrtPrice via power: sqrt(1.0001^tick)
    const abs = Math.abs(tick);
    let val = 1.0;
    let base = 1.0001;
    let t = abs;
    // fast exponentiation
    while (t > 0) { if (t & 1) val *= base; base *= base; t >>= 1; }
    const raw = tick >= 0 ? val : 1 / val;
    return BigInt(Math.floor(Math.sqrt(raw) * Number(Q96)));
  };

  const sqrtLower   = sqrtRatio(tickLower);
  const sqrtCurrent = sqrtPriceX96;
  const sqrtUpper   = sqrtRatio(tickUpper);

  const clampedCurrent = sqrtCurrent < sqrtLower ? sqrtLower
    : sqrtCurrent > sqrtUpper ? sqrtUpper
    : sqrtCurrent;

  // amount1 (token1 = DIEM) = L * (sqrtCurrent - sqrtLower) / Q96
  const diff = clampedCurrent - sqrtLower;
  return diff > 0n ? (liquidity * diff) / Q96 : 0n;
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  const rpcUrl     = process.env['RPC_URL'];
  const agentEnv   = process.env['AGENT_WALLET'];
  if (!rpcUrl)    throw new Error('RPC_URL required');
  if (!agentEnv)  throw new Error('AGENT_WALLET required');
  const agentWallet = agentEnv as Address;

  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

  // ── Load wallet (deferred to live only) ──
  let send: TxSender | null = null;
  if (!dry) {
    const privyEnv = process.env['PRIVY_APP_ID'];
    if (privyEnv) {
      const cfg = loadPrivyConfig();
      const { loadSignerFromPrivy } = await import('../harness/safety/wallet.js');
      await loadSignerFromPrivy(cfg);
      send = makeTxSenderFromPrivy(cfg);
    } else {
      loadSignerFromEnv();
      send = makeTxSenderFromEnv(rpcUrl);
    }
  }

  // ── Read on-chain state ──
  const [claimable, diemBal] = await Promise.all([
    publicClient.readContract({
      address: ADDRESSES.FEE_LOCKER, abi: FEE_LOCKER_ABI,
      functionName: 'availableFees', args: [agentWallet, ADDRESSES.DIEM],
    }),
    publicClient.readContract({
      address: ADDRESSES.DIEM, abi: DIEM_ABI,
      functionName: 'balanceOf', args: [agentWallet],
    }),
  ]);

  let tickLower = 0, tickUpper = 0, liquidity = 0n, sqrtPriceX96 = 0n, currentTick = 0;
  if (TOKEN_ID !== null) {
    const [position, slot0] = await Promise.all([
      publicClient.readContract({
        address: ADDRESSES.NFPM_V3, abi: NFPM_ABI,
        functionName: 'positions', args: [TOKEN_ID],
      }),
      publicClient.readContract({
        address: ADDRESSES.ETH_DIEM_V3, abi: POOL_ABI,
        functionName: 'slot0',
      }),
    ]);
    [,,,,, tickLower, tickUpper, liquidity] = position;
    sqrtPriceX96 = slot0[0];
    currentTick  = slot0[1];
  }

  const diemInLP = TOKEN_ID !== null
    ? estimateDiemInPosition(sqrtPriceX96, tickLower, tickUpper, liquidity)
    : 0n;
  const afterClaim = diemBal + claimable;
  const deficit = TARGET_DIEM > afterClaim ? TARGET_DIEM - afterClaim : 0n;

  // Determine liquidity fraction to remove (with buffer) to cover the deficit.
  let liqToRemove = 0n;
  if (TOKEN_ID !== null && deficit > 0n && diemInLP > 0n) {
    const frac = (deficit * (100n + LIQ_BUFFER) * liquidity) / (diemInLP * 100n);
    liqToRemove = frac > liquidity ? liquidity : frac;
  }

  const estimatedFromLP = diemInLP > 0n && liquidity > 0n
    ? (diemInLP * liqToRemove) / liquidity
    : 0n;

  const totalExpected = afterClaim + estimatedFromLP;
  const stakeAmount   = totalExpected > TARGET_DIEM ? TARGET_DIEM : totalExpected;

  console.log(`\n== stake-diem ${dry ? '[DRY-RUN]' : '[LIVE]'} ==`);
  console.log(`Agent         : ${agentWallet}`);
  console.log(`Target        : ${formatUnits(TARGET_DIEM, 18)} DIEM`);
  console.log(`\n-- Current state --`);
  console.log(`Wallet DIEM   : ${formatUnits(diemBal, 18)}`);
  console.log(`FeeLocker     : ${formatUnits(claimable, 18)} DIEM claimable`);
  if (TOKEN_ID !== null) {
    console.log(`LP #${TOKEN_ID}   : tick=${currentTick} range=[${tickLower},${tickUpper}] liquidity=${liquidity}`);
    console.log(`  Est. DIEM in position : ${formatUnits(diemInLP, 18)}`);
  }
  console.log(`\n-- Plan --`);
  if (claimable > 0n)
    console.log(`Step 1: claim ${formatUnits(claimable, 18)} DIEM from FeeLocker`);
  if (liqToRemove > 0n) {
    const pct = Number((liqToRemove * 10000n) / liquidity) / 100;
    console.log(`Step 2: decreaseLiquidity(${TOKEN_ID}, ${liqToRemove}) ≈ ${pct.toFixed(1)}% of position`);
    console.log(`        est. ${formatUnits(estimatedFromLP, 18)} DIEM from LP`);
  } else {
    console.log(`Step 2: no LP withdrawal needed`);
  }
  console.log(`Step 3: stake ${formatUnits(stakeAmount, 18)} DIEM`);

  if (totalExpected < TARGET_DIEM) {
    console.warn(`\nWARN: expected total DIEM (${formatUnits(totalExpected, 18)}) < target (${formatUnits(TARGET_DIEM, 18)})`);
    console.warn(`      Will stake all available. Check LP position size.`);
  }

  if (dry) {
    console.log('\nDry-run complete. Pass --live to execute.');
    return;
  }

  if (!send) throw new Error('send is null — logic error');

  // ── ETH gas guard ──
  const ethBal = await publicClient.getBalance({ address: agentWallet });
  const GAS_RESERVE = parseUnits('0.003', 18);
  if (ethBal < GAS_RESERVE) {
    throw new Error(`ETH balance ${formatUnits(ethBal, 18)} below 0.003 reserve — aborting`);
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600); // 10 min

  // ── Step 1: Claim FeeLocker ──
  if (claimable > 0n) {
    console.log('\n[1/3] Claiming FeeLocker...');
    const claimData = encodeFunctionData({
      abi: FEE_LOCKER_ABI, functionName: 'claim',
      args: [agentWallet, ADDRESSES.DIEM],
    });
    const claimHash = await send({ to: ADDRESSES.FEE_LOCKER, data: claimData as Hex });
    console.log(`      tx: ${claimHash}`);
    await publicClient.waitForTransactionReceipt({ hash: claimHash as Hex });
  } else {
    console.log('\n[1/3] FeeLocker empty — skipping claim');
  }

  // ── Step 2: Decrease LP liquidity if needed ──
  if (liqToRemove > 0n && TOKEN_ID !== null) {
    console.log('\n[2/3] Decreasing LP liquidity...');
    const decData = encodeFunctionData({
      abi: NFPM_ABI, functionName: 'decreaseLiquidity',
      args: [{
        tokenId: TOKEN_ID!,
        liquidity: liqToRemove as unknown as bigint & { readonly __type: 'uint128' },
        amount0Min: 0n,
        amount1Min: (estimatedFromLP * (100n - SLIPPAGE)) / 100n,
        deadline,
      }],
    });
    const decHash = await send({ to: ADDRESSES.NFPM_V3, data: decData as Hex });
    console.log(`      decreaseLiquidity tx: ${decHash}`);
    await publicClient.waitForTransactionReceipt({ hash: decHash as Hex });

    // Collect tokens to wallet
    const collectData = encodeFunctionData({
      abi: NFPM_ABI, functionName: 'collect',
      args: [{
        tokenId: TOKEN_ID!,
        recipient: agentWallet,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      }],
    });
    const collectHash = await send({ to: ADDRESSES.NFPM_V3, data: collectData as Hex });
    console.log(`      collect tx: ${collectHash}`);
    await publicClient.waitForTransactionReceipt({ hash: collectHash as Hex });
  } else {
    console.log('\n[2/3] No LP withdrawal needed');
  }

  // ── Step 3: Stake DIEM ──
  const diemBalAfter = await publicClient.readContract({
    address: ADDRESSES.DIEM, abi: DIEM_ABI,
    functionName: 'balanceOf', args: [agentWallet],
  });
  const actualStake = diemBalAfter > TARGET_DIEM ? TARGET_DIEM : diemBalAfter;

  if (actualStake === 0n) {
    throw new Error(`No DIEM in wallet after claim + LP withdrawal — cannot stake`);
  }

  console.log(`\n[3/3] Staking ${formatUnits(actualStake, 18)} DIEM...`);
  const stakeData = encodeFunctionData({
    abi: DIEM_ABI, functionName: 'stake', args: [actualStake],
  });
  const stakeHash = await send({ to: ADDRESSES.DIEM, data: stakeData as Hex });
  console.log(`      stake tx: ${stakeHash}`);
  await publicClient.waitForTransactionReceipt({ hash: stakeHash as Hex });

  // ── Verify ──
  const [stakedInfo, diemBalFinal] = await Promise.all([
    publicClient.readContract({
      address: ADDRESSES.DIEM, abi: DIEM_ABI,
      functionName: 'stakedInfos', args: [agentWallet],
    }),
    publicClient.readContract({
      address: ADDRESSES.DIEM, abi: DIEM_ABI,
      functionName: 'balanceOf', args: [agentWallet],
    }),
  ]);

  console.log(`\n== Done ==`);
  console.log(`sDIEM staked  : ${formatUnits(stakedInfo[0], 18)}`);
  console.log(`DIEM remaining: ${formatUnits(diemBalFinal, 18)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
