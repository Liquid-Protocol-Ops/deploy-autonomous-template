// One-time agent provisioning: stake all VVV in the agent wallet on the
// Venice sVVV contract. Required to unlock Venice API key mint
// (sVVV-gate). Run once per agent at setup; the per-tick loop does NOT
// do this — see harness/tick.ts and feedback_launcher_fee_claim_gap.md.
//
// Run:
//   AGENT_ADDRESS=0x… npm run scripts:stake-vvv
//   (or directly: tsx --env-file=.env scripts/stake-vvv.ts)
//
// Required env:
//   PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_WALLET_ID   — agent's Privy server wallet
//   RPC_URL                                            — Base RPC
//   AGENT_ADDRESS                                      — agent's wallet address (matches Privy wallet's address)
//   DIEM_TOKEN_ADDRESS                                 — needed by loadVeniceConfig
//
// What it does:
//   1. Reads VVV balance on the agent wallet.
//   2. Calls `stakeVvv(staker, amount)` from harness/providers/venice.ts
//      → that helper does `approve(vvvStaking, amount)` on VVV, then
//        `stake(staker, amount)` on the sVVV contract.
//   3. Reads sVVV balance to confirm the stake landed.
//
// Replaces the prior hand-rolled approve+stake. Reuses the typed helper
// so the script + tick loop stay in sync if the ABIs ever change.

import { createPublicClient, formatUnits, getAddress, http, type Address } from 'viem';
import { base } from 'viem/chains';
import { loadConfig, makePublicClient, getSvvvBalance, stakeVvv } from '../harness/providers/venice.js';
import { loadPrivyConfig, loadSignerFromPrivy, makeTxSenderFromPrivy } from '../harness/safety/wallet.js';

const VVV_ERC20_ABI = [
  {
    type: 'function', name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view',
  },
  {
    type: 'function', name: 'allowance',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view',
  },
] as const;

async function main() {
  const agentEnv = process.env['AGENT_ADDRESS'];
  if (!agentEnv) throw new Error('AGENT_ADDRESS env is required');
  const agent = getAddress(agentEnv);

  // venice.ts knows the VVV + sVVV contract addresses (with sensible defaults).
  const config = loadConfig();
  const publicClient = makePublicClient(config.rpcUrl);

  // Use the agent's Privy server wallet for signing (same substrate the
  // tick loop uses — no special key handling here).
  const privyCfg = loadPrivyConfig();
  const signer = await loadSignerFromPrivy(privyCfg);
  if (signer.address.toLowerCase() !== agent.toLowerCase()) {
    throw new Error(
      `Privy wallet ${signer.address} does not match AGENT_ADDRESS ${agent}`,
    );
  }
  const txSender = makeTxSenderFromPrivy(privyCfg);

  // Probe current state.
  const [vvvBalance, allowance, svvvBefore] = await Promise.all([
    publicClient.readContract({
      address: config.vvvAddress, abi: VVV_ERC20_ABI, functionName: 'balanceOf', args: [agent],
    }),
    publicClient.readContract({
      address: config.vvvAddress, abi: VVV_ERC20_ABI, functionName: 'allowance', args: [agent, config.vvvStakingAddress],
    }),
    getSvvvBalance(config, agent, publicClient),
  ]);

  console.log(`agent:          ${agent}`);
  console.log(`VVV balance:    ${formatUnits(vvvBalance, 18)}`);
  console.log(`VVV allowance:  ${formatUnits(allowance, 18)}  (spender = sVVV @ ${config.vvvStakingAddress})`);
  console.log(`sVVV (before):  ${formatUnits(svvvBefore, 18)}`);

  if (vvvBalance === 0n) {
    console.log('\nNo VVV to stake. Acquire VVV first (e.g. swap DIEM → VVV).');
    process.exit(0);
  }

  console.log(`\nStaking ${formatUnits(vvvBalance, 18)} VVV via venice.stakeVvv helper ...`);
  const { approveHash, stakeHash } = await stakeVvv(config, agent, vvvBalance, txSender);

  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log(`  approve tx: ${approveHash}`);
  const stakeReceipt = await publicClient.waitForTransactionReceipt({ hash: stakeHash });
  console.log(`  stake tx:   ${stakeHash}  (status=${stakeReceipt.status})`);

  const svvvAfter = await getSvvvBalance(config, agent, publicClient);
  console.log(`\nsVVV (after): ${formatUnits(svvvAfter, 18)}`);
  console.log(`Delta:        +${formatUnits(svvvAfter - svvvBefore, 18)}`);
  console.log('\n✓ Agent now has sVVV — ready to mint Venice API key via harness tick.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
