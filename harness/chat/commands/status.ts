// /status — read-only snapshot of the agent's on-chain position.
//
// Shows:
//   - Agent wallet address (with basescan link)
//   - Liquid DIEM balance (claimable from FeeLocker)
//   - Wallet DIEM balance
//   - sDIEM staked (compute budget at $1/DIEM/day)
//   - sVVV balance (API gate)
//
// All reads only; no wallet writes, no approval needed. Failures are
// reported inline rather than crashing the handler so a partial reading
// (e.g., FeeLocker temporarily unreachable) still produces a useful
// status line for the rest of the data.

import { formatEther } from 'viem';
import {
  getClaimable,
  getDiemBalance,
  getSdiemStaked,
  getSvvvBalance,
} from '../../providers/venice.js';
import { escapeHtml } from '../formatters.js';
import type { Command } from './registry.js';

function fmtDiem(wei: bigint): string {
  // Two decimal places of DIEM is enough resolution for a status line.
  const eth = Number(formatEther(wei));
  return eth.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

async function safeRead<T>(label: string, fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `${label}: ${msg}` };
  }
}

function isError<T>(value: T | { error: string }): value is { error: string } {
  return typeof value === 'object' && value !== null && 'error' in (value as object);
}

export const statusCommand: Command = {
  name: 'status',
  description: 'On-chain snapshot: wallet, claimable, sDIEM, sVVV',
  handler: async (ctx, deps) => {
    const { signer, publicClient, config } = deps;
    const address = signer.address;

    const [claimable, walletDiem, sdiem, svvv] = await Promise.all([
      safeRead('claimable', () => getClaimable(config, address, publicClient)),
      safeRead('wallet DIEM', () => getDiemBalance(config, address, publicClient)),
      safeRead('sDIEM', () => getSdiemStaked(config, address, publicClient)),
      safeRead('sVVV', () => getSvvvBalance(config, address, publicClient)),
    ]);

    const lines: string[] = [];
    lines.push(`<b>${escapeHtml(address)}</b>`);
    lines.push(`<a href="https://basescan.org/address/${address}">view on basescan</a>`);
    lines.push('');

    lines.push(
      `<b>Claimable</b>:    ${isError(claimable) ? `<i>${escapeHtml(claimable.error)}</i>` : `${fmtDiem(claimable)} DIEM`}`,
    );
    lines.push(
      `<b>Wallet DIEM</b>:  ${isError(walletDiem) ? `<i>${escapeHtml(walletDiem.error)}</i>` : `${fmtDiem(walletDiem)} DIEM`}`,
    );
    lines.push(
      `<b>sDIEM</b>:        ${isError(sdiem) ? `<i>${escapeHtml(sdiem.error)}</i>` : `${fmtDiem(sdiem)} sDIEM ` +
          `<i>(~ $${(Number(sdiem) / 1e18).toFixed(2)}/day compute)</i>`}`,
    );
    lines.push(
      `<b>sVVV</b>:         ${isError(svvv) ? `<i>${escapeHtml(svvv.error)}</i>` : `${fmtDiem(svvv)} sVVV`}`,
    );

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  },
};
