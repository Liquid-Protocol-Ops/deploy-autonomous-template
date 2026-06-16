/**
 * scripts/lib/resolve-addresses.ts
 *
 * Pure address-resolution helpers shared by the on-chain scripts. Kept free of
 * side effects (no env reads at import time, no network) so they can be unit
 * tested directly.
 *
 * These exist so the scripts never hardcode a specific agent's wallet or token
 * address — each agent supplies its own via env / CLI, and a malformed or
 * missing value fails loudly instead of silently transacting against the wrong
 * address.
 */

import { isAddress, getAddress, type Address } from 'viem';

/**
 * DIEM ERC-20 on Base mainnet — the canonical paired token for every agent
 * pool. This is a protocol constant (not agent-specific), so it stays fixed.
 */
export const DIEM_ADDRESS: Address = getAddress('0xF4d97F2da56e8c3098f3a8D538DB630A2606a024');

/**
 * Resolve a required address from an env var. Throws a clear error if the
 * variable is unset/blank or not a valid 0x address. Returns the checksummed
 * form.
 */
export function requireAddressEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  hint?: string,
): Address {
  const raw = env[key];
  if (!raw || raw.trim() === '') {
    throw new Error(`${key} is required${hint ? ` — ${hint}` : ''}`);
  }
  if (!isAddress(raw.trim())) {
    throw new Error(`${key} is not a valid address: ${raw}`);
  }
  return getAddress(raw.trim());
}

/**
 * Resolve the token-launch creator / fee recipient. Prefers an explicit
 * `--creator` CLI value; otherwise falls back to the `AGENT_WALLET` env var.
 * Throws if neither is provided or the value is malformed. Returns checksummed.
 *
 * Fail-closed creator guard: the creator becomes the token's `tokenAdmin`,
 * `rewardAdmins`, `rewardRecipients`, and `feeRecipient`. Because launch params
 * can originate from an agent-writable queue, a non-agent creator is a fee/admin
 * redirection vector. When `AGENT_WALLET` is set, the resolved creator MUST equal
 * it, unless an operator explicitly allow-lists other addresses via
 * `LAUNCH_CREATOR_ALLOWLIST` (comma-separated). With no `AGENT_WALLET` there is no
 * agent identity to pin to, so an explicit valid creator is returned as-is.
 */
export function resolveCreator(
  argCreator: string | undefined,
  env: NodeJS.ProcessEnv,
): Address {
  const raw = (argCreator ?? env['AGENT_WALLET'])?.trim();
  if (!raw) {
    throw new Error('No creator: pass --creator 0x… or set AGENT_WALLET');
  }
  if (!isAddress(raw)) {
    throw new Error(`creator is not a valid address: ${raw}`);
  }
  const creator = getAddress(raw);

  const allowed = new Set<string>();
  const agentWallet = env['AGENT_WALLET']?.trim();
  if (agentWallet) {
    // Fail loud: a malformed-but-present AGENT_WALLET must not silently empty the
    // allow-set and let the creator pin fail OPEN (review note #48).
    if (!isAddress(agentWallet)) {
      throw new Error(`AGENT_WALLET is set but not a valid address: ${agentWallet}`);
    }
    allowed.add(getAddress(agentWallet).toLowerCase());
  }
  for (const a of (env['LAUNCH_CREATOR_ALLOWLIST'] ?? '').split(',')) {
    const t = a.trim();
    if (t && isAddress(t)) allowed.add(getAddress(t).toLowerCase());
  }
  if (allowed.size > 0 && !allowed.has(creator.toLowerCase())) {
    throw new Error(
      `creator ${creator} is not allow-listed — refusing to route token admin/fees ` +
        `to a non-agent address. Set LAUNCH_CREATOR_ALLOWLIST to permit it.`,
    );
  }
  return creator;
}

/**
 * Build a sorted Uniswap V4 currency pair. V4 requires `currency0 < currency1`
 * (unsigned address comparison). Returns the ordered pair plus
 * `tokenIsCurrency0` so callers can derive swap direction (`zeroForOne`)
 * without re-implementing the comparison. Throws if the two addresses are equal.
 */
export function orderCurrencies(
  token: Address,
  diem: Address,
): { currency0: Address; currency1: Address; tokenIsCurrency0: boolean } {
  const t = getAddress(token);
  const d = getAddress(diem);
  if (t.toLowerCase() === d.toLowerCase()) {
    throw new Error('token and DIEM must be different addresses');
  }
  const tokenIsCurrency0 = t.toLowerCase() < d.toLowerCase();
  return tokenIsCurrency0
    ? { currency0: t, currency1: d, tokenIsCurrency0: true }
    : { currency0: d, currency1: t, tokenIsCurrency0: false };
}
