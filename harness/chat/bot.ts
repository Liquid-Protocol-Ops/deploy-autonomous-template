// grammY bot factory + middleware pipeline.
//
// The shape mirrors openclaw's gateway-side Telegram handler but
// scoped to one agent / one bot:
//
//   inbound update
//     → ack reaction (👀)
//     → policy evaluation (pairing | allowlist | groups + mention gating)
//     → command dispatch
//     → reply
//
// Per-chat sequencing, streaming preview, and the openclaw-style
// retry/timeout policies will land in follow-up PRs; for PR1 we
// rely on grammY's default `bot.start()` long-poll behavior.

import { Bot, GrammyError, HttpError } from 'grammy';
import type { Context } from 'grammy';
import type { TelegramConfig } from './config.js';
import type { CommandRegistry, ChatDeps } from './commands/registry.js';
import type { AllowlistStore, PairingStore } from './pairing.js';
import { evaluate, type Decision, type MessageContext } from './policy.js';
import { chunk, escapeHtml, stripHtml } from './formatters.js';
import { handleApprovalCallback } from './approvals.js';

export interface BotFactoryInput {
  config: TelegramConfig;
  deps: ChatDeps;
  registry: CommandRegistry;
  pairing: PairingStore;
  allowlist: AllowlistStore;
}

/**
 * Build a configured grammY Bot. Call `.start()` on the returned Bot to
 * begin long-polling, or pass it to a webhook adapter for serverless.
 */
