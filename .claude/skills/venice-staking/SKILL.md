---
name: venice-staking
description: Venice AI staking mechanics — two systems (sVVV for API key gate, sDIEM for inference credits) and mintDiem for converting sVVV to DIEM.
---

# Venice Staking

Two completely separate staking systems. Do not confuse them.

## System 1: sVVV — API key gate (one-time)

Staking VVV gives you sVVV, which gates minting a Venice API key.

**Contracts (Base mainnet):**
- VVV token: `0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf`
- VVV staking: `0x321b7ff75154472B18EDb199033fF4D116F340Ff`

**How to stake VVV:**
```bash
# Already implemented — scripts/stake-vvv.ts
node --env-file=.env --import tsx scripts/stake-vvv.ts
```

Flow: `VVV.approve(VVV_STAKING, amount)` → `VVV_STAKING.stake(agentAddress, amount)`

**sVVV is non-transferable.** It is a balance tracked inside VVV_STAKING, not a separate ERC-20.
Minimum: ≥ 1 VVV staked to mint a Venice API key.

## System 2: sDIEM — inference credits (ongoing)

Staking DIEM gives you inference budget on Venice. The DIEM contract is both the ERC-20 and the staking contract — same address.

**Contract (Base mainnet):**
- DIEM (token + staking): `0xF4d97F2da56e8c3098f3a8D538DB630A2606a024`

**How to stake DIEM:**
```solidity
// Single call, no approve needed
DIEM.stake(uint256 amount)
```

```bash
node --env-file=.env --import tsx scripts/stake-diem.ts
```

**Rate:** 1 DIEM staked = $1/day Venice inference budget
**No delegation:** `stake()` credits only `msg.sender`

## mintDiem — burn sVVV to mint DIEM

Converts sVVV (staked VVV) into DIEM for inference.

**IMPORTANT: mintDiem is on VVV_STAKING (proxy), NOT on the VVV token.**

```solidity
// Call on VVV_STAKING (0x321b7ff75154472B18EDb199033fF4D116F340Ff):
VVV_STAKING.mintDiem(uint256 sVVVAmountToLock, uint256 minDiemAmountOut)
// selector: 0x2006efcb
// Burns sVVV from msg.sender, mints DIEM to msg.sender

// Preview the rate (view, no state change):
VVV_STAKING.getDiemAmountOut(uint256 sVvvAmount) returns (uint256 diemAmount)
```

**Real rate (Base mainnet, 2026-05):**
- `getDiemAmountOut(1e18)` returns `1_410_748_706_909_624` (~1.41e15 wei DIEM per 1e18 wei sVVV)
- ≈ **0.00141 DIEM per sVVV** (both in human units)
- For 100 DIEM: need ~70,884 VVV staked (~$10,600 at $0.15/VVV)
- Rate uses a curve; essentially linear at current market sVVV supply (~32M sVVV total)

Used in the `MintDiemPresaleVault` — depositors stake VVV → vault calls mintDiem on VVV_STAKING → DIEM flows to agent wallet.

## Privy gas policy — VVV staking contracts to whitelist

| Contract | Address | Transactions |
|----------|---------|--------------|
| VVV token | `0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf` | `approve(VVV_STAKING, amount)` |
| VVV staking | `0x321b7ff75154472B18EDb199033fF4D116F340Ff` | `stake(agentAddress, amount)` |
| DIEM | `0xF4d97F2da56e8c3098f3a8D538DB630A2606a024` | `stake(amount)` for sDIEM |
| FeeLocker | `0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF` | `claim(feeOwner, token)` |
| NFPM | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` | `mint(...)` for LP positions |

## Pricing (2026-05)
- Claude Opus 4.7: 6 DIEM/1M input, 30 DIEM/1M output
- Llama 3.3 70B: free under VVV staking
- 24 DIEM staked = $24/day = $1/tick at hourly cadence
