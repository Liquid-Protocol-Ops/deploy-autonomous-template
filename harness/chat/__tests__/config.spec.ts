import { describe, expect, it } from 'vitest';
import { loadTelegramConfig, TelegramConfigError } from '../config.js';

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { TELEGRAM_BOT_TOKEN: '123:abc', ...extra };
}

describe('loadTelegramConfig', () => {
  it('requires TELEGRAM_BOT_TOKEN', () => {
    expect(() => loadTelegramConfig({})).toThrow(TelegramConfigError);
  });

  it('defaults dmPolicy=pairing, groupPolicy=allowlist, requireMention=true', () => {
    const cfg = loadTelegramConfig(env());
    expect(cfg.dmPolicy).toBe('pairing');
    expect(cfg.groupPolicy).toBe('allowlist');
    expect(cfg.requireMention).toBe(true);
    expect(cfg.textChunkLimit).toBe(4000);
    expect(cfg.ackReaction).toBe('👀');
    expect(cfg.errorPolicy).toBe('reply');
    expect(cfg.errorCooldownMs).toBe(60000);
    expect(cfg.pollingStallMs).toBe(120000);
  });

  it('strips leading @ from TELEGRAM_BOT_USERNAME', () => {
    expect(loadTelegramConfig(env({ TELEGRAM_BOT_USERNAME: '@autonomopolybot' })).botUsername)
      .toBe('autonomopolybot');
    expect(loadTelegramConfig(env({ TELEGRAM_BOT_USERNAME: 'autonomopolybot' })).botUsername)
      .toBe('autonomopolybot');
  });

  it('parses CSV of numeric allowlist with telegram: / tg: prefix tolerance', () => {
    const cfg = loadTelegramConfig(env({
      TELEGRAM_ALLOW_FROM: '12345, tg:67890, telegram:11111 ',
    }));
    expect([...cfg.staticAllowFrom].sort()).toEqual([11111, 12345, 67890]);
  });

  it('rejects non-numeric allowlist entries', () => {
    expect(() => loadTelegramConfig(env({ TELEGRAM_ALLOW_FROM: '12345,not-a-number' })))
      .toThrow(/not a numeric ID/);
  });

  it('rejects allowlist DM policy without explicit IDs', () => {
    expect(() => loadTelegramConfig(env({ TELEGRAM_DM_POLICY: 'allowlist' })))
      .toThrow(/requires at least one TELEGRAM_ALLOW_FROM/);
  });

  it('accepts allowlist DM policy with explicit IDs', () => {
    const cfg = loadTelegramConfig(env({
      TELEGRAM_DM_POLICY: 'allowlist',
      TELEGRAM_ALLOW_FROM: '12345',
    }));
    expect(cfg.dmPolicy).toBe('allowlist');
  });

  it('parses TELEGRAM_REQUIRE_MENTION false', () => {
    expect(loadTelegramConfig(env({ TELEGRAM_REQUIRE_MENTION: 'false' })).requireMention).toBe(false);
    expect(loadTelegramConfig(env({ TELEGRAM_REQUIRE_MENTION: 'true' })).requireMention).toBe(true);
    expect(loadTelegramConfig(env({ TELEGRAM_REQUIRE_MENTION: '0' })).requireMention).toBe(false);
  });

  it('rejects invalid policy values', () => {
    expect(() => loadTelegramConfig(env({ TELEGRAM_DM_POLICY: 'open' }))).toThrow(/TELEGRAM_DM_POLICY/);
    expect(() => loadTelegramConfig(env({ TELEGRAM_GROUP_POLICY: 'open' }))).toThrow(/TELEGRAM_GROUP_POLICY/);
    expect(() => loadTelegramConfig(env({ TELEGRAM_ERROR_POLICY: 'loud' }))).toThrow(/TELEGRAM_ERROR_POLICY/);
  });

  it('rejects negative / zero / NaN ints', () => {
    expect(() => loadTelegramConfig(env({ TELEGRAM_TEXT_CHUNK_LIMIT: '0' }))).toThrow();
    expect(() => loadTelegramConfig(env({ TELEGRAM_ERROR_COOLDOWN_MS: '-1' }))).toThrow();
    expect(() => loadTelegramConfig(env({ TELEGRAM_POLLING_STALL_MS: 'abc' }))).toThrow();
  });

  it('parses allowedGroups (negative IDs for supergroups)', () => {
    const cfg = loadTelegramConfig(env({ TELEGRAM_GROUPS: '-1001234567890, -1009876543210' }));
    expect([...cfg.allowedGroups].sort((a, b) => a - b)).toEqual([-1009876543210, -1001234567890]);
  });

  it('allows ackReaction="" to disable', () => {
    expect(loadTelegramConfig(env({ TELEGRAM_ACK_REACTION: '' })).ackReaction).toBe('');
  });
});
