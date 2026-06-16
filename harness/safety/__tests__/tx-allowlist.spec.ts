import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  buildAllowedDestinations,
  guardTxSender,
  readValueCap,
  type TxParams,
} from '../tx-allowlist.js';
import { ADDRESSES } from '../../../platform/constants.js';

// A deterministic agent wallet address used as `selfAddress`.
const SELF = '0x14791697260E4c9A71f18484C9f997B308e59325' as Address;
// An address that is in NO allowlist source — the attacker destination.
const ATTACKER = '0xBADbADbadBADBaDBAdbAdbADBaDbadBaDBaDbAD0' as Address;
const KNOWN = ADDRESSES.NFPM_V3; // a real protocol contract from the constants map
const DATA = '0xabcd' as Hex;
const OK_HASH = '0xfeedface' as Hex;

// A fake inner sender: records what it was called with and returns a fixed hash.
// Using this proves the guard never touches the real network/Privy.
function fakeSender() {
  const calls: TxParams[] = [];
  const fn = vi.fn(async (params: TxParams) => {
    calls.push(params);
    return OK_HASH;
  });
  return { fn, calls };
}

describe('buildAllowedDestinations', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env['TX_EXTRA_ALLOWED']; delete process.env['TX_EXTRA_ALLOWED']; });
  afterEach(() => { if (saved === undefined) delete process.env['TX_EXTRA_ALLOWED']; else process.env['TX_EXTRA_ALLOWED'] = saved; });

  it('includes every protocol ADDRESSES contract (lowercased)', () => {
    const set = buildAllowedDestinations(SELF);
    for (const addr of Object.values(ADDRESSES)) {
      expect(set.has(addr.toLowerCase())).toBe(true);
    }
  });

  it('includes the agent self address', () => {
    const set = buildAllowedDestinations(SELF);
    expect(set.has(SELF.toLowerCase())).toBe(true);
  });

  it('merges allowedTargets and ignores malformed entries', () => {
    const set = buildAllowedDestinations(SELF, [ATTACKER, 'not-an-address', '']);
    expect(set.has(ATTACKER.toLowerCase())).toBe(true);
    expect(set.has('not-an-address')).toBe(false);
  });

  it('merges TX_EXTRA_ALLOWED from env (comma-separated)', () => {
    process.env['TX_EXTRA_ALLOWED'] = `${ATTACKER} , 0x0000000000000000000000000000000000000abc`;
    const set = buildAllowedDestinations(SELF);
    expect(set.has(ATTACKER.toLowerCase())).toBe(true);
    expect(set.has('0x0000000000000000000000000000000000000abc')).toBe(true);
  });
});

describe('readValueCap', () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env['TX_MAX_VALUE_WEI']; });
  afterEach(() => { if (saved === undefined) delete process.env['TX_MAX_VALUE_WEI']; else process.env['TX_MAX_VALUE_WEI'] = saved; });

  it('returns undefined when unset (no cap)', () => {
    delete process.env['TX_MAX_VALUE_WEI'];
    expect(readValueCap()).toBeUndefined();
  });

  it('returns undefined when empty', () => {
    process.env['TX_MAX_VALUE_WEI'] = '   ';
    expect(readValueCap()).toBeUndefined();
  });

  it('parses an integer wei amount', () => {
    process.env['TX_MAX_VALUE_WEI'] = '1000000000000000000';
    expect(readValueCap()).toBe(1_000_000_000_000_000_000n);
  });

  it('throws on a malformed cap', () => {
    process.env['TX_MAX_VALUE_WEI'] = '1.5eth';
    expect(() => readValueCap()).toThrow(/TX_MAX_VALUE_WEI is malformed/);
  });
});

