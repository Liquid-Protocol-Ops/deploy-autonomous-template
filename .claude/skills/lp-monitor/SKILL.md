---
name: lp-monitor
description: Check LP position health — in-range status, tick proximity to bounds, FeeLocker balance, earnings rate. Alerts if position needs repositioning or if DIEM is claimable above threshold.
---

# LP Monitor

Daily health check for the agent's Uniswap v3 LP positions. Reads on-chain state and flags conditions requiring action.

## Script

```bash
node --env-file=.env --import tsx scripts/check-portfolio.ts
```

(Same underlying script as `on-chain-monitor`; the LP-specific interpretation is in the output.)

## What to check

| Condition | Flag | Action |
|-----------|------|--------|
| Position OUT OF RANGE | ⚠ warn | Consider repositioning via `lp-remove` + `lp-add` |
| Tick within 50 ticks of bound | ⚠ warn | Monitor more frequently |
| FeeLocker ≥ 0.1 DIEM | ✓ info | Ready for `claim-diem` |
| tokensOwed1 > 0 | ✓ info | Fees in NFPM, collect via reposition |
| ETH < 0.003 | ⚠ warn | Top up before any live transactions |

## Position: tokenId 5119885

Current range: [5000, 5400] on ETH/DIEM v3 1% pool.
Status as of 2026-05-16: IN RANGE at tick ~5354.

## Repositioning scripts

```bash
# Full reposition (remove + add at new range)
node --env-file=.env --import tsx scripts/reposition.ts             # dry-run
node --env-file=.env --import tsx scripts/reposition.ts --live      # execute
```

## Aeon schedule

```yaml
lp-monitor: { enabled: true, schedule: "0 12 * * *", model: "claude-sonnet-4-6" }
```

## Earnings tracking

Daily snapshots at 23:55 UTC via `track-earnings` skill → `memory/earnings.jsonl`.
Use the delta column to track DIEM accrual rate per day.
