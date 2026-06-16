import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildApp, type AppConfig } from '../app.js';
import type { PublicClient } from '../chain.js';
import type { AgentRecord } from '../registry.js';

// ── Fixtures ──────────────────────────────────────────────────────────

const AGENT_ALPHA: AgentRecord = {
  id: 'alpha',
  name: 'Alpha Agent',
  wallet: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

const DIEM = '0xF4d97F2da56e8c3098f3a8D538DB630A2606a024' as const;
const FEE_LOCKER = '0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF' as const;

function mockClient(overrides: Partial<{
  claimable: bigint;
  staked: bigint;
  block: bigint;
  blockThrows: boolean;
}> = {}): PublicClient {
  const { claimable = 1_500_000_000_000_000_000n, staked = 5_000_000_000_000_000_000n, block = 12345678n, blockThrows = false } = overrides;

  return {
    readContract: vi.fn(({ functionName }: { functionName: string }) => {
      if (functionName === 'availableFees') return Promise.resolve(claimable);
      if (functionName === 'balanceOf') return Promise.resolve(staked);
      return Promise.resolve(0n);
    }),
    getBlockNumber: blockThrows
      ? vi.fn().mockRejectedValue(new Error('RPC error'))
      : vi.fn().mockResolvedValue(block),
  } as unknown as PublicClient;
}

function makeConfig(
  agents: AgentRecord[] = [AGENT_ALPHA],
  client: PublicClient = mockClient(),
): AppConfig {
  return { agents, diemAddress: DIEM, feeLockerAddress: FEE_LOCKER, client };
}

// ── GET /health ───────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns ok: true with block number', async () => {
    const app = buildApp(makeConfig());
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; block: string };
    expect(body.ok).toBe(true);
    expect(body.block).toBe('12345678');
  });

  it('returns 503 when RPC is unavailable', async () => {
    const app = buildApp(makeConfig([], mockClient({ blockThrows: true })));
    const res = await app.request('/health');
    expect(res.status).toBe(503);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});

// ── GET /agents ───────────────────────────────────────────────────────

describe('GET /agents', () => {
  it('returns all registered agents with chain data', async () => {
    const app = buildApp(makeConfig());
    const res = await app.request('/agents');
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(body).toHaveLength(1);
  });

  it('returns correct claimableDiem and stakedDiem as decimal strings', async () => {
    const app = buildApp(makeConfig());
    const res = await app.request('/agents');
    const [agent] = await res.json() as { claimableDiem: string; stakedDiem: string }[];
    // 1.5e18 wei → "1.5"
    expect(agent?.claimableDiem).toBe('1.5');
    // 5e18 wei → "5"
    expect(agent?.stakedDiem).toBe('5');
  });

  it('returns wallet and id in response', async () => {
    const app = buildApp(makeConfig());
    const res = await app.request('/agents');
    const [agent] = await res.json() as { id: string; wallet: string }[];
    expect(agent?.id).toBe('alpha');
    expect(agent?.wallet).toBe(AGENT_ALPHA.wallet);
  });

  it('returns empty array when no agents are registered', async () => {
    const app = buildApp(makeConfig([]));
    const res = await app.request('/agents');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

// ── GET /agents/:id ───────────────────────────────────────────────────

describe('GET /agents/:id', () => {
  it('returns the agent by id', async () => {
    const app = buildApp(makeConfig());
    const res = await app.request('/agents/alpha');
    expect(res.status).toBe(200);
    const body = await res.json() as { id: string };
    expect(body.id).toBe('alpha');
  });

  it('returns 404 for an unknown id', async () => {
    const app = buildApp(makeConfig());
    const res = await app.request('/agents/unknown');
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/not found/);
  });

  it('returns chain data for the specific agent', async () => {
    const client = mockClient({ claimable: 250_000_000_000_000_000n }); // 0.25 DIEM
    const app = buildApp(makeConfig([AGENT_ALPHA], client));
    const res = await app.request('/agents/alpha');
    const body = await res.json() as { claimableDiem: string };
    expect(body.claimableDiem).toBe('0.25');
  });
});

// ── registry ──────────────────────────────────────────────────────────

describe('loadRegistry', () => {
  beforeEach(() => { delete process.env['AGENTS']; });

  it('returns empty array when AGENTS env is unset', async () => {
    const { loadRegistry } = await import('../registry.js');
    expect(loadRegistry()).toEqual([]);
  });

  it('parses a JSON array from AGENTS env', async () => {
    process.env['AGENTS'] = JSON.stringify([AGENT_ALPHA]);
    const { loadRegistry } = await import('../registry.js');
    const agents = loadRegistry();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.id).toBe('alpha');
  });
});
