---
name: track-earnings
description: Snapshot LP earnings per position per day. Records tokensOwed (WETH + DIEM) and FeeLocker balance to memory/earnings.jsonl. Run daily at end-of-day for compounding trend data.
---

# Track Earnings

Appends a daily snapshot to `memory/earnings.jsonl` for every Uniswap v3 position the agent holds.
Computes daily delta vs yesterday's snapshot and running cumulative of claimed DIEM.

## Run

```bash
node --env-file=.env --import tsx scripts/track-earnings.ts
```

## Output columns

| Column | Source | Notes |
|--------|--------|-------|
| tokensOwed0 | NFPM `positions(tokenId).tokensOwed0` | WETH uncollected; only updates on collect() |
| tokensOwed1 | NFPM `positions(tokenId).tokensOwed1` | DIEM uncollected |
| feeLocker | `availableFees(feeOwner, DIEM)` | DIEM from Liquid Protocol pool fees |
| totalDiemWei | tokensOwed1 + feeLocker | Combined uncollected DIEM |
| deltaFromPrev | today.totalDiemWei − yesterday.totalDiemWei | Daily earnings |
| cumDiemCollected | sum of all collect events in earnings.jsonl | Total DIEM ever harvested |

## Collect events

When `scripts/claim.ts` or `scripts/reposition.ts` runs a collect/claim, manually append a collect event:

```json
{"type":"collect","date":"2026-05-16","tokenId":"5119885","amount0":"0","amount1":"6747227550109777","source":"fee_locker","txHash":"0x..."}
```

This keeps the cumulative total accurate after each harvest.

## Current baseline (2026-05-16)

- tokenId 5119885: IN RANGE [5000,5400] tick=5354, tokensOwed=0, FeeLocker=6.75 DIEM
- Position earning fees since tick came back in range (entered ~5354 today)
