// Telegram bot configuration — env-driven, mirrors a subset of
// openclaw's `channels.telegram.*` shape.
//
// REQUIRED to enable the bot:
//   TELEGRAM_BOT_TOKEN          — from @BotFather (e.g. "123456:ABC...")
//
// OPTIONAL (sane defaults if unset):
//   TELEGRAM_BOT_USERNAME       — without @, enables in-text mention parsing
//   TELEGRAM_DM_POLICY          — pairing (default) | allowlist | disabled
//   TELEGRAM_ALLOW_FROM         — CSV of numeric Telegram user IDs
//                                 (additive to pairing-store approvals)
//   TELEGRAM_GROUP_POLICY       — allowlist (default) | disabled
//   TELEGRAM_GROUPS             — CSV of group chat IDs
//                                 (negative numbers for supergroups)
//   TELEGRAM_REQUIRE_MENTION    — true (default) | false
//   TELEGRAM_TEXT_CHUNK_LIMIT   — int, default 4000
//   TELEGRAM_ACK_REACTION       — emoji string, default "👀";
//                                 set "" to disable
//   TELEGRAM_ERROR_POLICY       — reply (default) | silent
//   TELEGRAM_ERROR_COOLDOWN_MS  — int, default 60000
//   TELEGRAM_POLLING_STALL_MS   — int, default 120000
//
// Pairing state + owner allowlist persist in:
//   memory/pairing-pending.json
//   memory/owner-allowlist.json

export type DmPolicy = 'pairing' | 'allowlist' | 'disabled';
export type GroupPolicy = 'allowlist' | 'disabled';
export type ErrorPolicy = 'reply' | 'silent';

export interface TelegramConfig {
  botToken: string;
  botUsername: string | null;
  dmPolicy: DmPolicy;
  /** Numeric Telegram user IDs explicitly allowed beyond pairing approvals. */
  staticAllowFrom: ReadonlySet<number>;
  groupPolicy: GroupPolicy;
  /** Numeric group chat IDs allowed (negative numbers for supergroups). */
  allowedGroups: ReadonlySet<number>;
  requireMention: boolean;
  textChunkLimit: number;
  ackReaction: string;
  errorPolicy: ErrorPolicy;
  errorCooldownMs: number;
  pollingStallMs: number;
}

export class TelegramConfigError extends Error {
  constructor(message: string) {
    super(`Telegram config: ${message}`);
    this.name = 'TelegramConfigError';
  }
}

function parseNumericCsv(raw: string | undefined, name: string): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      // Accept openclaw's "telegram:" / "tg:" prefixes for compatibility.
      const stripped = entry.replace(/^(telegram|tg):/i, '');
      const n = Number.parseInt(stripped, 10);
      if (!Number.isFinite(n)) {
        throw new TelegramConfigError(`${name}: "${entry}" is not a numeric ID`);
      }
      return n;
    });
}

function parsePositiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new TelegramConfigError(`${name} must be a positive integer; got "${raw}"`);
  }
  return n;
}

function parseDmPolicy(raw: string | undefined): DmPolicy {
  const v = (raw ?? 'pairing').toLowerCase();
  if (v === 'pairing' || v === 'allowlist' || v === 'disabled') return v;
  throw new TelegramConfigError(
    `TELEGRAM_DM_POLICY must be one of: pairing | allowlist | disabled (got "${raw}")`,
  );
}

function parseGroupPolicy(raw: string | undefined): GroupPolicy {
  const v = (raw ?? 'allowlist').toLowerCase();
  if (v === 'allowlist' || v === 'disabled') return v;
  throw new TelegramConfigError(
    `TELEGRAM_GROUP_POLICY must be one of: allowlist | disabled (got "${raw}")`,
  );
}

function parseErrorPolicy(raw: string | undefined): ErrorPolicy {
  const v = (raw ?? 'reply').toLowerCase();
  if (v === 'reply' || v === 'silent') return v;
  throw new TelegramConfigError(
    `TELEGRAM_ERROR_POLICY must be one of: reply | silent (got "${raw}")`,
  );
}

function parseBool(raw: string | undefined, name: string, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new TelegramConfigError(`${name} must be true|false (got "${raw}")`);
}

/**
 * Load + validate Telegram config from process.env.
 *
 * Throws TelegramConfigError when required fields are missing or values
 * are malformed. Allowlist-allowlist guard (dmPolicy=allowlist with no
 * static allowFrom and no pairing-store entries) is enforced at runtime
 * by the policy module, not here.
 */
export function loadTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const botToken = env['TELEGRAM_BOT_TOKEN'];
  if (!botToken) {
    throw new TelegramConfigError('TELEGRAM_BOT_TOKEN is required');
  }

  const dmPolicy = parseDmPolicy(env['TELEGRAM_DM_POLICY']);
  const groupPolicy = parseGroupPolicy(env['TELEGRAM_GROUP_POLICY']);

  const staticAllowFrom = new Set(parseNumericCsv(env['TELEGRAM_ALLOW_FROM'], 'TELEGRAM_ALLOW_FROM'));
  const allowedGroups = new Set(parseNumericCsv(env['TELEGRAM_GROUPS'], 'TELEGRAM_GROUPS'));

  if (dmPolicy === 'allowlist' && staticAllowFrom.size === 0) {
    // Match openclaw's validation: allowlist with empty allowFrom would
    // block every DM. Pairing approvals can fill the set later, but
    // requiring at least one explicit ID here forces the operator to
    // think about who actually owns the bot.
    throw new TelegramConfigError(
      'TELEGRAM_DM_POLICY=allowlist requires at least one TELEGRAM_ALLOW_FROM entry',
    );
  }

  return {
    botToken,
    botUsername: env['TELEGRAM_BOT_USERNAME']?.replace(/^@/, '') ?? null,
    dmPolicy,
    staticAllowFrom,
    groupPolicy,
    allowedGroups,
    requireMention: parseBool(env['TELEGRAM_REQUIRE_MENTION'], 'TELEGRAM_REQUIRE_MENTION', true),
    textChunkLimit: parsePositiveInt(env['TELEGRAM_TEXT_CHUNK_LIMIT'], 'TELEGRAM_TEXT_CHUNK_LIMIT', 4000),
    ackReaction: env['TELEGRAM_ACK_REACTION'] ?? '👀',
    errorPolicy: parseErrorPolicy(env['TELEGRAM_ERROR_POLICY']),
    errorCooldownMs: parsePositiveInt(env['TELEGRAM_ERROR_COOLDOWN_MS'], 'TELEGRAM_ERROR_COOLDOWN_MS', 60000),
    pollingStallMs: parsePositiveInt(env['TELEGRAM_POLLING_STALL_MS'], 'TELEGRAM_POLLING_STALL_MS', 120000),
  };
}
