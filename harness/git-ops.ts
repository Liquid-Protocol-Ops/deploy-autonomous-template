// Agent-initiated git operations — all paths gated by the allowlist.
//
// Only files the agent is permitted to mutate (identity/SOUL.md,
// identity/STYLE.md, memory/**, wiki/**) can be staged. Attempts to
// stage anything else throw AllowlistViolation before git is invoked.
//
// The GitRunner parameter is injectable so tests can verify the exact
// git commands issued without spawning real processes.

import { spawnSync } from 'node:child_process';
import { assertAllowed } from './safety/allowlist.js';

// ── Types ────────────────────────────────────────────────────────────

export type GitResult = { exitCode: number; stdout: string; stderr: string };
export type GitRunner = (args: string[]) => GitResult;

// ── Default runner ───────────────────────────────────────────────────

function defaultRunner(args: string[]): GitResult {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  return { exitCode: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// ── Public API ───────────────────────────────────────────────────────

export function stageFile(path: string, run: GitRunner = defaultRunner): void {
  assertAllowed(path);
  const { exitCode, stderr } = run(['add', '--', path]);
  if (exitCode !== 0) throw new Error(`git add failed (${path}): ${stderr.trim()}`);
}

export function stageFiles(paths: string[], run: GitRunner = defaultRunner): void {
  for (const path of paths) stageFile(path, run);
}

export function commitStaged(message: string, run: GitRunner = defaultRunner): void {
  if (!message.trim()) throw new Error('commit message must not be empty');
  const { exitCode, stderr } = run(['commit', '-m', message]);
  if (exitCode !== 0) throw new Error(`git commit failed: ${stderr.trim()}`);
}

export function stageAndCommit(
  paths: string[],
  message: string,
  run: GitRunner = defaultRunner,
): void {
  stageFiles(paths, run);
  commitStaged(message, run);
}
