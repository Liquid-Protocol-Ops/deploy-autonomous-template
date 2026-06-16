// scripts/revoke-approvals.ts
//
// Revokes all non-zero ERC-20 approvals from the agent wallet to known
// spenders (NFPM, SwapRouter). Safe to run after any LP/swap operation.
// Also runs automatically at the end of every tick via harness/tick.ts.
//
// Usage:
//   npx tsx scripts/revoke-approvals.ts
//   npx tsx scripts/revoke-approvals.ts --dry-run
//
// Required env: PRIVY_APP_ID + PRIVY_APP_SECRET + PRIVY_WALLET_ID  (or AGENT_PRIVATE_KEY)
//               RPC_URL

import { createPublicClient, encodeFunctionData, http, formatUnits, type Address } from 'viem';
import { base } from 'viem/chains';
import {
  loadPrivyConfig, makeTxSenderFromPrivy,
  loadSignerFromEnv, makeTxSenderFromEnv,
} from '../harness/safety/wallet.js';
import { ADDRESSES } from '../platform/constants.js';

const ERC20_ABI = [{
  name: 'allowance', type: 'function', stateMutability: 'view',
  inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
  outputs: [{ name: '', type: 'uint256' }],
}, {
  name: 'approve', type: 'function', stateMutability: 'nonpayable',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ name: '', type: 'bool' }],
}] as const;

const PAIRS: Array<{ token: Address; spender: Address; label: string }> = [
  { token: ADDRESSES.WETH, spender: ADDRESSES.NFPM_V3,        label: 'WETH → NFPM'       },
  { token: ADDRESSES.WETH, spender: ADDRESSES.SWAP_ROUTER_V3, label: 'WETH → SwapRouter'  },
  { token: ADDRESSES.DIEM, spender: ADDRESSES.NFPM_V3,        label: 'DIEM → NFPM'       },
  { token: ADDRESSES.DIEM, spender: ADDRESSES.SWAP_ROUTER_V3, label: 'DIEM → SwapRouter' },
];

async function main() {
  const argv   = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const rpcUrl = process.env['RPC_URL'] ?? 'https://mainnet.base.org';

  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });

  let agentAddress: Address;
  let txSender: Awaited<ReturnType<typeof makeTxSenderFromPrivy>> | ReturnType<typeof makeTxSenderFromEnv>;

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
  console.log(`Dry-run:  ${dryRun}\n`);

  const allowances = await Promise.all(
    PAIRS.map(p => client.readContract({
      address: p.token, abi: ERC20_ABI, functionName: 'allowance',
      args: [agentAddress, p.spender],
    }).then(v => ({ ...p, value: v })).catch(() => ({ ...p, value: 0n }))),
  );

  const nonZero = allowances.filter(a => a.value > 0n);
  if (nonZero.length === 0) {
    console.log('all approvals already zero');
    return;
  }

  for (const a of nonZero) {
    console.log(`${a.label}: ${formatUnits(a.value, 18)}`);
    if (dryRun) {
      console.log(`  [dry-run] would revoke`);
      continue;
    }
    const hash = await txSender({
      to:   a.token,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [a.spender, 0n] }),
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status === 'reverted') throw new Error(`reverted: ${hash}`);
    console.log(`  revoked (block ${receipt.blockNumber})`);
  }

  console.log('\ndone');
}

main().catch(err => { console.error(err); process.exit(1); });
