---
name: on-chain-monitor
description: Read all on-chain agent state — LP positions, FeeLocker balance, ETH/DIEM wallet balances. Writes to memory/logs/YYYY-MM-DD.md. Run to get a current snapshot without executing any transactions.
---

# On-Chain Monitor

Reads and logs the full on-chain state of the agent wallet without sending any transactions.

## Script

```bash
node --env-file=.env --import tsx scripts/check-portfolio.ts
```

## What it reads

| Source | Data |
|--------|------|
| NFPM `balanceOf` + `tokenOfOwnerByIndex` | All Uniswap v3 position token IDs |
| NFPM `positions(tokenId)` | tickLower, tickUpper, liquidity, tokensOwed0/1 |
| Pool `slot0` | Current tick (for in-range check) |
| FeeLocker `availableFees(feeOwner, token)` | Claimable DIEM |
| ERC-20 `balanceOf` | Wallet DIEM + WETH |
| `eth_getBalance` | Wallet ETH |

## Output

- Console table: one row per position + summary
- Writes `memory/logs/YYYY-MM-DD.md` automatically

## Aeon schedule

```yaml
on-chain-monitor: { enabled: true, schedule: "0 6 * * *", model: "claude-sonnet-4-6" }
```

## ABI notes (critical)

- FeeLocker `availableFees` takes TWO args: `(feeOwner, token)`. Selector: `0x8296535a`
- NFPM tokenId must be passed as BigInt — never manually hex-encode; use viem typed ABI
- `positions()` returns 12 fields; destructure by position, not name

## Addresses (Base mainnet)

| Contract | Address |
|----------|---------|
| NFPM v3 | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` |
| FeeLocker | `0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF` |
| DIEM | `0xF4d97F2da56e8c3098f3a8D538DB630A2606a024` |
| ETH/DIEM pool | `0x8fFf9D6e54bF6dA84e3c09f3C90d7a1B9cC8a3E` |
