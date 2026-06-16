import { createPublicClient, formatUnits, http, type Address } from 'viem';
import { base } from 'viem/chains';

// ── Minimal ABIs ─────────────────────────────────────────────────────

const FEE_LOCKER_ABI = [
  {
    type: 'function', name: 'availableFees',
    inputs: [{ name: 'feeOwner', type: 'address' }, { name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view',
  },
] as const;

const SDIEM_ABI = [
  {
    type: 'function', name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view',
  },
] as const;

// ── Types ─────────────────────────────────────────────────────────────

export interface AgentChainInfo {
  claimableDiemWei: bigint;
  stakedDiemWei: bigint;
  claimableDiem: string;
  stakedDiem: string;
  blockNumber: bigint;
}

// ── Client factory (injectable for tests) ────────────────────────────

export type PublicClient = ReturnType<typeof makePublicClient>;

export function makePublicClient(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

// ── Chain reads ───────────────────────────────────────────────────────

export async function fetchAgentChainInfo(
  wallet: Address,
  diemAddress: Address,
  feeLockerAddress: Address,
  client: PublicClient,
): Promise<AgentChainInfo> {
  const [claimableDiemWei, stakedDiemWei, blockNumber] = await Promise.all([
    client.readContract({
      address: feeLockerAddress,
      abi: FEE_LOCKER_ABI,
      functionName: 'availableFees',
      args: [wallet, diemAddress],
    }),
    client.readContract({
      address: diemAddress,
      abi: SDIEM_ABI,
      functionName: 'balanceOf',
      args: [wallet],
    }),
    client.getBlockNumber(),
  ]);

  return {
    claimableDiemWei,
    stakedDiemWei,
    claimableDiem: formatUnits(claimableDiemWei, 18),
    stakedDiem: formatUnits(stakedDiemWei, 18),
    blockNumber,
  };
}
