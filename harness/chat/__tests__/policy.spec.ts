import { describe, expect, it } from 'vitest';
import { evaluate, type MessageContext, type AllowlistView } from '../policy.js';
import type { TelegramConfig } from '../config.js';

function cfg(overrides: Partial<TelegramConfig> = {}): TelegramConfig {
  return {
    botToken: '123:abc',
    botUsername: 'autonomopolybot',
    dmPolicy: 'pairing',
    staticAllowFrom: new Set<number>(),
    groupPolicy: 'allowlist',
    allowedGroups: new Set<number>(),
    requireMention: true,
    textChunkLimit: 4000,
    ackReaction: '👀',
    errorPolicy: 'reply',
    errorCooldownMs: 60_000,
    pollingStallMs: 120_000,
    ...overrides,
  };
}

function allow(ids: number[] = []): AllowlistView {
  return { isAllowed: (id) => ids.includes(id) };
}

function dm(fromId: number, isMention = false): MessageContext {
  return { fromId, chatId: fromId, chatType: 'private', isMention };
}

function group(fromId: number, chatId: number, isMention: boolean): MessageContext {
  return { fromId, chatId, chatType: 'supergroup', isMention };
}

describe('policy / DM', () => {
  it('static allowlist short-circuits to allow even in pairing mode', () => {
    const result = evaluate(cfg({ staticAllowFrom: new Set([42]) }), allow(), dm(42));
    expect(result).toEqual({ kind: 'allow' });
  });

  it('paired user (in dynamic allowlist) is allowed under pairing policy', () => {
    const result = evaluate(cfg(), allow([42]), dm(42));
    expect(result).toEqual({ kind: 'allow' });
  });

  it('unknown user under pairing policy gets a pair decision', () => {
    const result = evaluate(cfg(), allow(), dm(42));
    expect(result).toEqual({ kind: 'pair', reason: 'unknown_dm_sender' });
  });

  it('unknown user under allowlist policy is denied (no pair offered)', () => {
    const result = evaluate(
      cfg({ dmPolicy: 'allowlist', staticAllowFrom: new Set([99]) }),
      allow(),
      dm(42),
    );
    expect(result).toEqual({ kind: 'deny', reason: 'dm_not_in_allowlist' });
  });

  it('disabled DM policy denies known users too', () => {
    const result = evaluate(
      cfg({ dmPolicy: 'disabled', staticAllowFrom: new Set([42]) }),
      allow([42]),
      dm(42),
    );
    expect(result).toEqual({ kind: 'deny', reason: 'dm_disabled' });
  });
});

describe('policy / group', () => {
  it('blocks group not on allowlist', () => {
    const result = evaluate(
      cfg({ staticAllowFrom: new Set([42]) }),
      allow([42]),
      group(42, -100123, true),
    );
    expect(result).toEqual({ kind: 'deny', reason: 'group_not_in_allowlist' });
  });

  it('blocks unmentioned message in group with requireMention=true', () => {
    const c = cfg({
      staticAllowFrom: new Set([42]),
      allowedGroups: new Set([-100123]),
    });
    expect(evaluate(c, allow([42]), group(42, -100123, false))).toEqual({
      kind: 'deny',
      reason: 'group_mention_required',
    });
  });

  it('allows mentioned message from allow-listed sender in allow-listed group', () => {
    const c = cfg({
      staticAllowFrom: new Set([42]),
      allowedGroups: new Set([-100123]),
    });
    expect(evaluate(c, allow([42]), group(42, -100123, true))).toEqual({ kind: 'allow' });
  });

  it('group sender auth does NOT inherit pairing-store approvals (openclaw security boundary)', () => {
    const c = cfg({ allowedGroups: new Set([-100123]) });
    // user is paired for DMs but NOT in staticAllowFrom
    expect(evaluate(c, allow([42]), group(42, -100123, true))).toEqual({
      kind: 'deny',
      reason: 'dm_not_in_allowlist',
    });
  });

  it('allows when requireMention=false even without mention', () => {
    const c = cfg({
      staticAllowFrom: new Set([42]),
      allowedGroups: new Set([-100123]),
      requireMention: false,
    });
    expect(evaluate(c, allow([42]), group(42, -100123, false))).toEqual({ kind: 'allow' });
  });

  it('disabled group policy blocks even allow-listed groups', () => {
    const c = cfg({
      staticAllowFrom: new Set([42]),
      allowedGroups: new Set([-100123]),
      groupPolicy: 'disabled',
    });
    expect(evaluate(c, allow([42]), group(42, -100123, true))).toEqual({
      kind: 'deny',
      reason: 'group_disabled',
    });
  });
});

describe('policy / channel', () => {
  it('treats broadcast channels as unknown chat type', () => {
    const result = evaluate(cfg(), allow(), {
      fromId: 0,
      chatId: -1001,
      chatType: 'channel',
      isMention: false,
    });
    expect(result).toEqual({ kind: 'deny', reason: 'unknown_chat_type' });
  });
});
