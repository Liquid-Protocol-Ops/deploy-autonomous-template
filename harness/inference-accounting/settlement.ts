import type { Hex } from 'viem';

export interface SettlementRecord {
  agent: string;
  creditedUSD: bigint; // 6-dec
  txHash?: Hex;
  settledAt?: number; // unix timestamp
}

export function buildSettlementCalldata(records: SettlementRecord[]): Hex {
  if (records.length === 0) return '0x';
  // ABI encode: settleCredits(address[] agents, uint256[] amounts)
  // Implemented when on-chain settlement contract is deployed (WP-8 on-chain)
  throw new Error('settlement contract not yet deployed — implement after WP-8 on-chain contract');
}

export function isSettlementDue(lastSettledAt: number, intervalSecs = 86_400): boolean {
  return Date.now() / 1000 - lastSettledAt >= intervalSecs;
}
