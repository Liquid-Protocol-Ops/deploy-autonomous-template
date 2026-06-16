// /lp <amount|all> [short|medium] — reinvest wallet DIEM into a
// single-sided ETH/DIEM v3 LP position, behind an inline
// [Confirm]/[Cancel] approval. reinvestToLP sends two txs through the
// guarded TxSender (ERC-20 approve to the NFPM, then mint) and persists
// the position to memory/lp-positions.jsonl for the tick loop to manage.

import { formatEther } from 'viem';
import { reinvestToLP, type TickRange } from '../../providers/liquidity.js';
import { getDiemBalance } from '../../providers/venice.js';
import { approvalKeyboard, basescanTx } from '../approvals.js';
import { escapeHtml } from '../formatters.js';
import { parseStakeAmount } from './stake.js';
import type { Command } from './registry.js';

function fmtDiem(wei: bigint): string {
  const eth = Number(formatEther(wei));
  return eth.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

export function parseRange(arg: string | undefined): TickRange | { error: string } {
  if (!arg) return 'short';
  const lower = arg.toLowerCase();
  if (lower === 'short' || lower === 'medium') return lower;
  return { error: `Range must be "short" or "medium", got: ${arg}` };
}

export const lpCommand: Command = {
  name: 'lp',
  description: 'LP wallet DIEM into ETH/DIEM v3 (asks to confirm)',
  ownerOnly: true,
  handler: async (ctx, deps, args) => {
    const fromId = ctx.message?.from?.id;
    if (fromId === undefined) return;

    const balance = await getDiemBalance(deps.config, deps.signer.address, deps.publicClient);
    const amount = parseStakeAmount(args[0], balance);
    if (typeof amount === 'object') {
      // parseStakeAmount's usage line is stake-specific — rewrite it for /lp.
      const error = amount.error.startsWith('Usage:')
        ? 'Usage: /lp <amount|all> [short|medium]'
        : amount.error;
      await ctx.reply(error);
      return;
    }

    const range = parseRange(args[1]);
    if (typeof range === 'object') {
      await ctx.reply(range.error);
      return;
    }

    const title = `LP ${fmtDiem(amount)} DIEM (${range} range)`;
    const entry = deps.approvals.create({
      title,
      createdBy: fromId,
      execute: async () => {
        // reinvestToLP builds its own client from rpcUrl — venice's
        // chain-narrowed PublicClient isn't assignable to liquidity's
        // generic one (OP-stack "deposit" tx type), so don't pass ours.
        const result = await reinvestToLP(
          deps.config.rpcUrl,
          deps.signer.address,
          amount,
          range,
          deps.txSender,
        );
        return [
          `position <code>#${result.tokenId.toString()}</code>`,
          `mint tx <code>${escapeHtml(result.mintTxHash)}</code> · ${basescanTx(result.mintTxHash)}`,
        ].join('\n');
      },
    });

    await ctx.reply(
      [
        `<b>${escapeHtml(title)}</b>`,
        `Wallet balance: ${fmtDiem(balance)} DIEM. Two txs: approve + single-sided mint below the current tick.`,
        'Position is persisted for the tick loop to manage. Confirm to sign.',
      ].join('\n'),
      { parse_mode: 'HTML', reply_markup: approvalKeyboard(entry.id) },
    );
  },
};
