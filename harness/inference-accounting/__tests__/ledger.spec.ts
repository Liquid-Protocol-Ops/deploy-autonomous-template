import { describe, it, expect, beforeEach } from 'vitest';
import { InferenceLedger, LedgerEntry } from '../ledger.js';

describe('InferenceLedger', () => {
  let ledger: InferenceLedger;
  const AGENT_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa01';
  const AGENT_B = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa02';

  beforeEach(() => {
    ledger = new InferenceLedger();
  });

  it('credits an agent with daily allocation', () => {
    ledger.credit(AGENT_A, 500_000_000n);
    expect(ledger.balance(AGENT_A)).toBe(500_000_000n);
  });

  it('debits on inference call', () => {
    ledger.credit(AGENT_A, 500_000_000n);
    ledger.debit(AGENT_A, 100_000_000n);
    expect(ledger.balance(AGENT_A)).toBe(400_000_000n);
  });

  it('rejects debit exceeding balance', () => {
    ledger.credit(AGENT_A, 100_000_000n);
    expect(() => ledger.debit(AGENT_A, 200_000_000n)).toThrow('InsufficientBalance');
  });

  it('tracks multiple agents independently', () => {
    ledger.credit(AGENT_A, 500_000_000n);
    ledger.credit(AGENT_B, 200_000_000n);
    ledger.debit(AGENT_A, 100_000_000n);
    expect(ledger.balance(AGENT_A)).toBe(400_000_000n);
    expect(ledger.balance(AGENT_B)).toBe(200_000_000n);
  });

  it('returns zero balance for unknown agent', () => {
    expect(ledger.balance('0xunknown')).toBe(0n);
  });

  it('serializes and deserializes round-trip', () => {
    ledger.credit(AGENT_A, 500_000_000n);
    ledger.debit(AGENT_A, 100_000_000n);
    const json = ledger.serialize();
    const restored = InferenceLedger.deserialize(json);
    expect(restored.balance(AGENT_A)).toBe(400_000_000n);
  });
});
