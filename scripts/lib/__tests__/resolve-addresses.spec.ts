import { describe, it, expect } from 'vitest';
import { getAddress } from 'viem';
import {
  DIEM_ADDRESS,
  requireAddressEnv,
  resolveCreator,
  orderCurrencies,
} from '../resolve-addresses';

// Real Base mainnet addresses used as fixtures.
const AUTONO = '0xB3D7e0c3C39A1D3F1B304663065A2F83Ddf56d8e'; // < DIEM
const AGENT  = '0x8767Df39eCeeaeB11554642237aC4E08660aB6A3';
const ABOVE_DIEM = '0xffffffffffffffffffffffffffffffffffffffff'; // > DIEM

describe('DIEM_ADDRESS', () => {
  it('is the checksummed DIEM mainnet address', () => {
    expect(DIEM_ADDRESS).toBe(getAddress('0xf4d97f2da56e8c3098f3a8d538db630a2606a024'));
  });
});

describe('requireAddressEnv', () => {
  it('returns the checksummed address when set', () => {
    expect(requireAddressEnv({ TOKEN: AUTONO.toLowerCase() }, 'TOKEN')).toBe(getAddress(AUTONO));
  });

  it('trims surrounding whitespace', () => {
    expect(requireAddressEnv({ TOKEN: `  ${AUTONO}  ` }, 'TOKEN')).toBe(getAddress(AUTONO));
  });

  it('throws when the var is unset', () => {
    expect(() => requireAddressEnv({}, 'TOKEN')).toThrow(/TOKEN is required/);
  });

  it('throws when the var is blank', () => {
    expect(() => requireAddressEnv({ TOKEN: '   ' }, 'TOKEN')).toThrow(/TOKEN is required/);
  });

  it('includes the hint in the error', () => {
    expect(() => requireAddressEnv({}, 'TOKEN', 'set the agent token')).toThrow(/set the agent token/);
  });

  it('throws when the value is not an address', () => {
    expect(() => requireAddressEnv({ TOKEN: '0xnope' }, 'TOKEN')).toThrow(/not a valid address/);
  });
});

describe('resolveCreator', () => {
  it('accepts an explicit --creator that equals the agent wallet', () => {
    expect(resolveCreator(AGENT, { AGENT_WALLET: AGENT })).toBe(getAddress(AGENT));
  });

  it('falls back to AGENT_WALLET when no arg', () => {
    expect(resolveCreator(undefined, { AGENT_WALLET: AGENT })).toBe(getAddress(AGENT));
  });

  it('throws when neither arg nor env is provided', () => {
    expect(() => resolveCreator(undefined, {})).toThrow(/--creator|AGENT_WALLET/);
  });

  it('throws on a malformed address', () => {
    expect(() => resolveCreator('0xdead', {})).toThrow(/not a valid address/);
  });

  // Fail-closed creator guard — a non-agent creator redirects token admin + fees.
  it('rejects a non-agent creator that is not allow-listed', () => {
    expect(() => resolveCreator(AUTONO, { AGENT_WALLET: AGENT })).toThrow(/allow-list/i);
  });

  it('permits a non-agent creator when allow-listed via LAUNCH_CREATOR_ALLOWLIST', () => {
    expect(
      resolveCreator(AUTONO, { AGENT_WALLET: AGENT, LAUNCH_CREATOR_ALLOWLIST: AUTONO }),
    ).toBe(getAddress(AUTONO));
  });

  it('permits an allow-listed creator among several (comma-separated, spaces ok)', () => {
    expect(
      resolveCreator(AUTONO, { AGENT_WALLET: AGENT, LAUNCH_CREATOR_ALLOWLIST: `${ABOVE_DIEM}, ${AUTONO}` }),
    ).toBe(getAddress(AUTONO));
  });

  it('does not pin when AGENT_WALLET is unset (no agent identity to protect)', () => {
    expect(resolveCreator(AUTONO, {})).toBe(getAddress(AUTONO));
  });

  it('throws when AGENT_WALLET is set but malformed (fails loud, not open)', () => {
    expect(() => resolveCreator(AUTONO, { AGENT_WALLET: '0xnotanaddress' }))
      .toThrow(/AGENT_WALLET is set but not a valid address/);
  });
});

describe('orderCurrencies', () => {
  it('puts the lower address as currency0 (token below DIEM)', () => {
    const r = orderCurrencies(getAddress(AUTONO), DIEM_ADDRESS);
    expect(r.tokenIsCurrency0).toBe(true);
    expect(r.currency0).toBe(getAddress(AUTONO));
    expect(r.currency1).toBe(DIEM_ADDRESS);
  });

  it('flips ordering when the token sorts above DIEM', () => {
    const r = orderCurrencies(getAddress(ABOVE_DIEM), DIEM_ADDRESS);
    expect(r.tokenIsCurrency0).toBe(false);
    expect(r.currency0).toBe(DIEM_ADDRESS);
    expect(r.currency1).toBe(getAddress(ABOVE_DIEM));
  });

  it('throws when token and DIEM are the same', () => {
    expect(() => orderCurrencies(DIEM_ADDRESS, DIEM_ADDRESS)).toThrow(/different addresses/);
  });
});
