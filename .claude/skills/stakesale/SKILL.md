---
name: Stakesale
description: Deploy a StakesaleVault for a time-weighted DIEM presale alongside a Liquid Protocol token launch. DIEM holders lock for 30/60/90 days; longer locks earn higher allocation multipliers (1×/2×/3×). DIEM returned after lock expiry.
var: ""
tags: [defi, on-chain, launch, presale, diem]
---

> ⚠ **SUPERSEDED (policy 2026-06-12).** StakesaleVault is replaced by the
> canonical `LiquidPresaleVault` in **stake mode** (1–4 lock tiers, per-address cap, DIEM
> returned at expiry — and note: stake mode does NOT fund the agent). Use the
> `compute-presale` skill instead. This doc is retained for monitoring legacy vaults only.


Deploy a `StakesaleVault` to run a time-weighted DIEM presale for a Liquid Protocol agent token launch.

**Lock tiers and multipliers:**

| Lock | Multiplier | Depositor gets | Agent gets |
|------|------------|----------------|------------|
| 30 days | 1× | DIEM back + token share | Social proof + distribution signal |
| 60 days | 2× | DIEM back + 2× token share | Stronger commitment |
| 90 days | 3× | DIEM back + 3× token share | Strongest commitment |

**Token allocation formula:**
```
weight[depositor] = amount × lockMultiplier
share[depositor]  = weight[depositor] / totalWeight × extensionSupply
```

**Per-address cap:** 10 DIEM max.  
**Deposit window:** configurable at deploy time (2h–30d, default 24h).  
**Lock expiry:** `depositDeadline + chosenLock[depositor]` — all same-tier depositors unlock simultaneously.  
**Dust sweep:** after `depositDeadline + 90d`, anyone may call `sweepDust()` → unallocated tokens → treasury.

## When to run

- When a `memory/launch-queue.jsonl` entry has `"presale": "stakesale"`
- When the agent wants DIEM-holder signaling at launch (no VVV required)
- After `scripts/deploy-stakesale.ts` outputs a vault address (handoff step)

## Required parameters

Check `memory/launch-queue.jsonl` for a pending entry:
```json
{
  "name": "Token Name", "symbol": "SYM", "creator": "0x...",
  "marketcapDiem": 50, "image": "https://...",
  "presale": "stakesale",
  "depositWindowHours": 24,
  "extensionBps": 2000
}
```

Defaults: `depositWindowHours=24`, `extensionBps=2000` (20% of supply).

## Execution

### Step 1 — Deploy the vault

```bash
node --env-file=.env --import tsx scripts/deploy-stakesale.ts \
  --deposit-window-hours 24 \
  --dry-run
# Remove --dry-run to execute.
# Recompile first if needed:
#   cd liquid-protocol-v0 && forge build --contracts src/extensions/StakesaleVault.sol
```

Note the `vaultAddress` and `extensionBps` from output.

### Step 2 — Launch token with vault as extension

```bash
node --env-file=.env --import tsx scripts/launch-diem-token.ts \
  --name "<name>" \
  --symbol "<symbol>" \
  --creator "<creator>" \
  --marketcap-diem <marketcapDiem> \
  --presale-vault <vaultAddress> \
  --extension-bps <extensionBps> \
  --dry-run
# Remove --dry-run to execute.
```

The factory calls `vault.receiveTokens()` → sets `depositDeadline = block.timestamp + depositWindow`.

### Step 3 — Monitor the deposit window

Read vault state via `cast` (read-only):
```bash
VAULT=<vaultAddress>
RPC=${RPC_URL:-https://mainnet.base.org}

cast call $VAULT "depositDeadline()(uint256)"  --rpc-url $RPC
cast call $VAULT "totalDeposited()(uint256)"   --rpc-url $RPC
cast call $VAULT "totalWeight()(uint256)"      --rpc-url $RPC
cast call $VAULT "initialized()(bool)"         --rpc-url $RPC

# Per-depositor (replace DEPOSITOR):
DEPOSITOR=<address>
cast call $VAULT "deposited(address)(uint256)"    $DEPOSITOR --rpc-url $RPC
cast call $VAULT "weight(address)(uint256)"       $DEPOSITOR --rpc-url $RPC
cast call $VAULT "chosenLock(address)(uint256)"   $DEPOSITOR --rpc-url $RPC
cast call $VAULT "getShare(address)(uint256)"     $DEPOSITOR --rpc-url $RPC
cast call $VAULT "lockExpiryOf(address)(uint256)" $DEPOSITOR --rpc-url $RPC
```

Or use `scripts/check-portfolio.ts` for a full agent portfolio snapshot.

### Step 4 — Post-deadline actions (depositor-side)

After `depositDeadline`, depositors call:
- `claimTokens()` — claim weighted pro-rata token allocation (any time after window closes)
- `withdrawDiem()` — reclaim DIEM principal (only after `lockExpiryOf(depositor)`)

Agent has no action to take — DIEM never flows to the agent wallet in this vault.

## After launch

1. Check `memory/launches.jsonl` for `tokenAddress`.
2. Check `memory/presales.jsonl` for vault address.
3. Write log to `memory/logs/${today}.md`:
   ```
   ### stakesale
   - token: <tokenAddress>
   - name: <name> / <symbol>
   - vault: <vaultAddress>
   - depositWindow: <N>h
   - extensionBps: <N>
   - depositDeadline: <timestamp>
   ```
4. Notify via `./notify`:
   ```
   STAKESALE: Launched ${symbol} with time-weighted DIEM presale.
   Vault: ${vaultAddress}
   Window: ${depositWindowHours}h | Deadline: ${depositDeadline}
   30d=1× / 60d=2× / 90d=3× | Cap: 10 DIEM/address
   ```
5. Mark launch-queue entry `"processed": true`.

## Error handling

| Error | Cause | Fix |
|-------|-------|-----|
| `InvalidDepositWindow()` | window < 2h or > 30d | Adjust `--deposit-window-hours` |
| `NotFactory()` | `receiveTokens` called by wrong address | Verify factory address in `platform/constants.ts` |
| `DepositWindowClosed()` | deposit after deadline | Vault window has passed — too late |
| `LockDurationMismatch()` | second deposit with different tier | Depositor must use same lock as first deposit |
| `DepositCapExceeded()` | total > 10 DIEM for address | Depositor at cap — no more deposits allowed |
| Artifact not found | forge build needed | `cd liquid-protocol-v0 && forge build --contracts src/extensions/StakesaleVault.sol` |

Always check agent ETH balance before executing: minimum 0.003 ETH for gas.
