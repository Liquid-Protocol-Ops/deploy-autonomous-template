export interface LedgerEntry {
  agent: string;
  balance: bigint; // USD in 6-decimal fixed point
}

export class InferenceLedger {
  private _balances = new Map<string, bigint>();

  credit(agent: string, amount: bigint): void {
    this._balances.set(agent, (this._balances.get(agent) ?? 0n) + amount);
  }

  debit(agent: string, amount: bigint): void {
    const bal = this._balances.get(agent) ?? 0n;
    if (bal < amount) throw new Error('InsufficientBalance');
    this._balances.set(agent, bal - amount);
  }

  balance(agent: string): bigint {
    return this._balances.get(agent) ?? 0n;
  }

  entries(): LedgerEntry[] {
    return [...this._balances.entries()].map(([agent, balance]) => ({ agent, balance }));
  }

  serialize(): string {
    return JSON.stringify(
      [...this._balances.entries()].map(([agent, balance]) => ({
        agent,
        balance: balance.toString(),
      }))
    );
  }

  static deserialize(json: string): InferenceLedger {
    const ledger = new InferenceLedger();
    const entries = JSON.parse(json) as Array<{ agent: string; balance: string }>;
    for (const { agent, balance } of entries) {
      if (typeof agent !== 'string' || typeof balance !== 'string') {
        throw new Error(`LedgerDeserializeError: invalid entry ${JSON.stringify({ agent, balance })}`);
      }
      ledger._balances.set(agent, BigInt(balance));
    }
    return ledger;
  }
}
