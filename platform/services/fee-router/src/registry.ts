import type { Address } from 'viem';

export interface AgentRecord {
  id: string;
  name: string;
  wallet: Address;
}

// Registry is loaded from the AGENTS env var as a JSON array.
// Example: AGENTS='[{"id":"alpha","name":"Alpha Agent","wallet":"0xABC..."}]'
export function loadRegistry(): AgentRecord[] {
  const raw = process.env['AGENTS'];
  if (!raw) return [];
  try {
    return JSON.parse(raw) as AgentRecord[];
  } catch {
    throw new Error('AGENTS env var must be a valid JSON array of {id, name, wallet} objects');
  }
}
