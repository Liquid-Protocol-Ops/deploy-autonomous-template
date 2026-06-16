import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Context } from 'grammy';
import {
  historyCommand,
  parseThoughts,
  pickLatestJournal,
  parseCount,
} from '../commands/history.js';
import type { ChatDeps } from '../commands/registry.js';

const thought = (ts: string, skill: string, thought: string) =>
  JSON.stringify({ ts, skill, thought });

describe('parseThoughts', () => {
  it('returns the last n valid entries in order', () => {
    const raw = [
      thought('2026-06-01T00:00:00Z', 'tick', 'one'),
      thought('2026-06-02T00:00:00Z', 'tick', 'two'),
      thought('2026-06-03T00:00:00Z', 'lp-monitor', 'three'),
    ].join('\n');
    const got = parseThoughts(raw, 2);
    expect(got.map((e) => e.thought)).toEqual(['two', 'three']);
  });

  it('skips malformed and incomplete lines without throwing', () => {
    const raw = [
      'not json at all',
      '{"ts":"2026-06-01T00:00:00Z"}', // missing fields
      thought('2026-06-02T00:00:00Z', 'tick', 'good'),
      '{"truncated": ', // interrupted append
    ].join('\n');
    const got = parseThoughts(raw, 10);
    expect(got).toHaveLength(1);
    expect(got[0]?.thought).toBe('good');
  });

  it('handles empty input', () => {
    expect(parseThoughts('', 5)).toEqual([]);
  });
});

describe('pickLatestJournal', () => {
  it('picks the lexically-latest YYYY-MM-DD.md', () => {
    expect(
      pickLatestJournal(['2026-05-16.md', '2026-06-09.md', '2026-05-18.md']),
    ).toBe('2026-06-09.md');
  });

  it('ignores non-journal files', () => {
    expect(pickLatestJournal(['notes.md', 'zzz.txt'])).toBeNull();
    expect(pickLatestJournal([])).toBeNull();
  });
});

describe('parseCount', () => {
  it('defaults to 10 and clamps to [1, 25]', () => {
    expect(parseCount(undefined)).toBe(10);
    expect(parseCount('abc')).toBe(10);
    expect(parseCount('5')).toBe(5);
    expect(parseCount('0')).toBe(1);
    expect(parseCount('999')).toBe(25);
  });
});

describe('historyCommand.handler', () => {
  let dir: string;
  let prevCwd: string;
  let replies: Array<{ text: string }>;
  let ctx: Context;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'da-hist-'));
    prevCwd = process.cwd();
    process.chdir(dir);
    replies = [];
    ctx = {
      reply: vi.fn(async (text: string) => {
        replies.push({ text });
        return {} as never;
      }),
    } as unknown as Context;
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  const deps = {} as ChatDeps; // /history reads files only — deps unused

  it('prefers thoughts.jsonl when present', async () => {
    mkdirSync('memory', { recursive: true });
    writeFileSync(
      'memory/thoughts.jsonl',
      [
        thought('2026-06-08T10:00:00Z', 'tick', 'staked DIEM'),
        thought('2026-06-09T11:00:00Z', 'tweet-broadcast', 'posted 3 tweets'),
      ].join('\n'),
    );
    await historyCommand.handler(ctx, deps, []);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toContain('tweet-broadcast');
    expect(replies[0]?.text).toContain('posted 3 tweets');
  });

  it('respects the count argument', async () => {
    mkdirSync('memory', { recursive: true });
    const lines = Array.from({ length: 5 }, (_, i) =>
      thought(`2026-06-0${i + 1}T00:00:00Z`, 'tick', `entry ${i + 1}`),
    );
    writeFileSync('memory/thoughts.jsonl', lines.join('\n'));
    await historyCommand.handler(ctx, deps, ['2']);
    expect(replies[0]?.text).toContain('entry 4');
    expect(replies[0]?.text).toContain('entry 5');
    expect(replies[0]?.text).not.toContain('entry 3');
  });

  it('falls back to the latest daily journal', async () => {
    mkdirSync('memory/logs', { recursive: true });
    writeFileSync('memory/logs/2026-06-08.md', '### old day');
    writeFileSync('memory/logs/2026-06-09.md', '### on-chain check — 2026-06-09');
    await historyCommand.handler(ctx, deps, []);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toContain('journal 2026-06-09');
    expect(replies[0]?.text).toContain('on-chain check');
  });

  it('says so when there is no memory yet', async () => {
    await historyCommand.handler(ctx, deps, []);
    expect(replies[0]?.text).toMatch(/No memory entries yet/);
  });
});
