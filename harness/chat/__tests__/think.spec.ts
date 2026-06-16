import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Context } from 'grammy';
import type { ChatDeps } from '../commands/registry.js';

const loadOrMintBearer = vi.fn();
const callInference = vi.fn();

vi.mock('../../providers/venice.js', () => ({
  loadOrMintBearer: (...args: unknown[]) => loadOrMintBearer(...args),
  callInference: (...args: unknown[]) => callInference(...args),
}));

// Import after the mock so think.ts binds to the stubs.
const { thinkCommand, loadSoul } = await import('../commands/think.js');

describe('loadSoul', () => {
  let dir: string;
  let prevCwd: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'da-soul-'));
    prevCwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the generic line when SOUL.md is absent (template repos)', () => {
    expect(loadSoul()).toMatch(/autonomous on-chain agent/);
  });

  it('reads identity/SOUL.md when present and caps its length', () => {
    mkdirSync('identity', { recursive: true });
    writeFileSync('identity/SOUL.md', 'I am AUTONOMOPOLY.');
    expect(loadSoul()).toBe('I am AUTONOMOPOLY.');

    writeFileSync('identity/SOUL.md', 'x'.repeat(10_000));
    expect(loadSoul().length).toBe(4000);
  });
});

describe('thinkCommand', () => {
  let replies: string[];
  let ctx: Context;
  const deps = { config: { model: 'llama-3.3-70b' }, signer: { address: '0xabc' } } as unknown as ChatDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    replies = [];
    ctx = {
      reply: vi.fn(async (text: string) => {
        replies.push(text);
        return {} as never;
      }),
    } as unknown as Context;
  });

  it('is owner-only (spends DIEM)', () => {
    expect(thinkCommand.ownerOnly).toBe(true);
  });

  it('replies with usage when no prompt is given', async () => {
    await thinkCommand.handler(ctx, deps, []);
    expect(replies[0]).toMatch(/Usage: \/think/);
    expect(callInference).not.toHaveBeenCalled();
  });

  it('joins args into the prompt and replies with the inference answer', async () => {
    loadOrMintBearer.mockResolvedValue('bearer-123');
    callInference.mockResolvedValue('the answer');

    await thinkCommand.handler(ctx, deps, ['why', 'did', 'you', 'stake?']);

    expect(loadOrMintBearer).toHaveBeenCalledWith(deps.config, deps.signer);
    const opts = callInference.mock.calls[0]?.[2] as { prompt: string; systemPrompt: string };
    expect(opts.prompt).toBe('why did you stake?');
    expect(opts.systemPrompt).toBeTruthy();
    expect(replies).toEqual(['the answer']);
  });

  it('reports inference errors as a reply instead of throwing', async () => {
    loadOrMintBearer.mockResolvedValue('bearer-123');
    callInference.mockRejectedValue(new Error('Venice inference failed: 402'));

    await expect(thinkCommand.handler(ctx, deps, ['hi'])).resolves.toBeUndefined();
    expect(replies[0]).toMatch(/inference failed: Venice inference failed: 402/);
  });

  it('handles an empty model reply', async () => {
    loadOrMintBearer.mockResolvedValue('bearer-123');
    callInference.mockResolvedValue('   ');

    await thinkCommand.handler(ctx, deps, ['hi']);
    expect(replies[0]).toMatch(/empty reply/);
  });
});
