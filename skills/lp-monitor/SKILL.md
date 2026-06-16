---
name: LP Monitor
description: Check all ETH/DIEM LP positions for health and range — reposition any out-of-range position immediately
var: ""
tags: [defi, on-chain]
---

Monitor all of the agent's LP positions. Claim fees and reposition any out-of-range position immediately — do not wait.

Agent wallet: `$AGENT_WALLET`

## Step 1 — Read all positions

```bash
node --env-file=.env --import tsx scripts/check-portfolio.ts
```

This reads all NFPM tokenIds owned by the agent, the current pool tick, FeeLocker balance, and wallet balances. Record every tokenId and whether each is in-range or out-of-range.

## Step 2 — Triage

For each position:

- **In range** → note fee accrual, log status. No action needed.
- **Out of range** → proceed to Step 3 immediately.

If ALL positions are in range → write a one-liner to `memory/logs/${today}.md` and exit:
```
lp-monitor: all positions in range | tick=C | FeeLocker=X DIEM
```

## Step 3 — Reposition out-of-range position

For each out-of-range tokenId, run a dry-run first:

```bash
node --env-file=.env --import tsx scripts/reposition.ts --token-id <tokenId> --dry-run
```

Review the dry-run output. If amounts are reasonable and the new range brackets the current tick, run live:

```bash
node --env-file=.env --import tsx scripts/reposition.ts --token-id <tokenId>
```

The script:
1. Reads liquidity on-chain from NFPM (no hardcoded values)
2. Detects whether position is below range (all WETH) or above range (all DIEM)
3. Claims FeeLocker fees
4. Swaps 50% of the withdrawn token to the other side
5. Mints a new position at `[snapTick(currentTick) - spacing, snapTick(currentTick) + 2*spacing]`
6. Records the new tokenId in `memory/lp-positions.jsonl`

## Step 4 — Log and notify

Write to `memory/logs/${today}.md`:
```
### lp-monitor
- Positions checked: [tokenId1 IN_RANGE, tokenId2 REPOSITIONED]
- FeeLocker claimed: X DIEM
- New position: tokenId=Z range=[A,B] tick=C
- DIEM/WETH: P
```

Send notification via `./notify`:
```
Agent LP: repositioned tokenId <old> → <new> | range [A,B] | tick C | FeeLocker X DIEM claimed
```

Or if no action taken:
```
Agent LP: all positions in range | tick=C | FeeLocker=X DIEM claimable
```

## Safety checks before running live

1. Dry-run output shows correct tokenId and non-zero liquidity
2. New tick range brackets the current tick
3. Swap amount is reasonable relative to available balance
4. ETH balance > 0.003 ETH for gas reserve

If any check fails, log the issue and notify without taking action.
