// /think <prompt> — ask the agent a question through its own inference
// provider (Venice). The reply comes back in the agent's voice when
// identity/SOUL.md exists (live agents); template repos fall back to a
// generic system line.
//
// Owner-only: every call spends staked DIEM (inference credits are the
// agent's money). The bot middleware enforces ownerOnly before the
// handler runs — no wallet write happens here, so no inline-button
// approval is needed (that machinery lands with PR3's wallet commands).

import { existsSync, readFileSync } from 'node:fs';
import { callInference, loadOrMintBearer } from '../../providers/venice.js';
import { chunk } from '../formatters.js';
import type { Command } from './registry.js';

// Same env-or-default as harness/tick.ts so bot-initiated inference lands
// in the same tool-routing log as tick-initiated inference.
const LOG_PATH = process.env['TOOL_ROUTING_LOG'] ?? 'memory/tool-routing.jsonl';

const SOUL_PATH = 'identity/SOUL.md';
const SOUL_CHAR_CAP = 4000;
const FALLBACK_SYSTEM_PROMPT =
  'You are an autonomous on-chain agent. Answer the owner concisely and plainly.';

/**
 * The agent's soul as a system prompt, capped so a long identity file
 * can't blow up the prompt budget. Template repos ship only
 * SOUL.md.template, so the fallback line is the common cold-start path.
 */
export function loadSoul(soulPath = SOUL_PATH): string {
  if (!existsSync(soulPath)) return FALLBACK_SYSTEM_PROMPT;
  try {
    const raw = readFileSync(soulPath, 'utf8').trim();
    if (!raw) return FALLBACK_SYSTEM_PROMPT;
    return raw.length > SOUL_CHAR_CAP ? raw.slice(0, SOUL_CHAR_CAP) : raw;
  } catch {
    return FALLBACK_SYSTEM_PROMPT;
  }
}

export const thinkCommand: Command = {
  name: 'think',
  description: 'Ask the agent — replies via its own inference (spends DIEM)',
  ownerOnly: true,
  handler: async (ctx, deps, args) => {
    const prompt = args.join(' ').trim();
    if (!prompt) {
      await ctx.reply('Usage: /think <prompt>');
      return;
    }

    try {
      const bearer = await loadOrMintBearer(deps.config, deps.signer);
      const answer = await callInference(
        deps.config,
        bearer,
        { prompt, systemPrompt: loadSoul() },
        LOG_PATH,
      );

      const text = answer.trim() || '(empty reply from inference)';
      // Model output is plain text — no parse_mode, so nothing in the
      // reply can break Telegram's HTML parser.
      for (const part of chunk(text)) {
        await ctx.reply(part);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`inference failed: ${msg}`);
    }
  },
};
