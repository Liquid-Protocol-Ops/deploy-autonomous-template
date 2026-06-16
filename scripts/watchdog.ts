/**
 * scripts/watchdog.ts
 *
 * Silent-stall watchdog. The harness records per-job failures in
 * memory/cron-state.json, but nothing alarms when dispatch itself dies
 * (disabled workflow, dead host, exhausted runner) — the only symptom is
 * absent commits, which nobody is watching for. This script runs on its
 * own schedule (.github/workflows/watchdog.yml), reads cron-state, and
 * alerts the owner via the agent's Telegram bot when the watched jobs
 * have had no success for longer than the threshold.
 *
 * One alert per stall, not per run: memory/watchdog-state.json latches
 * the newest-success timestamp we alerted about; the latch clears (with
 * a recovery message) once a fresh success appears.
 *
 * Env:
 *   WATCHDOG_JOBS            comma-separated cron-state job names (default: tick)
 *   WATCHDOG_THRESHOLD_HOURS staleness threshold (default: 3)
 *   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — optional; logs when unset
 *
 * A fresh clone with no cron-state.json (or none of the watched jobs) is
 * NOT a stall — agents that never ticked shouldn't page anyone at clone
 * time. That's the documented blind spot: the watchdog guards running
 * agents that stop, not agents that never started.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MEMORY_DIR = 'memory';
const CRON_STATE_PATH = join(MEMORY_DIR, 'cron-state.json');
const WATCHDOG_STATE_PATH = join(MEMORY_DIR, 'watchdog-state.json');

// ── Pure decision logic (unit-tested) ────────────────────────────────────

export interface CronJobEntry {
  last_success?: string;
  [key: string]: unknown;
}

export type CronState = Record<string, CronJobEntry>;

export interface Assessment {
  /** no-data: cron-state missing or none of the watched jobs present/parseable. */
  status: 'healthy' | 'stale' | 'no-data';
  /** Newest last_success across watched jobs (ms epoch), null on no-data. */
  newestSuccessMs: number | null;
  perJob: { job: string; lastSuccessMs: number | null }[];
}

export function assessLiveness(
  state: CronState | null,
  jobs: string[],
  thresholdMs: number,
  nowMs: number,
): Assessment {
  if (!state) return { status: 'no-data', newestSuccessMs: null, perJob: [] };

  const perJob = jobs.map((job) => {
    const raw = state[job]?.last_success;
    const parsed = raw ? Date.parse(raw) : NaN;
    return { job, lastSuccessMs: Number.isNaN(parsed) ? null : parsed };
  });

  const successes = perJob.map((j) => j.lastSuccessMs).filter((t): t is number => t !== null);
  if (successes.length === 0) return { status: 'no-data', newestSuccessMs: null, perJob };

  const newestSuccessMs = Math.max(...successes);
  const status = nowMs - newestSuccessMs > thresholdMs ? 'stale' : 'healthy';
  return { status, newestSuccessMs, perJob };
}

export interface WatchdogState {
  /** newestSuccessMs we already alerted about; null = no open alert. */
  alertedForMs: number | null;
}

export type WatchdogAction = 'alert' | 'already-alerted' | 'recovered' | 'none';

/**
 * Latch semantics: alert once per distinct stall (keyed by the stalled
 * newest-success timestamp), stay silent while the same stall persists,
 * emit one recovery when successes resume.
 */
export function decideAction(assessment: Assessment, latch: WatchdogState): WatchdogAction {
  if (assessment.status === 'stale') {
    return latch.alertedForMs === assessment.newestSuccessMs ? 'already-alerted' : 'alert';
  }
  // healthy or no-data: clear an open latch with a recovery note (healthy
  // only — a transition to no-data means the state file vanished; stay quiet).
  if (assessment.status === 'healthy' && latch.alertedForMs !== null) return 'recovered';
  return 'none';
}

// ── IO ────────────────────────────────────────────────────────────────────

function loadCronState(): CronState | null {
  if (!existsSync(CRON_STATE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CRON_STATE_PATH, 'utf8')) as CronState;
  } catch {
    return null; // unreadable = no-data, not a stall
  }
}

function loadWatchdogState(): WatchdogState {
  if (!existsSync(WATCHDOG_STATE_PATH)) return { alertedForMs: null };
  try {
    return JSON.parse(readFileSync(WATCHDOG_STATE_PATH, 'utf8')) as WatchdogState;
  } catch {
    return { alertedForMs: null };
  }
}

function saveWatchdogState(state: WatchdogState): void {
  mkdirSync(MEMORY_DIR, { recursive: true });
  writeFileSync(WATCHDOG_STATE_PATH, JSON.stringify(state, null, 2));
}

async function sendTelegram(text: string): Promise<void> {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  const chatId = process.env['TELEGRAM_CHAT_ID'];
  if (!token || !chatId) {
    console.log('[telegram] (not configured — would send):', text.replace(/\n/g, ' '));
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) console.error('[telegram] Send failed:', res.status, await res.text());
  } catch (err) {
    console.error('[telegram] Fetch error:', err);
  }
}

function fmtAge(ms: number): string {
  const hours = ms / 3_600_000;
  return hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.round(ms / 60_000)}m`;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const jobs = (process.env['WATCHDOG_JOBS'] ?? 'tick')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const thresholdMs = Number(process.env['WATCHDOG_THRESHOLD_HOURS'] ?? 3) * 3_600_000;
  const now = Date.now();

  const assessment = assessLiveness(loadCronState(), jobs, thresholdMs, now);
  const latch = loadWatchdogState();
  const action = decideAction(assessment, latch);

  const repo = process.env['GITHUB_REPOSITORY'] ?? 'this agent';
  console.log(
    `[watchdog] status=${assessment.status} action=${action} jobs=${jobs.join(',')} ` +
      `newestSuccess=${assessment.newestSuccessMs ? new Date(assessment.newestSuccessMs).toISOString() : 'n/a'}`,
  );

  switch (action) {
    case 'alert': {
      const age = fmtAge(now - assessment.newestSuccessMs!);
      const detail = assessment.perJob
        .map((j) => `  ${j.job}: ${j.lastSuccessMs ? new Date(j.lastSuccessMs).toISOString() : 'never'}`)
        .join('\n');
      await sendTelegram(
        `🚨 <b>${repo} looks stalled</b>\n` +
          `No successful watched job for <b>${age}</b> (threshold ${fmtAge(thresholdMs)}).\n` +
          `Last successes:\n${detail}\n` +
          `Check the Actions tab — the schedule may be disabled or the host down.`,
      );
      saveWatchdogState({ alertedForMs: assessment.newestSuccessMs });
      break;
    }
    case 'recovered': {
      await sendTelegram(`✅ <b>${repo} recovered</b> — watched jobs are succeeding again.`);
      saveWatchdogState({ alertedForMs: null });
      break;
    }
    case 'already-alerted':
    case 'none':
      break; // latch unchanged, nothing to say
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((err: unknown) => {
    console.error('[watchdog] fatal:', err);
    process.exit(1);
  });
}
