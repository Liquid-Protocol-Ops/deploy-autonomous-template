// Transaction destination-allowlist — the signing chokepoint's last line of defence.
//
// Threat model: a hijacked, prompt-injected, or buggy agent constructs an
// arbitrary `{ to, data, value }` and pushes it through the TxSender. Without a
// destination check, the wallet signs it — draining funds to an attacker address.
//
// This module wraps a TxSender so that, BEFORE signing, the destination `to` is
// checked against an allowlist. The allowlist is SELF-MAINTAINING: it is built
// from the protocol ADDRESSES constants map plus the agent's own wallet address.
// Every legitimate on-chain destination the harness writes to already lives in
// ADDRESSES (DIEM, FEE_LOCKER, NFPM_V3, VVV, sVVV, …), so no legitimate call site
// breaks — only unknown destinations (attacker contracts) are rejected.
//
// Fails CLOSED:
//   - Unknown `to`            → throws TxDestinationNotAllowed
//   - Missing / undefined `to`→ throws (no contract-creation path exists through
//                               this chokepoint; allowing `to: undefined` would
//                               let an attacker deploy + selfdestruct-sweep).
//   - value > TX_MAX_VALUE_WEI→ throws (only when the cap env is set; default off).
//
// Extensibility (both OFF by default beyond the constants set):
//   - allowedTargets?: string[]  — extra destinations merged in by the caller/tests
//                                  (e.g. testnet/fork overrides of VVV / sVVV).
//   - TX_EXTRA_ALLOWED env        — comma-separated extra destinations.

import type { Address, Hex } from 'viem';
import { ADDRESSES } from '../../platform/constants.js';

// Structural shape of the params a TxSender receives. `value` is optional and was
// not part of the original TxSender signature; adding it here is backward
// compatible (existing callers pass only { to, data }).
export type TxParams = { to?: Address; data: Hex; value?: bigint };

export type TxSenderFn = (params: TxParams) => Promise<Hex>;

const ENV_EXTRA_ALLOWED = 'TX_EXTRA_ALLOWED';
const ENV_MAX_VALUE_WEI = 'TX_MAX_VALUE_WEI';

const isHexAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);

/**
 * Build the lowercase destination allowlist set.
 *
 * Sources (all normalized to lowercase):
 *   1. Every address in the protocol ADDRESSES constants map.
 *   2. The agent's own wallet address (self-sends / approvals to self).
 *   3. Optional extra targets passed in by the caller.
 *   4. Optional extra targets from the TX_EXTRA_ALLOWED env (comma-separated).
 *
 * Malformed entries (not 20-byte hex) are ignored so a typo can never silently
 * widen the set to something unintended.
 */
export function buildAllowedDestinations(
  selfAddress: Address | undefined,
  allowedTargets: readonly string[] = [],
): Set<string> {
  const set = new Set<string>();

  for (const addr of Object.values(ADDRESSES)) {
    set.add(addr.toLowerCase());
  }

  if (selfAddress && isHexAddress(selfAddress)) set.add(selfAddress.toLowerCase());

  const envExtra = (process.env[ENV_EXTRA_ALLOWED] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const candidate of [...allowedTargets, ...envExtra]) {
    if (isHexAddress(candidate)) set.add(candidate.toLowerCase());
  }

  return set;
}

/**
 * Read the optional per-tx value cap from TX_MAX_VALUE_WEI.
 * Returns undefined when unset/empty (no cap). Throws if set to a non-integer.
 */
export function readValueCap(): bigint | undefined {
  const raw = process.env[ENV_MAX_VALUE_WEI];
  if (raw === undefined || raw.trim() === '') return undefined;
  try {
    return BigInt(raw.trim());
  } catch {
    throw new Error(`${ENV_MAX_VALUE_WEI} is malformed (expected an integer wei amount)`);
  }
}

export type GuardOptions = {
  /** Extra destinations merged into the allowlist (beyond ADDRESSES + self). */
  allowedTargets?: readonly string[];
  /**
   * Per-tx value cap in wei. Defaults to reading TX_MAX_VALUE_WEI.
   * Pass `null` to force "no cap" regardless of env (used by tests).
   */
  maxValueWei?: bigint | null;
};

/**
 * Wrap a TxSender so every outgoing tx is checked against the destination
 * allowlist (and the optional value cap) before it is signed/sent.
 *
 * The wrapper is a pure pre-flight guard: if the checks pass it delegates to the
 * inner sender unchanged; otherwise it throws and the inner sender is never
 * invoked (no network/Privy call happens on a rejected tx).
 */
export function guardTxSender(
  inner: TxSenderFn,
  selfAddress: Address | undefined,
  opts: GuardOptions = {},
): TxSenderFn {
  const allowed = buildAllowedDestinations(selfAddress, opts.allowedTargets ?? []);
  const cap =
    opts.maxValueWei === undefined ? readValueCap() : opts.maxValueWei ?? undefined;

  // async so validation failures surface as rejected promises (callers `await`
  // the sender), and so a rejected tx is never passed to the inner sender.
  return async (params: TxParams): Promise<Hex> => {
    const { to, value } = params;

    // Fail closed on contract creation: no legitimate creation path runs through
    // this chokepoint. Allowing it would let an attacker deploy arbitrary code.
    if (to === undefined || to === null) {
      throw new Error(
        'TxDestinationNotAllowed: contract creation (missing `to`) is not permitted through the agent signer',
      );
    }

    if (!allowed.has(to.toLowerCase())) {
      throw new Error(`TxDestinationNotAllowed: ${to}`);
    }

    if (cap !== undefined && value !== undefined && value > cap) {
      throw new Error(
        `TxValueExceedsCap: value ${value} exceeds ${ENV_MAX_VALUE_WEI} cap ${cap}`,
      );
    }

    return inner(params);
  };
}
