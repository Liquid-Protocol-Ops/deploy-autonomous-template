import { describe, expect, it, beforeEach, vi } from 'vitest';
import { parseEther } from 'viem';
import type { Context } from 'grammy';
import { ApprovalStore } from '../approvals.js';
import type { ChatDeps } from '../commands/registry.js';

const getClaimable = vi.fn();
const getDiemBalance = vi.fn();
const claimDiem = vi.fn();
const stakeDiem = vi.fn();
const reinvestToLP = vi.fn();

vi.mock('../../providers/venice.js', () => ({
  getClaimable: (...a: unknown[]) => getClaimable(...a),
  getDiemBalance: (...a: unknown[]) => getDiemBalance(...a),
  claimDiem: (...a: unknown[]) => claimDiem(...a),
  stakeDiem: (...a: unknown[]) => stakeDiem(...a),
}));

vi.mock('../../providers/liquidity.js', () => ({
  reinvestToLP: (...a: unknown[]) => reinvestToLP(...a),
}));

const { claimCommand } = await import('../commands/claim.js');
const { stakeCommand, parseStakeAmount } = await import('../commands/stake.js');
const { lpCommand, parseRange } = await import('../commands/lp.js');

const OWNER = 111;

type Reply = { text: string; hasKeyboard: boolean; approvalId: string | null };

/** Pull the approval id out of the reply's [Confirm] button callback data. */
function extractApprovalId(replyMarkup: unknown): string | null {
  const kb = (replyMarkup as { inline_keyboard?: { callback_data?: string }[][] })?.inline_keyboard;
  const data = kb?.[0]?.[0]?.callback_data;
  const m = data?.match(/^appr:([0-9a-f]{12}):confirm$/);
  return m?.[1] ?? null;
}

function makeCtx() {
  const replies: Reply[] = [];
  const ctx = {
    message: { from: { id: OWNER } },
    reply: vi.fn(async (text: string, opts?: { reply_markup?: unknown }) => {
      replies.push({
        text,
        hasKeyboard: Boolean(opts?.reply_markup),
        approvalId: extractApprovalId(opts?.reply_markup),
      });
      return {} as never;
    }),
  } as unknown as Context;
  return { ctx, replies };
}

function makeDeps(approvals: ApprovalStore): ChatDeps {
  return {
    signer: { address: '0xagent' },
    publicClient: {},
    config: { rpcUrl: 'http://rpc', diemAddress: '0xdiem' },
    allowlist: {},
    txSender: vi.fn(),
    approvals,
  } as unknown as ChatDeps;
}

describe('parseStakeAmount', () => {
  const balance = parseEther('10');

  it('parses decimal amounts within balance', () => {
    expect(parseStakeAmount('2.5', balance)).toBe(parseEther('2.5'));
  });

  it('"all" returns the full balance, but errors on zero', () => {
    expect(parseStakeAmount('all', balance)).toBe(balance);
    expect(parseStakeAmount('all', 0n)).toMatchObject({ error: expect.stringContaining('0') });
  });

  it('rejects missing, malformed, non-positive, and over-balance amounts', () => {
    expect(parseStakeAmount(undefined, balance)).toMatchObject({ error: expect.stringContaining('Usage') });
    expect(parseStakeAmount('lots', balance)).toMatchObject({ error: expect.stringContaining("Can't parse") });
    expect(parseStakeAmount('0', balance)).toMatchObject({ error: expect.stringContaining('positive') });
    expect(parseStakeAmount('11', balance)).toMatchObject({ error: expect.stringContaining('exceeds') });
  });
});

describe('parseRange', () => {
  it('defaults to short and accepts medium', () => {
    expect(parseRange(undefined)).toBe('short');
    expect(parseRange('MEDIUM')).toBe('medium');
    expect(parseRange('wide')).toMatchObject({ error: expect.stringContaining('short') });
  });
});

