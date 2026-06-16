// Inbound message policy: who's allowed to talk to the bot, and where.
//
// Combines the static config (TELEGRAM_DM_POLICY, allowedGroups,
// requireMention) with the dynamic pairing-store allowlist. Decisions
// are pure functions of (config, allowlist snapshot, message metadata)
// — no I/O, easy to unit-test.

import type { TelegramConfig } from './config.js';

export interface MessageContext {
  /** Numeric Telegram user ID of the sender (`from.id`). */
  fromId: number;
  /** Chat ID. Negative numbers are groups / supergroups. */
  chatId: number;
  /** Chat type — 'private' for DMs, otherwise group/supergroup/channel. */
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  /**
   * True if the message text mentions the bot — either as a native
   * @botusername mention or as a reply to a bot message. The caller
   * computes this from the inbound update payload; the policy layer
   * just decides whether it matters.
   */
  isMention: boolean;
}

export type Decision =
  | { kind: 'allow' }
  | { kind: 'pair'; reason: 'unknown_dm_sender' }
  | { kind: 'deny'; reason: DenyReason };

export type DenyReason =
  | 'dm_disabled'
  | 'dm_not_in_allowlist'
  | 'group_disabled'
  | 'group_not_in_allowlist'
  | 'group_mention_required'
  | 'unknown_chat_type';

export interface AllowlistView {
  /** Numeric IDs paired-and-approved at runtime. */
  isAllowed(telegramId: number): boolean;
}

/**
 * Evaluate whether the message should be processed.
 *
 * Returns 'pair' when the sender hits DM policy 'pairing' and isn't
 * already in the allowlist — the caller is expected to mint a pairing
 * code and respond out-of-band.
 *
 * Group authorization does NOT inherit DM pairing approvals (matches
 * openclaw's 2026.2.25+ security boundary): a user can be allow-listed
 * for DMs and still be unable to trigger the bot in a group unless
 * they're in `staticAllowFrom`.
 */
export function evaluate(
  config: TelegramConfig,
  allowlist: AllowlistView,
  ctx: MessageContext,
): Decision {
  if (ctx.chatType === 'private') {
    return evaluateDm(config, allowlist, ctx);
  }
  if (ctx.chatType === 'group' || ctx.chatType === 'supergroup') {
    return evaluateGroup(config, ctx);
  }
  // Channels are read-only one-way — bots can post but don't take commands.
  return { kind: 'deny', reason: 'unknown_chat_type' };
}

function evaluateDm(
  config: TelegramConfig,
  allowlist: AllowlistView,
  ctx: MessageContext,
): Decision {
  if (config.dmPolicy === 'disabled') {
    return { kind: 'deny', reason: 'dm_disabled' };
  }

  const inStaticAllowlist = config.staticAllowFrom.has(ctx.fromId);
  const inPairingStore = allowlist.isAllowed(ctx.fromId);

  if (inStaticAllowlist || inPairingStore) {
    return { kind: 'allow' };
  }

  if (config.dmPolicy === 'allowlist') {
    return { kind: 'deny', reason: 'dm_not_in_allowlist' };
  }

  // dmPolicy === 'pairing': unknown sender → mint a code.
  return { kind: 'pair', reason: 'unknown_dm_sender' };
}

function evaluateGroup(config: TelegramConfig, ctx: MessageContext): Decision {
  if (config.groupPolicy === 'disabled') {
    return { kind: 'deny', reason: 'group_disabled' };
  }

  // groupPolicy === 'allowlist'
  if (!config.allowedGroups.has(ctx.chatId)) {
    return { kind: 'deny', reason: 'group_not_in_allowlist' };
  }

  if (config.requireMention && !ctx.isMention) {
    return { kind: 'deny', reason: 'group_mention_required' };
  }

  // Group sender authorization: static allowlist only (matches openclaw
  // security boundary — pairing approvals don't extend to groups).
  if (!config.staticAllowFrom.has(ctx.fromId)) {
    return { kind: 'deny', reason: 'dm_not_in_allowlist' };
  }

  return { kind: 'allow' };
}
