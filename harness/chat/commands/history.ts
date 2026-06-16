// /history [n] — recent entries from the agent's memory, read-only.
//
// Source preference mirrors the portal's reasoning panel:
//   1. memory/thoughts.jsonl — structured per-tick thoughts ({ts, skill,
//      thought}); live agents emit it. Shows the last n entries.
//   2. memory/logs/<date>.md — the daily journal; shows the most recent
//      file whole (n doesn't apply — a journal is one day's narrative).
//   3. Neither yet → say so (fresh template repos have an empty memory/).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chunk, escapeHtml } from '../formatters.js';
import type { Command } from './registry.js';

const THOUGHTS_PATH = 'memory/thoughts.jsonl';
const LOGS_DIR = 'memory/logs';

const DEFAULT_N = 10;
const MAX_N = 25;
const THOUGHT_CHAR_CAP = 280;

export interface ThoughtEntry {
  ts: string;
  skill: string;
  thought: string;
}

/** Last n valid thought entries from raw JSONL; malformed lines skipped. */
export function parseThoughts(raw: string, n: number): ThoughtEntry[] {
  const entries: ThoughtEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Partial<ThoughtEntry>;
      if (typeof obj.ts === 'string' && typeof obj.skill === 'string' && typeof obj.thought === 'string') {
        entries.push({ ts: obj.ts, skill: obj.skill, thought: obj.thought });
      }
    } catch {
      // skip malformed lines — an interrupted append must not kill /history
    }
  }
  return entries.slice(-n);
}

/** Most recent journal filename — YYYY-MM-DD.md names sort lexically. */
export function pickLatestJournal(names: string[]): string | null {
  const journals = names.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
  return journals.at(-1) ?? null;
}

/** Clamp the optional count arg to [1, MAX_N]; non-numeric → default. */
export function parseCount(arg: string | undefined): number {
  const n = Number.parseInt(arg ?? '', 10);
  if (Number.isNaN(n)) return DEFAULT_N;
  return Math.min(Math.max(n, 1), MAX_N);
}

function truncate(text: string, cap: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > cap ? `${oneLine.slice(0, cap - 1)}…` : oneLine;
}

export const historyCommand: Command = {
  name: 'history',
  description: 'Recent memory entries (thoughts or daily journal)',
  handler: async (ctx, _deps, args) => {
    const n = parseCount(args[0]);

    // 1. Structured thoughts (live agents).
    if (existsSync(THOUGHTS_PATH)) {
      const entries = parseThoughts(readFileSync(THOUGHTS_PATH, 'utf8'), n);
      if (entries.length > 0) {
        const lines = [`<b>Last ${entries.length} thoughts</b>`, ''];
        for (const e of entries) {
          lines.push(`<b>${escapeHtml(e.ts)}</b> — <i>${escapeHtml(e.skill)}</i>`);
          lines.push(escapeHtml(truncate(e.thought, THOUGHT_CHAR_CAP)));
          lines.push('');
        }
        for (const part of chunk(lines.join('\n').trim())) {
          await ctx.reply(part, { parse_mode: 'HTML' });
        }
        return;
      }
    }

    // 2. Daily journal fallback.
    if (existsSync(LOGS_DIR)) {
      const latest = pickLatestJournal(readdirSync(LOGS_DIR));
      if (latest) {
        const body = readFileSync(join(LOGS_DIR, latest), 'utf8').trim();
        if (body) {
          // Journal is markdown, not Telegram-HTML — send escaped plaintext.
          const text = `journal ${latest.replace(/\.md$/, '')}\n\n${body}`;
          for (const part of chunk(text)) {
            await ctx.reply(part);
          }
          return;
        }
      }
    }

    await ctx.reply("No memory entries yet — the agent hasn't ticked.");
  },
};