describe('wallet commands', () => {
  let approvals: ApprovalStore;
  let deps: ChatDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    approvals = new ApprovalStore();
    deps = makeDeps(approvals);
  });

  it('all three are owner-only', () => {
    expect(claimCommand.ownerOnly).toBe(true);
    expect(stakeCommand.ownerOnly).toBe(true);
    expect(lpCommand.ownerOnly).toBe(true);
  });

  it('/claim with zero claimable replies and parks nothing', async () => {
    getClaimable.mockResolvedValue(0n);
    const { ctx, replies } = makeCtx();

    await claimCommand.handler(ctx, deps, []);

    expect(replies[0]?.text).toContain('Nothing to claim');
    expect(replies[0]?.hasKeyboard).toBe(false);
    expect(approvals.pendingCount()).toBe(0);
  });

  it('/claim parks an approval; nothing signs until execute() runs', async () => {
    getClaimable.mockResolvedValue(parseEther('5'));
    claimDiem.mockResolvedValue('0xhash');
    const { ctx, replies } = makeCtx();

    await claimCommand.handler(ctx, deps, []);

    expect(replies[0]?.text).toContain('Claim 5.00 DIEM');
    expect(replies[0]?.approvalId).toMatch(/^[0-9a-f]{12}$/);
    expect(claimDiem).not.toHaveBeenCalled(); // the approval gate is real

    // Confirm path: execute() routes through claimDiem with the guarded txSender.
    const entry = approvals.take(replies[0]!.approvalId!);
    expect(entry).not.toBeNull();
    const result = await entry!.execute();
    expect(claimDiem).toHaveBeenCalledWith(deps.config, deps.signer.address, deps.txSender);
    expect(result).toContain('0xhash');
  });

  it('/stake validates args against the live balance and parks the parsed amount', async () => {
    getDiemBalance.mockResolvedValue(parseEther('10'));
    stakeDiem.mockResolvedValue('0xstakehash');
    const { ctx, replies } = makeCtx();

    await stakeCommand.handler(ctx, deps, ['2.5']);

    expect(replies[0]?.text).toContain('Stake 2.50 DIEM');
    expect(replies[0]?.hasKeyboard).toBe(true);
    expect(stakeDiem).not.toHaveBeenCalled();
    expect(approvals.pendingCount()).toBe(1);
  });

  it('/stake rejects over-balance without parking an approval', async () => {
    getDiemBalance.mockResolvedValue(parseEther('1'));
    const { ctx, replies } = makeCtx();

    await stakeCommand.handler(ctx, deps, ['5']);

    expect(replies[0]?.text).toContain('exceeds');
    expect(replies[0]?.hasKeyboard).toBe(false);
    expect(approvals.pendingCount()).toBe(0);
  });

  it('/lp parks an approval whose execute calls reinvestToLP and formats the position', async () => {
    getDiemBalance.mockResolvedValue(parseEther('10'));
    reinvestToLP.mockResolvedValue({
      approveTxHash: '0xapprove',
      mintTxHash: '0xmint',
      tokenId: 42n,
      liquidity: 1n,
    });
    const { ctx, replies } = makeCtx();

    await lpCommand.handler(ctx, deps, ['all', 'medium']);

    expect(replies[0]?.text).toContain('LP 10.00 DIEM');
    expect(replies[0]?.text).toContain('medium');
    expect(replies[0]?.hasKeyboard).toBe(true);
    expect(reinvestToLP).not.toHaveBeenCalled();
  });

  it('/lp rewrites the usage line and rejects bad ranges', async () => {
    getDiemBalance.mockResolvedValue(parseEther('10'));
    const { ctx, replies } = makeCtx();

    await lpCommand.handler(ctx, deps, []);
    expect(replies[0]?.text).toContain('/lp <amount|all>');

    await lpCommand.handler(ctx, deps, ['1', 'wide']);
    expect(replies[1]?.text).toContain('short');
    expect(approvals.pendingCount()).toBe(0);
  });
});
