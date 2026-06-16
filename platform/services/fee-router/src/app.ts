import { Hono } from 'hono';
import type { AgentRecord } from './registry.js';
import { fetchAgentChainInfo, makePublicClient, type PublicClient } from './chain.js';
import type { Address } from 'viem';

export interface AppConfig {
  agents: AgentRecord[];
  diemAddress: Address;
  feeLockerAddress: Address;
  client: PublicClient;
}

export function buildApp(config: AppConfig) {
  const app = new Hono();
  const { agents, diemAddress, feeLockerAddress, client } = config;

  app.get('/health', async c => {
    try {
      const block = await client.getBlockNumber();
      return c.json({ ok: true, block: block.toString() });
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 503);
    }
  });

  app.get('/agents', async c => {
    const results = await Promise.all(
      agents.map(async agent => {
        const chain = await fetchAgentChainInfo(
          agent.wallet, diemAddress, feeLockerAddress, client,
        );
        return {
          id: agent.id,
          name: agent.name,
          wallet: agent.wallet,
          claimableDiem: chain.claimableDiem,
          stakedDiem: chain.stakedDiem,
          blockNumber: chain.blockNumber.toString(),
        };
      }),
    );
    return c.json(results);
  });

  app.get('/agents/:id', async c => {
    const id = c.req.param('id');
    const agent = agents.find(a => a.id === id);
    if (!agent) return c.json({ error: `agent ${id} not found` }, 404);

    const chain = await fetchAgentChainInfo(
      agent.wallet, diemAddress, feeLockerAddress, client,
    );
    return c.json({
      id: agent.id,
      name: agent.name,
      wallet: agent.wallet,
      claimableDiem: chain.claimableDiem,
      stakedDiem: chain.stakedDiem,
      blockNumber: chain.blockNumber.toString(),
    });
  });

  return app;
}
