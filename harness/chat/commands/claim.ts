// /claim — claim accrued DIEM fees from the FeeLocker, behind an
// inline [Confirm]/[Cancel] approval. Preview shows the exact claimable
// amount read on-chain at command time (the dry-run); nothing signs
// until the owner confirms. The send goes through the guarded TxSender.

import { formatEther } from 'viem';
import { claimDiem, getClaimable } from '../../providers/venice.js';
import { approvalKeyboard, basescanTx } from '../approvals.js';
import { escapeHtml } from '../formatters.js';
import type { Command } from './registry.js';

function fmtDiem(wei: bigint): string {
  const eth = Number(formatEther(wei));
  return eth.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export const claimCommand: Command = {
  name: 'claim',
  description: 'Claim accrued DIEM fees (asks to confirm)',
  ownerOnly: true,
  handler: async (ctx, deps) => {
    const fromId = ctx.message?.from?.id;
    if (fromId === undefined) return;

    const claimable = await getClaimable(deps.config, deps.signer.address, deps.publicClient);
    if (claimable === 0n) {
      await ctx.reply('Nothing to claim — FeeLocker balance is 0 DIEM.');
      return;
    }

    const title = `Claim ${fmtDiem(claimable)} DIEM`;
    const entry = deps.approvals.create({
      title,
      createdBy: fromId,
      execute: async () => {
        const hash = await claimDiem(deps.config, deps.signer.address, deps.txSender);
        return `tx <code>${escapeHtml(hash)}</code> · ${basescanTx(hash)}`;
      },
    });

    await ctx.reply(
      `<b>${escapeHtml(title)}</b>\nFrom the FeeLocker to the agent wallet. Confirm to sign.`,
      { parse_mode: 'HTML', reply_markup: approvalKeyboard(entry.id) },
    );
  },
};
