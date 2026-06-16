import { serve } from '@hono/node-server';
import { buildApp } from './app.js';
import { loadRegistry } from './registry.js';
import { makePublicClient } from './chain.js';

const rpcUrl = process.env['RPC_URL'];
if (!rpcUrl) throw new Error('RPC_URL is required');

const diemAddress = (process.env['DIEM_ADDRESS'] ?? '0xF4d97F2da56e8c3098f3a8D538DB630A2606a024') as `0x${string}`;
const feeLockerAddress = (process.env['FEE_LOCKER_ADDRESS'] ?? '0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF') as `0x${string}`;
const port = parseInt(process.env['PORT'] ?? '3001', 10);

const agents = loadRegistry();
const client = makePublicClient(rpcUrl);
const app = buildApp({ agents, diemAddress, feeLockerAddress, client });

serve({ fetch: app.fetch, port }, () => {
  console.log(`fee-router listening on :${port} — ${agents.length} agent(s) registered`);
});
