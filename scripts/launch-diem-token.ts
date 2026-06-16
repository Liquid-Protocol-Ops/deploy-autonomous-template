// Launch a DIEM-denominated token on Liquid Protocol.
// TOKEN/DIEM pools earn DIEM as LP fees → agent stakes on Venice → inference credits.
//
// Usage:
//   node --env-file=.env --import tsx scripts/launch-diem-token.ts \
//     --name "Token Name" --symbol "SYM" \
//     [--creator 0x...]              # defaults to the AGENT_WALLET env var
//     [--marketcap-diem 5]           # target DIEM marketcap at launch (default: 5 — policy 2026-06-12)
//     [--image "https://..."]
//     [--metadata '{"k":"v"}']
//     [--presale-vault 0x...]        # optional: LiquidPresaleVault address (canonical, MOG-497)
//     [--extension-bps 1000]         # bps for --presale-vault (default: 1000 = 10% — policy 2026-06-12)
//     [--vvv-vault 0x...]            # FAST-FOLLOW dual-tranche, not current policy (10%, irrevocable)
//     [--diem-vault 0x...]           # FAST-FOLLOW dual-tranche, not current policy (10%, time-lock)
//     [--dry-run]
//
// Tick math: tickIfToken0IsLiquid = round(log(diemPerToken) / log(1.0001) / 60) * 60
// where diemPerToken = targetMarketcapDIEM / 100_000_000_000 (100B total supply).

