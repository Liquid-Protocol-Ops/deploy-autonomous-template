// /stake <amount|all> — stake wallet DIEM for sDIEM (compute budget at
// ~$1/DIEM/day), behind an inline [Confirm]/[Cancel] approval. The
// preview shows the parsed amount against the live wallet balance;
// nothing signs until the owner confirms. DIEM is its own staking
// contract (no approve step), and the send goes through the guarded
// TxSender.

import { formatEther, parseEther } from 'viem';
import { getDiemBalance, stakeDiem } from '../../providers/venice.js';
import { approvalKeyboard, basescanTx } from '../approvals.js';
import { escapeHtml } from '../formatters.js';
import type { Command } from './registry.js';

function fmtDiem(wei: bigint): string {
  const eth = Number(formatEther(wei));
  return eth.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** Parse "/stake 12.5" or "/stake all" against the wallet balance. */
export function parseStakeAmount(arg: string | undefined, balance: bigint): bigint | { error: string } {
  if (!arg) return { error: 'Usage: /stake <amount|all>' };
  if (arg.toLowerCase() === 'all') {
    return balance > 0n ? balance : { error: 'Wallet DIEM balance is 0 — nothing to stake.' };
  }
  let wei: bigint;
  try {
    wei = parseEther(arg);
  } catch {
    return { error: `Can't parse amount: ${arg}` };
  }
  if (wei <= 0n) return { error: 'Amount must be positive.' };
  if (wei > balance) {
    return { error: `Amount exceeds wallet balance (${fmtDiem(balance)} DIEM).` };
  }
  return wei;
}

export const stakeCommand: Command = {
  name: 'stake',
  description: 'Stake wallet DIEM for compute budget (asks to confirm)',
  ownerOnly: true,
  handler: async (ctx, deps, args) => {
    const fromId = ctx.message?.from?.id;
    if (fromId === undefined) return;

    const balance = await getDiemBalance(deps.config, deps.signer.address, deps.publicClient);
    const parsed = parseStakeAmount(args[0], balance);
    if (typeof parsed === 'object') {
      await ctx.reply(parsed.error);
      return;
    }

    const perDay = Number(formatEther(parsed));
    const title = `Stake ${fmtDiem(parsed)} DIEM`;
    const entry = deps.approvals.create({
      title,
      createdBy: fromId,
      execute: async () => {
        const hash = await stakeDiem(deps.config, parsed, deps.txSender);
        return `tx <code>${escapeHtml(hash)}</code> · ${basescanTx(hash)}`;
      },
    });

    await ctx.reply(
      [
        `<b>${escapeHtml(title)}</b>`,
        `Wallet balance: ${fmtDiem(balance)} DIEM. Adds ~$${perDay.toFixed(2)}/day of compute.`,
        'Staked DIEM is the inference budget — unstaking has its own cooldown. Confirm to sign.',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: approvalKeyboard(entry.id) },
    );
  },
};
