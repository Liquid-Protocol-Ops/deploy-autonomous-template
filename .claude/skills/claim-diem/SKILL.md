---
name: claim-diem
description: Claim DIEM from FeeLocker, run accumulate-vs-build analysis, and route earnings to LP or Venice staking. Scheduled every 12 hours via aeon. DRY-RUN BY DEFAULT — pass --live to execute.
---

# Claim DIEM + Allocate

Claims DIEM fees from the FeeLocker contract and routes them per the current strategy mode.

## Script

```bash
# Dry-run (default — always run this first)
node --env-file=.env --import tsx scripts/claim-and-allocate.ts

# Live execution (only after dry-run looks correct)
node --env-file=.env --import tsx scripts/claim-and-allocate.ts --live
```

## Allocation logic

**Accumulate mode** (default, `AGENT_MODE=accumulate` or not set):
- All claimed DIEM ≥ 0.1 threshold → single-sided LP into ETH/DIEM v3 1% pool via `reinvestToLP()`
- WETH buffer: if wallet ETH < 0.003 ETH, live run aborts (insufficient gas reserve)

**Build mode** (`AGENT_MODE=build`, or auto-promoted when daily rate ≥ 0.5 DIEM/day):
- Estimate Venice Opus inference demand from `memory/tool-routing.jsonl` (last 500 calls)
- Stake minimum DIEM for confirmed Venice demand (≤ 30% of total)
- LP the rest

Auto-promotion: if `memory/diem-claims.jsonl` shows ≥ 0.5 DIEM/day over last 7 days, accumulate → build automatically.

## Addresses (Base mainnet)

| Contract | Address |
|----------|---------|
| FeeLocker | `0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF` |
| DIEM ERC-20 | `0xF4d97F2da56e8c3098f3a8D538DB630A2606a024` |
| Agent wallet | `$AGENT_WALLET` |

## ABI note (critical)

Both `availableFees` AND `claim` take TWO address args: `(feeOwner, token)`.
Selector: `0x8296535a`. Calling `claim(address)` with 1 arg silently reverts.

## Logging

Appends to `memory/diem-claims.jsonl` on every run (including dry-runs):
```json
{
  "date": "2026-05-16",
  "timestamp": 1747411783,
  "amountWei": "6978418891095036020",
  "amountDiem": "6.97841889109503602",
  "mode": "accumulate",
  "allocation": { "mode": "accumulate", "lpDiem": "6.978...", ... },
  "dryRun": true
}
```

## Aeon schedule

Runs every 12 hours via `aeon.yml`:
```yaml
claim-diem: { enabled: true, schedule: "0 */12 * * *", model: "claude-sonnet-4-6" }
```

## DRY-RUN RULE

Every transaction must have a dry-run first. Never run `--live` without first reviewing dry-run output showing:
1. Correct claimable amount (matches `availableFees` on-chain)
2. ETH balance above 0.003 reserve
3. Allocation decision makes sense for current mode
