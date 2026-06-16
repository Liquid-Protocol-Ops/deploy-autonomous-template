// Inline-button approval gate for wallet-touching commands — the
// openclaw exec-approval pattern, scoped to one agent / one bot.
//
// Flow: an owner-only command reads on-chain state, composes a human-
// readable preview (the "dry run"), and parks an `execute` thunk in the
// ApprovalStore. The reply carries an inline [Confirm]/[Cancel] keyboard.
// Nothing signs until the owner presses Confirm; Cancel or a 30-minute
// timeout drops the thunk without signing. Every execute() ultimately
// sends through the guarded TxSender (destination allow-list + value
// cap, fail closed) — this module adds the human gate, not the only gate.

import { randomBytes } from 'node:crypto';
import { InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import type { AllowlistStore } from './pairing.js';
import { escapeHtml } from './formatters.js';

export const APPROVAL_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING = 5;
const CALLBACK_PREFIX = 'appr';

export interface PendingApproval {
  id: string;
  /** Short imperative title, e.g. "Stake 12.5 DIEM". */
  title: string;
  /** Runs only on Confirm. Returns a human-readable result line. */
  execute: () => Promise<string>;
  /** Telegram user id that created the approval (the owner). */
  createdBy: number;
  createdAtMs: number;
}

export class ApprovalCapacityError extends Error {
  constructor() {
    super(`Too many pending approvals (max ${MAX_PENDING}) — confirm or cancel the open ones first.`);
  }
}

export class ApprovalStore {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly ttlMs: number = APPROVAL_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Park an execute thunk; returns the approval id for callback data. */
  create(input: { title: string; execute: () => Promise<string>; createdBy: number }): PendingApproval {
    this.sweep();
    if (this.pending.size >= MAX_PENDING) throw new ApprovalCapacityError();
    const id = randomBytes(6).toString('hex'); // 12 chars; callback_data caps at 64 bytes
    const entry: PendingApproval = { id, ...input, createdAtMs: this.now() };
    this.pending.set(id, entry);
    return entry;
  }

  /** Remove and return the entry, or null if unknown/expired. */
  take(id: string): PendingApproval | null {
    this.sweep();
    const entry = this.pending.get(id) ?? null;
    if (entry) this.pending.delete(id);
    return entry;
  }

  pendingCount(): number {
    this.sweep();
    return this.pending.size;
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.pending) {
      if (entry.createdAtMs < cutoff) this.pending.delete(id);
    }
  }
}

// ── Callback-data encoding ──────────────────────────────────────────

export type ApprovalAction = 'confirm' | 'cancel';

export function callbackData(id: string, action: ApprovalAction): string {
  return `${CALLBACK_PREFIX}:${id}:${action}`;
}

export function parseCallbackData(data: string): { id: string; action: ApprovalAction } | null {
  const m = data.match(/^appr:([0-9a-f]{12}):(confirm|cancel)$/);
  if (!m || !m[1] || !m[2]) return null;
  return { id: m[1], action: m[2] as ApprovalAction };
}

/** The [Confirm]/[Cancel] keyboard for an approval id. */
export function approvalKeyboard(id: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ Confirm', callbackData(id, 'confirm'))
    .text('✖ Cancel', callbackData(id, 'cancel'));
}

// ── Callback handling ───────────────────────────────────────────────
//
// Registered on `callback_query:data` BEFORE the policy middleware in
// bot.ts — callback updates carry no `ctx.message`, so the message-policy
// gate would otherwise swallow them. Authorization here is therefore
// explicit: only an allowlisted OWNER's press counts (a bystander in a
// group can see the buttons but their presses are rejected).

export async function handleApprovalCallback(
  ctx: Context,
  store: ApprovalStore,
  allowlist: AllowlistStore,
): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const fromId = ctx.callbackQuery?.from.id;
  if (!data || fromId === undefined) return;

  const parsed = parseCallbackData(data);
  if (!parsed) return; // not ours

  if (!allowlist.isOwner(fromId)) {
    await ctx.answerCallbackQuery({ text: 'Owner only.', show_alert: false }).catch(() => {});
    return;
  }

  const entry = store.take(parsed.id);
  if (!entry) {
    await ctx.answerCallbackQuery({ text: 'Expired or already handled.' }).catch(() => {});
    await editSafely(ctx, '<i>This approval expired or was already handled.</i>');
    return;
  }

  if (parsed.action === 'cancel') {
    await ctx.answerCallbackQuery({ text: 'Cancelled.' }).catch(() => {});
    await editSafely(ctx, `✖ <b>Cancelled</b> — ${escapeHtml(entry.title)}`);
    return;
  }

  // Confirm: acknowledge fast (Telegram times the callback out), then execute.
  await ctx.answerCallbackQuery({ text: 'Executing…' }).catch(() => {});
  await editSafely(ctx, `⏳ <b>Executing</b> — ${escapeHtml(entry.title)}`);
  try {
    const result = await entry.execute();
    await editSafely(ctx, `✅ <b>Done</b> — ${escapeHtml(entry.title)}\n${result}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await editSafely(ctx, `❌ <b>Failed</b> — ${escapeHtml(entry.title)}\n<code>${escapeHtml(msg)}</code>`);
  }
}

/** Edit the approval message in place; tolerate "message not modified" etc. */
async function editSafely(ctx: Context, html: string): Promise<void> {
  try {
    await ctx.editMessageText(html, { parse_mode: 'HTML' });
  } catch {
    // Editing can fail (message too old, already edited identically) —
    // the answerCallbackQuery toast already gave feedback; don't throw.
  }
}

export function basescanTx(hash: string): string {
  return `<a href="https://basescan.org/tx/${hash}">basescan</a>`;
}