export function createBot(input: BotFactoryInput): Bot {
  const { config, deps, registry, pairing, allowlist } = input;
  const bot = new Bot(config.botToken);

  // Per-chat last-error timestamp for errorCooldownMs.
  const lastErrorAt = new Map<number, number>();

  // Approval buttons — MUST register before the policy middleware:
  // callback updates carry no ctx.message, so the message-policy gate
  // below would swallow them. handleApprovalCallback does its own
  // owner check (only an allowlisted owner's press counts).
  bot.on('callback_query:data', async (ctx) => {
    await handleApprovalCallback(ctx, deps.approvals, allowlist);
  });

  bot.use(async (ctx, next) => {
    const msg = ctx.message;
    if (!msg || !msg.from || !msg.chat) return; // edits, joins, callbacks, etc.

    const msgCtx: MessageContext = {
      fromId: msg.from.id,
      chatId: msg.chat.id,
      chatType: msg.chat.type,
      isMention: detectMention(ctx, config.botUsername),
    };

    const decision = evaluate(config, allowlist, msgCtx);
    if (await handleDecision(ctx, decision, pairing)) {
      // Decision short-circuited (denied, paired, etc.) — don't dispatch.
      return;
    }

    // Ack reaction so the user knows we received it. Telegram only
    // accepts a fixed allowlist of emoji for reactions; the cast tells
    // TS we've vetted this one at config-load time.
    if (config.ackReaction) {
      void ctx.api
        .setMessageReaction(msg.chat.id, msg.message_id, [
          { type: 'emoji', emoji: config.ackReaction as '👀' },
        ])
        .catch(() => {
          // Reactions can fail for many reasons (bot not admin in
          // restricted group, unsupported emoji, etc.). Don't block the
          // command on it.
        });
    }

    await next();
  });

  // Command dispatch — grammY's `bot.command()` only matches the
  // canonical `/cmd@botusername arg` form, which is exactly what we
  // want (single source of truth for the parsed command name).
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const match = text.match(/^\/([a-zA-Z0-9_]{1,32})(?:@\w+)?(?:\s+(.*))?$/s);
    if (!match || !match[1]) return; // non-command text — ignore for v1

    const name = match[1].toLowerCase();
    const argString = match[2] ?? '';
    const args = argString.length > 0 ? argString.trim().split(/\s+/) : [];

    const cmd = registry.get(name);
    if (!cmd) {
      await safeReply(ctx, `Unknown command: <code>/${escapeHtml(name)}</code>`, lastErrorAt, config);
      return;
    }

    if (cmd.ownerOnly && !allowlist.isOwner(ctx.message.from.id)) {
      await safeReply(ctx, `<i>/${escapeHtml(name)} is owner-only.</i>`, lastErrorAt, config);
      return;
    }

    try {
      await cmd.handler(ctx, deps, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[bot] command /${name} failed:`, err);
      await safeReply(
        ctx,
        `<b>Error</b>\n<code>${escapeHtml(message)}</code>`,
        lastErrorAt,
        config,
      );
    }
  });

  bot.catch((err) => {
    // Top-level catch for grammY-internal errors (HTTP, parse, etc.).
    // Doesn't reach the user; we just log so the polling loop doesn't die silently.
    if (err.error instanceof GrammyError) {
      console.error(`[bot] grammY error: ${err.error.description}`);
    } else if (err.error instanceof HttpError) {
      console.error(`[bot] transport error: ${err.error.message}`);
    } else {
      console.error('[bot] unhandled:', err.error);
    }
  });

  return bot;
}

// ── Helpers ───────────────────────────────────────────────────────────

function detectMention(ctx: Context, botUsername: string | null): boolean {
  const msg = ctx.message;
  if (!msg) return false;

  // Reply to a bot message counts as a mention.
  if (msg.reply_to_message?.from?.is_bot && msg.reply_to_message.from.id === ctx.me.id) {
    return true;
  }

  // Telegram-native @mention entities.
  const entities = msg.entities ?? [];
  for (const entity of entities) {
    if (entity.type === 'mention' && botUsername) {
      const mentioned = (msg.text ?? '').slice(entity.offset + 1, entity.offset + entity.length);
      if (mentioned.toLowerCase() === botUsername.toLowerCase()) return true;
    }
    if (entity.type === 'text_mention' && entity.user?.id === ctx.me.id) {
      return true;
    }
  }
  return false;
}

async function handleDecision(
  ctx: Context,
  decision: Decision,
  pairing: PairingStore,
): Promise<boolean> {
  if (decision.kind === 'allow') return false;

  if (decision.kind === 'pair') {
    // Mint or reuse a pairing code and reply with instructions.
    const msg = ctx.message;
    if (!msg?.from) return true;
    try {
      const req = pairing.request(msg.from.id);
      await ctx.reply(
        [
          'Hello — this bot requires owner approval before I can answer.',
          '',
          `Your pairing code: <b><code>${req.code}</code></b>`,
          '',
          'The bot operator runs <code>npm run pair approve ' + req.code + '</code> on the host to approve. ',
          'Code expires in 1 hour.',
        ].join('\n'),
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.reply(`<i>${escapeHtml(message)}</i>`, { parse_mode: 'HTML' });
    }
    return true;
  }

  // decision.kind === 'deny'
  // Silent for group / mention denials (matches openclaw — bots shouldn't
  // shout "you're not allowed" in every group they happen to be in).
  // For DM denials, also stay silent: an attacker probing the bot
  // shouldn't learn whether they're close to a valid ID.
  return true;
}

async function safeReply(
  ctx: Context,
  htmlBody: string,
  lastErrorAt: Map<number, number>,
  config: TelegramConfig,
): Promise<void> {
  if (config.errorPolicy === 'silent') return;

  const chatId = ctx.chat?.id;
  if (chatId !== undefined) {
    const last = lastErrorAt.get(chatId) ?? 0;
    if (Date.now() - last < config.errorCooldownMs) return;
    lastErrorAt.set(chatId, Date.now());
  }

  // HTML first; on parse failure retry as plain text.
  try {
    for (const piece of chunk(htmlBody, config.textChunkLimit)) {
      await ctx.reply(piece, { parse_mode: 'HTML' });
    }
  } catch (err) {
    if (err instanceof GrammyError && err.description?.includes('parse')) {
      for (const piece of chunk(stripHtml(htmlBody), config.textChunkLimit)) {
        await ctx.reply(piece);
      }
    } else {
      // Re-throw non-parse errors so the top-level bot.catch can log them.
      throw err;
    }
  }
}

/**
 * Register the command menu with Telegram via `setMyCommands`. Call
 * once after bot.start() initiates; it's idempotent so re-running on
 * each start is safe.
 */
export async function registerCommandMenu(bot: Bot, registry: CommandRegistry): Promise<void> {
  const commands = registry.all().map((c) => ({
    command: c.name,
    description: c.description.slice(0, 256), // Telegram caps descriptions
  }));
  await bot.api.setMyCommands(commands);
}
