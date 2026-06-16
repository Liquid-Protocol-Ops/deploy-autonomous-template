---
name: revoke-approvals
description: Revoke all non-zero ERC-20 approvals from the agent wallet to known spenders (NFPM, SwapRouter). Run after any LP or swap operation, and automatically at the end of every tick.
---

# Revoke Approvals

Checks all [token, spender] pairs the agent ever approves and sets any non-zero allowances back to 0.

## Why

LP and swap scripts set `MAX_UINT256` approvals for simplicity. Leaving those standing exposes the wallet to loss if any approved contract is ever exploited. This runs as a post-tick cleanup so approvals never persist across ticks.

## Covered pairs

| Token | Spender |
|-------|---------|
| WETH  | NFPM v3 |
| WETH  | SwapRouter v3 |
| DIEM  | NFPM v3 |
| DIEM  | SwapRouter v3 |

## Script

```bash
# Dry-run (read-only check)
node --env-file=.env --import tsx scripts/revoke-approvals.ts --dry-run

# Live
node --env-file=.env --import tsx scripts/revoke-approvals.ts
```

## Tick integration

`revokeStaleApprovals()` is called at the end of every `runTick()` in `harness/tick.ts`. No manual invocation needed during normal operation.

## When to run manually

After any ad-hoc LP or swap script (`close-and-add.ts`, `collect-lp-fees.ts`, `reposition.ts`) to clean up approvals immediately rather than waiting for the next tick.
