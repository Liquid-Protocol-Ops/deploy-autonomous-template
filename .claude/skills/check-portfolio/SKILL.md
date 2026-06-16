---
name: check-portfolio
description: Read all agent on-chain positions via the check-portfolio.ts script. Use this instead of raw curl/cast calls to avoid hex encoding mistakes.
---

# Portfolio Check

Reads wallet balances, FeeLocker claimable DIEM, and Uniswap v3 LP positions via viem.
Always use this script for on-chain reads — never construct raw hex calls manually.

## Run

```bash
node --env-file=.env --import tsx scripts/check-portfolio.ts
# Writes output to memory/logs/YYYY-MM-DD.md
```

Dry-run (no log written):
```bash
node --env-file=.env --import tsx scripts/check-portfolio.ts --no-log
```

## What it checks

| Field | Method | Notes |
|-------|--------|-------|
| ETH balance | `eth_getBalance` | Warn if < 0.002 ETH |
| DIEM wallet | `balanceOf(agent)` on DIEM ERC-20 | |
| VVV/sVVV | `balanceOf(agent)` on VVV + VVV_STAKING | sVVV ≥ 1 = key active |
| FeeLocker | `availableFees(feeOwner, token)` | Both args required — see below |
| LP position | `positions(tokenId)` on NFPM_V3 | tokenId from `memory/lp-positions.jsonl` |
| Pool tick | `slot0()` on ETH_DIEM_V3 pool | In-range = tickLower < tick < tickUpper |

## FeeLocker ABI — common mistake

Both `availableFees` and `claim` take TWO address args `(feeOwner, token)`:

```typescript
// CORRECT
availableFees(agentAddress, ADDRESSES.DIEM)
claim(agentAddress, ADDRESSES.DIEM)

// WRONG — reverts
claim(ADDRESSES.DIEM)  // missing feeOwner
```

Raw selector: `availableFees(address,address)` = `0x8296535a`.

## NFPM tokenId encoding

Always use `format(tokenId, '064x')` to produce the 32-byte padded hex for raw calls.
Never manually compute hex — use `BigInt(tokenId).toString(16).padStart(64, '0')`.

```typescript
// CORRECT
const calldata = '0x99fbab88' + BigInt(5119885).toString(16).padStart(64, '0');

// WRONG — off-by-one digits silently queries wrong position
const calldata = '0x99fbab88' + '000...0004e12d';  // 319789, not 5119885
```

## Current state (2026-05-16)

| Asset | Value |
|-------|-------|
| ETH | 0.000988 (low) |
| sVVV | 4.54 (~$11,190) |
| FeeLocker | 6.75 DIEM claimable |
| LP tokenId 5119885 | [5000,5400] tick=5354 IN RANGE, liquidity=76479966455004343465 |

## After checking

If FeeLocker > 0.1 DIEM: run `scripts/claim.ts` then `scripts/stake-diem.ts`.
If LP out of range: run `scripts/reposition.ts` (has guard — aborts if target range would be single-sided).