import {
  encodeAbiParameters,
  encodeFunctionData,
  decodeEventLog,
  keccak256,
  encodePacked,
  type Address,
  type Hex,
} from 'viem';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { resolveCreator, DIEM_ADDRESS } from './lib/resolve-addresses';
import { appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const REPO_ROOT  = join(__dirname, '..');

// ── Protocol addresses ─────────────────────────────────────────────────────
const FACTORY        = '0x04F1a284168743759BE6554f607a10CEBdB77760' as Address;
const DIEM           = DIEM_ADDRESS;
const HOOK_DYN_FEE   = '0x80E2F7dC8C2C880BbC4BDF80A5Fb0eB8B1DB68CC' as Address;
const LP_LOCKER      = '0x77247fCD1d5e34A3703AcA898A591Dc7422435f3' as Address;
const MEV_DESC_FEES  = '0x8D6B080e48756A99F3893491D556B5d6907b6910' as Address;
const PRIVY_API_BASE = 'https://api.privy.io/v1';
const CHAIN_ID       = 8453n;
const TICK_SPACING   = 60;
const TOTAL_SUPPLY   = 100_000_000_000; // 100B tokens

// ── ABIs ───────────────────────────────────────────────────────────────────
const FACTORY_ABI = [
  {
    name: 'deployToken',
    type: 'function' as const,
    stateMutability: 'payable' as const,
    inputs: [{
      name: 'deploymentConfig', type: 'tuple' as const, components: [
        { name: 'tokenConfig', type: 'tuple' as const, components: [
          { name: 'tokenAdmin',         type: 'address'  as const },
          { name: 'name',               type: 'string'   as const },
          { name: 'symbol',             type: 'string'   as const },
          { name: 'salt',               type: 'bytes32'  as const },
          { name: 'image',              type: 'string'   as const },
          { name: 'metadata',           type: 'string'   as const },
          { name: 'context',            type: 'string'   as const },
          { name: 'originatingChainId', type: 'uint256'  as const },
        ]},
        { name: 'poolConfig', type: 'tuple' as const, components: [
          { name: 'hook',                 type: 'address' as const },
          { name: 'pairedToken',          type: 'address' as const },
          { name: 'tickIfToken0IsLiquid', type: 'int24'   as const },
          { name: 'tickSpacing',          type: 'int24'   as const },
          { name: 'poolData',             type: 'bytes'   as const },
        ]},
        { name: 'lockerConfig', type: 'tuple' as const, components: [
          { name: 'locker',           type: 'address'   as const },
          { name: 'rewardAdmins',     type: 'address[]' as const },
          { name: 'rewardRecipients', type: 'address[]' as const },
          { name: 'rewardBps',        type: 'uint16[]'  as const },
          { name: 'tickLower',        type: 'int24[]'   as const },
          { name: 'tickUpper',        type: 'int24[]'   as const },
          { name: 'positionBps',      type: 'uint16[]'  as const },
          { name: 'lockerData',       type: 'bytes'     as const },
        ]},
        { name: 'mevModuleConfig', type: 'tuple' as const, components: [
          { name: 'mevModule',     type: 'address' as const },
          { name: 'mevModuleData', type: 'bytes'   as const },
        ]},
        { name: 'extensionConfigs', type: 'tuple[]' as const, components: [
          { name: 'extension',     type: 'address' as const },
          { name: 'msgValue',      type: 'uint256' as const },
          { name: 'extensionBps',  type: 'uint16'  as const },
          { name: 'extensionData', type: 'bytes'   as const },
        ]},
      ],
    }],
    outputs: [{ name: 'tokenAddress', type: 'address' as const }],
  },
] as const;

const TOKEN_CREATED_ABI = [
  {
    name: 'TokenCreated',
    type: 'event' as const,
    anonymous: false,
    inputs: [
      { name: 'msgSender',        type: 'address'   as const, indexed: false },
      { name: 'tokenAddress',     type: 'address'   as const, indexed: true  },
      { name: 'tokenAdmin',       type: 'address'   as const, indexed: true  },
      { name: 'tokenImage',       type: 'string'    as const, indexed: false },
      { name: 'tokenName',        type: 'string'    as const, indexed: false },
      { name: 'tokenSymbol',      type: 'string'    as const, indexed: false },
      { name: 'tokenMetadata',    type: 'string'    as const, indexed: false },
      { name: 'tokenContext',     type: 'string'    as const, indexed: false },
      { name: 'startingTick',     type: 'int24'     as const, indexed: false },
      { name: 'poolHook',         type: 'address'   as const, indexed: false },
      { name: 'poolId',           type: 'bytes32'   as const, indexed: false },
      { name: 'pairedToken',      type: 'address'   as const, indexed: false },
      { name: 'locker',           type: 'address'   as const, indexed: false },
      { name: 'mevModule',        type: 'address'   as const, indexed: false },
      { name: 'extensionsSupply', type: 'uint256'   as const, indexed: false },
      { name: 'extensions',       type: 'address[]' as const, indexed: false },
    ],
  },
] as const;

// ── Tick math ──────────────────────────────────────────────────────────────
function tickFromMarketcapDIEM(marketcapDIEM: number): number {
  const diemPerToken = marketcapDIEM / TOTAL_SUPPLY;
  const tick = Math.round(Math.log(diemPerToken) / Math.log(1.0001));
  return Math.round(tick / TICK_SPACING) * TICK_SPACING;
}

// ── Privy helpers ──────────────────────────────────────────────────────────
function privyHeaders(appId: string, appSecret: string) {
  return {
    Authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
    'privy-app-id': appId,
    'Content-Type': 'application/json',
  };
}

async function privySend(
  appId: string, appSecret: string, walletId: string,
  to: Address, data: Hex,
): Promise<Hex> {
  const res = await fetch(`${PRIVY_API_BASE}/wallets/${walletId}/rpc`, {
    method: 'POST',
    headers: privyHeaders(appId, appSecret),
    body: JSON.stringify({
      method: 'eth_sendTransaction',
      caip2: 'eip155:8453',
      chain_type: 'ethereum',
      params: { transaction: { to, data } },
    }),
  });
  if (!res.ok) throw new Error(`Privy send failed: ${await res.text()}`);
  return ((await res.json()) as { data: { hash: Hex } }).data.hash;
}

// ── CLI args ───────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else { out[key] = 'true'; }
    }
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));

  const name          = args['name'] ?? '';
  const symbol        = args['symbol'] ?? '';
  const dryRun        = args['dry-run'] === 'true';
  const marketcapDIEM = parseFloat(args['marketcap-diem'] ?? '5');
  const image         = args['image'] ?? '';
  const metadata      = args['metadata'] ?? '';
  const vvvVault      = args['vvv-vault'] as Address | undefined;
  const diemVault     = args['diem-vault'] as Address | undefined;
  const presaleVault  = args['presale-vault'] as Address | undefined;
  const extensionBpsArg = parseInt(args['extension-bps'] ?? '1000');

  if (!name || !symbol) {
    console.error('Usage: --name "Token Name" --symbol "SYM" [--creator 0x...] [--marketcap-diem 5] [--vvv-vault 0x...] [--diem-vault 0x...] [--presale-vault 0x... --extension-bps 1000] [--dry-run]');
    process.exit(1);
  }

  if (Number.isNaN(marketcapDIEM) || marketcapDIEM <= 0) {
    console.error('--marketcap-diem must be a positive number');
    process.exit(1);
  }

  // creator defaults to the agent wallet (AGENT_WALLET); feeRecipient is the creator.
  const creator: Address = resolveCreator(args['creator'], process.env);
  const feeRecipient: Address = creator;

  const tick = tickFromMarketcapDIEM(marketcapDIEM);
  const salt = keccak256(encodePacked(
    ['string', 'string', 'uint256'],
    [name, symbol, BigInt(Date.now())],
  ));

  // Build extensionConfigs: add presale vaults if provided
  const extensionConfigs: Array<{
    extension: Address; msgValue: bigint; extensionBps: number; extensionData: `0x${string}`;
  }> = [];
  if (vvvVault) {
    extensionConfigs.push({ extension: vvvVault, msgValue: 0n, extensionBps: 1000, extensionData: '0x' });
  }
  if (diemVault) {
    extensionConfigs.push({ extension: diemVault, msgValue: 0n, extensionBps: 1000, extensionData: '0x' });
  }
  if (presaleVault) {
    extensionConfigs.push({ extension: presaleVault, msgValue: 0n, extensionBps: extensionBpsArg, extensionData: '0x' });
  }

  // Adjust locker position bps if extensions consume supply
  const extensionTotalBps = extensionConfigs.reduce((s, e) => s + e.extensionBps, 0);
  const lockerBps = 10000 - extensionTotalBps;

  // Canonical pool/locker/MEV config — ported from liquid-website src/lib/presale.ts
  // (the source of truth for LiquidPresaleVault launches, MOG-497).
  // AUTONO earns 5% of LP trading fees on every presale-launched token.
  const AUTONO_WALLET = '0x8767Df39eCeeaeB11554642237aC4E08660aB6A3' as Address;
  const PROTOCOL_REWARD_BPS = 500;

  // 7-position liquidity ladder (locker MAX_LP_POSITIONS = 7) — balances early
  // volatility with depth at maturity. Ranges are marketcap MULTIPLES of the
  // starting marketcap, as tick offsets (1.0001^offset ≈ multiple, spacing 60):
  //   #1     1x →     5x    4%  ultra-thin starter — fast early price discovery
  //   #2     5x →    20x    6%  thin runway (whole sub-20x region = 10%)
  //   #3    20x →   200x   30%  core body — depth begins at 20x (100 DIEM @ 5 start)
  //   #4    50x →   200x   13%  overlap — thickens depth once established
  //   #5   200x →  2000x   22%  growth band
  //   #6  2000x → 20000x   17%  scale band
  //   #7 10000x →    max    8%  moonshot tail
  const MAX_TICK = 887220;
  const LADDER = [
    { lo: 0,     hi: 16080,    bps: 400  },
    { lo: 16080, hi: 29940,    bps: 600  },
    { lo: 29940, hi: 52980,    bps: 3000 },
    { lo: 39120, hi: 52980,    bps: 1300 },
    { lo: 52980, hi: 76020,    bps: 2200 },
    { lo: 76020, hi: 99060,    bps: 1700 },
    { lo: 92100, hi: Infinity, bps: 800  },
  ];
  const ladderLower = LADDER.map(pos => Math.min(tick + pos.lo, MAX_TICK - 60));
  const ladderUpper = LADDER.map(pos => pos.hi === Infinity ? MAX_TICK : Math.min(tick + pos.hi, MAX_TICK));
  const ladderBps   = LADDER.map(pos => pos.bps); // sums to 10000

  // LiquidHookDynamicFeeV2 PoolInitializationData: baseFee 3%, maxLpFee 5% (1e6 scale).
  const feeData = encodeAbiParameters(
    [{ type: 'tuple', components: [
      { name: 'baseFee', type: 'uint24' },
      { name: 'maxLpFee', type: 'uint24' },
      { name: 'referenceTickFilterPeriod', type: 'uint256' },
      { name: 'resetPeriod', type: 'uint256' },
      { name: 'resetTickFilter', type: 'int24' },
      { name: 'feeControlNumerator', type: 'uint256' },
      { name: 'decayFilterBps', type: 'uint24' },
    ]}],
    [{ baseFee: 30_000, maxLpFee: 50_000, referenceTickFilterPeriod: 300n, resetPeriod: 600n, resetTickFilter: 100, feeControlNumerator: 200_000_000n, decayFilterBps: 5_000 }],
  );
  const poolData = encodeAbiParameters(
    [{ type: 'tuple', components: [
      { name: 'extension', type: 'address' },
      { name: 'extensionData', type: 'bytes' },
      { name: 'feeData', type: 'bytes' },
    ]}],
    [{ extension: '0x0000000000000000000000000000000000000000', extensionData: '0x', feeData }],
  );
  // LpFeeConversionInfo { FeeIn[] feePreference } — one entry PER reward recipient.
  // FeeIn.Paired (=1) for both slots: all LP fees auto-convert to DIEM (policy 2026-06-12).
  // Each slot's admin can change their own preference later via updateFeePreference.
  const lockerData = encodeAbiParameters(
    [{ type: 'tuple', components: [{ name: 'feePreference', type: 'uint8[]' }] }],
    [{ feePreference: [1, 1] }],
  );
  // LiquidMevDescendingFees FeeConfig: 80% -> 0 over 120s.
  const mevModuleData = encodeAbiParameters(
    [{ type: 'tuple', components: [
      { name: 'startingFee', type: 'uint24' },
      { name: 'endingFee', type: 'uint24' },
      { name: 'secondsToDecay', type: 'uint256' },
    ]}],
    [{ startingFee: 800_000, endingFee: 0, secondsToDecay: 120n }],
  );

  console.log('\nLaunching DIEM-denominated token:');
  console.log(`  name:           ${name}`);
  console.log(`  symbol:         ${symbol}`);
  console.log(`  creator:        ${creator}`);
  console.log(`  feeRecipient:   ${feeRecipient}`);
  console.log(`  marketcap:      ${marketcapDIEM} DIEM`);
  console.log(`  tick:           ${tick}  (tickIfToken0IsLiquid)`);
  console.log(`  pairedToken:    DIEM (${DIEM})`);
  console.log(`  vvvVault:       ${vvvVault ?? 'none'}`);
  console.log(`  diemVault:      ${diemVault ?? 'none'}`);
  console.log(`  presaleVault:   ${presaleVault ?? 'none'}${presaleVault ? ` (${extensionBpsArg} bps)` : ''}`);
  console.log(`  extensionBps:   ${extensionTotalBps} (${extensionConfigs.length} vaults)`);
  console.log(`  lockerBps:      ${lockerBps}`);
  console.log(`  LP ladder (7 positions, mcap multiples of ${marketcapDIEM} DIEM):`);
  LADDER.forEach((pos, i) => {
    const mLo = Math.exp(pos.lo * Math.log(1.0001));
    const mHi = pos.hi === Infinity ? Infinity : Math.exp(pos.hi * Math.log(1.0001));
    const hiStr = mHi === Infinity ? 'max' : `${(marketcapDIEM * mHi).toFixed(0)} DIEM`;
    const lower = Math.min(tick + pos.lo, MAX_TICK - 60);
    const upper = pos.hi === Infinity ? MAX_TICK : Math.min(tick + pos.hi, MAX_TICK);
    console.log(`    #${i + 1}  ${(marketcapDIEM * mLo).toFixed(1)} → ${hiStr}  (${pos.bps / 100}%)  ticks [${lower}, ${upper}]`);
  });

  if (dryRun) {
    console.log('\n[dry-run] Would call deployToken on', FACTORY);
    return;
  }

  const appId     = process.env['PRIVY_APP_ID']!;
  const appSecret = process.env['PRIVY_APP_SECRET']!;
  const walletId  = process.env['PRIVY_WALLET_ID']!;
  const rpcUrl    = process.env['RPC_URL']!;

  const calldata = encodeFunctionData({
    abi: FACTORY_ABI,
    functionName: 'deployToken',
    args: [{
      tokenConfig: {
        tokenAdmin:         feeRecipient,
        name,
        symbol,
        salt,
        image,
        metadata,
        context:            '',
        originatingChainId: CHAIN_ID,
      },
      poolConfig: {
        hook:                 HOOK_DYN_FEE,
        pairedToken:          DIEM,
        tickIfToken0IsLiquid: tick,
        tickSpacing:          TICK_SPACING,
        poolData,
      },
      lockerConfig: {
        locker:           LP_LOCKER,
        // Per-slot admins (parallel to rewardRecipients — locker requires equal lengths).
        // AUTONO admins its OWN slot: the creator cannot reassign AUTONO's 5% or change
        // its fee preference (updateRewardRecipient/updateFeePreference are slot-gated).
        rewardAdmins:     [feeRecipient, AUTONO_WALLET],
        rewardRecipients: [feeRecipient, AUTONO_WALLET],
        rewardBps:        [10000 - PROTOCOL_REWARD_BPS, PROTOCOL_REWARD_BPS],
        // 7-position ladder (see LADDER above). All lowers >= starting tick — the factory
        // holds only the launched token. positionBps splits the locker's own supply (=10000).
        tickLower:        ladderLower,
        tickUpper:        ladderUpper,
        positionBps:      ladderBps,
        lockerData,
      },
      mevModuleConfig: {
        mevModule:     MEV_DESC_FEES,
        mevModuleData,
      },
      extensionConfigs,
    }],
  });

  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

  console.log('\nSending deployToken tx...');
  const txHash = await privySend(appId, appSecret, walletId, FACTORY, calldata);
  console.log(`tx:     ${txHash}`);

  const receipt = await client.waitForTransactionReceipt({ hash: txHash });
  console.log(`status: ${receipt.status}`);
  if (receipt.status !== 'success') throw new Error('Transaction reverted');

  // Parse TokenCreated event
  let tokenAddress: Address | undefined;
  let startingTick: number | undefined;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: TOKEN_CREATED_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (decoded.eventName === 'TokenCreated') {
        const ev = decoded.args as Record<string, unknown>;
        tokenAddress = ev['tokenAddress'] as Address;
        startingTick = ev['startingTick'] as number;
        break;
      }
    } catch { /* not this log */ }
  }

  if (!tokenAddress) throw new Error('TokenCreated event not found in receipt');

  const today   = new Date().toISOString().slice(0, 10);
  const logDir  = join(REPO_ROOT, 'memory', 'logs');
  mkdirSync(logDir, { recursive: true });

  appendFileSync(
    join(logDir, `${today}.md`),
    `\n### launch-diem-token\n- token: ${tokenAddress}\n- symbol: ${symbol}\n- name: ${name}\n- startingTick: ${startingTick}\n- marketcap: ${marketcapDIEM} DIEM\n- feeRecipient: ${feeRecipient}\n- vvvVault: ${vvvVault ?? 'none'}\n- diemVault: ${diemVault ?? 'none'}\n- txHash: ${txHash}\n`,
  );

  const record = JSON.stringify({
    timestamp: new Date().toISOString(),
    tokenAddress,
    symbol,
    name,
    startingTick,
    marketcapDIEM,
    pairedToken: DIEM,
    feeRecipient,
    vvvVault: vvvVault ?? null,
    diemVault: diemVault ?? null,
    txHash,
  });
  appendFileSync(join(REPO_ROOT, 'memory', 'launches.jsonl'), record + '\n');

  console.log(`\nToken deployed: ${tokenAddress}`);
  console.log(`Starting tick:  ${startingTick}`);
  console.log('Saved to memory/launches.jsonl');
}

main().catch(e => { console.error(e); process.exit(1); });