describe('guardTxSender — destination allowlist', () => {
  let savedExtra: string | undefined;
  let savedCap: string | undefined;
  beforeEach(() => {
    savedExtra = process.env['TX_EXTRA_ALLOWED'];
    savedCap = process.env['TX_MAX_VALUE_WEI'];
    delete process.env['TX_EXTRA_ALLOWED'];
    delete process.env['TX_MAX_VALUE_WEI'];
  });
  afterEach(() => {
    if (savedExtra === undefined) delete process.env['TX_EXTRA_ALLOWED']; else process.env['TX_EXTRA_ALLOWED'] = savedExtra;
    if (savedCap === undefined) delete process.env['TX_MAX_VALUE_WEI']; else process.env['TX_MAX_VALUE_WEI'] = savedCap;
    vi.clearAllMocks();
  });

  // (a) a tx to a known ADDRESSES contract is allowed
  it('allows a tx to a known ADDRESSES contract and delegates to the inner sender', async () => {
    const { fn, calls } = fakeSender();
    const guarded = guardTxSender(fn, SELF);
    const hash = await guarded({ to: KNOWN, data: DATA });
    expect(hash).toBe(OK_HASH);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0]!.to).toBe(KNOWN);
  });

  it('allows a tx to the agent self address', async () => {
    const { fn } = fakeSender();
    const guarded = guardTxSender(fn, SELF);
    await expect(guarded({ to: SELF, data: DATA })).resolves.toBe(OK_HASH);
  });

  it('allows the Venice VVV / sVVV staking destinations (in ADDRESSES)', async () => {
    const { fn } = fakeSender();
    const guarded = guardTxSender(fn, SELF);
    await expect(guarded({ to: ADDRESSES.VVV, data: DATA })).resolves.toBe(OK_HASH);
    await expect(guarded({ to: ADDRESSES.VVV_STAKING, data: DATA })).resolves.toBe(OK_HASH);
  });

  // (b) a tx to a random/attacker address throws — and never reaches the sender
  it('rejects a tx to an unknown/attacker address and never calls the inner sender', async () => {
    const { fn } = fakeSender();
    const guarded = guardTxSender(fn, SELF);
    await expect(guarded({ to: ATTACKER, data: DATA })).rejects.toThrow(
      `TxDestinationNotAllowed: ${ATTACKER}`,
    );
    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects contract creation (missing `to`) — fail closed', async () => {
    const { fn } = fakeSender();
    const guarded = guardTxSender(fn, SELF);
    await expect(guarded({ data: DATA } as TxParams)).rejects.toThrow(/TxDestinationNotAllowed/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('matches destinations case-insensitively', async () => {
    const { fn } = fakeSender();
    const guarded = guardTxSender(fn, SELF);
    await expect(guarded({ to: KNOWN.toUpperCase() as Address, data: DATA })).resolves.toBe(OK_HASH);
  });

  // (c) the allowedTargets / env extension works
  it('allows an extra destination passed via allowedTargets', async () => {
    const { fn } = fakeSender();
    const guarded = guardTxSender(fn, SELF, { allowedTargets: [ATTACKER] });
    await expect(guarded({ to: ATTACKER, data: DATA })).resolves.toBe(OK_HASH);
  });

  it('allows an extra destination passed via TX_EXTRA_ALLOWED env', async () => {
    process.env['TX_EXTRA_ALLOWED'] = ATTACKER;
    const { fn } = fakeSender();
    const guarded = guardTxSender(fn, SELF);
    await expect(guarded({ to: ATTACKER, data: DATA })).resolves.toBe(OK_HASH);
  });
});

describe('guardTxSender — value cap', () => {
  let savedCap: string | undefined;
  beforeEach(() => { savedCap = process.env['TX_MAX_VALUE_WEI']; delete process.env['TX_MAX_VALUE_WEI']; });
  afterEach(() => { if (savedCap === undefined) delete process.env['TX_MAX_VALUE_WEI']; else process.env['TX_MAX_VALUE_WEI'] = savedCap; vi.clearAllMocks(); });

  // (d) the value cap throws when exceeded ...
  it('throws when value exceeds TX_MAX_VALUE_WEI and never calls the inner sender', async () => {
    process.env['TX_MAX_VALUE_WEI'] = '1000';
    const { fn } = fakeSender();
    const guarded = guardTxSender(fn, SELF);
    await expect(guarded({ to: KNOWN, data: DATA, value: 1001n })).rejects.toThrow(/TxValueExceedsCap/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('allows value equal to the cap', async () => {
    process.env['TX_MAX_VALUE_WEI'] = '1000';
    const { fn } = fakeSender();
    const guarded = guardTxSender(fn, SELF);
    await expect(guarded({ to: KNOWN, data: DATA, value: 1000n })).resolves.toBe(OK_HASH);
  });

  // ... and is inert when unset (the LP-mint large-value path must not be capped)
  it('does not cap value when TX_MAX_VALUE_WEI is unset (default off)', async () => {
    delete process.env['TX_MAX_VALUE_WEI'];
    const { fn } = fakeSender();
    const guarded = guardTxSender(fn, SELF);
    const huge = 10n ** 30n; // way above any sane cap
    await expect(guarded({ to: KNOWN, data: DATA, value: huge })).resolves.toBe(OK_HASH);
  });

  it('honors an explicit maxValueWei option over the env', async () => {
    process.env['TX_MAX_VALUE_WEI'] = '1000'; // would reject 1001
    const { fn } = fakeSender();
    // maxValueWei: null forces "no cap" regardless of env.
    const guarded = guardTxSender(fn, SELF, { maxValueWei: null });
    await expect(guarded({ to: KNOWN, data: DATA, value: 1001n })).resolves.toBe(OK_HASH);
  });
});

describe('zero-address / undefined selfAddress (review note #47)', () => {
  const ZERO = '0x0000000000000000000000000000000000000000' as Address;

  it('does NOT allow-list the zero address when selfAddress is undefined', () => {
    const set = buildAllowedDestinations(undefined);
    expect(set.has(ZERO.toLowerCase())).toBe(false);
  });

  it('still allow-lists a real selfAddress when provided', () => {
    const set = buildAllowedDestinations(SELF);
    expect(set.has(SELF.toLowerCase())).toBe(true);
  });

  it('guardTxSender with no selfAddress rejects a send to the zero address', async () => {
    const { fn } = fakeSender();
    const guarded = guardTxSender(fn, undefined);
    await expect(guarded({ to: ZERO, data: DATA })).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});
