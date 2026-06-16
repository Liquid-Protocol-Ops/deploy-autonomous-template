---
name: capital-allocation
description: Decide how to allocate DIEM between Venice compute staking, WETH swap for x402 API access, Uniswap LP, and Aerodrome LP. Run once per tick before any capital movement.
---

# Capital Allocation Decision Framework

At each tick, the agent holds some DIEM (from FeeLocker claim or wallet dust).
This skill produces a ranked allocation recommendation based on live on-chain data.

## On-chain reads (run first)

```bash
AGENT=$AGENT_WALLET
DIEM=0xF4d97F2da56e8c3098f3a8D538DB630A2606a024

# 1. Wallet DIEM balance
cast call $DIEM "balanceOf(address)(uint256)" $AGENT \
  --rpc-url https://mainnet.base.org

# 2. Claimable DIEM in FeeLocker
cast call 0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF \
  "availableFees(address,address)(uint256)" $AGENT $DIEM \
  --rpc-url https://mainnet.base.org

# 3. DIEM/WETH price — sqrtPriceX96 from ETH/DIEM v3 1% pool slot0
cast call 0x80d995189ecc593672aD4703b250a5e82672EB1D \
  "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" \
  --rpc-url https://mainnet.base.org
# price (DIEM per WETH) = (sqrtPriceX96)^2 / 2^192
# node -e "const s=BigInt('<sqrtPriceX96>'); console.log(Number(s*s*(10n**18n)/(2n**192n))/1e18)"

# 4. ETH/DIEM Uniswap v3 pool — 24h fee income (off-chain via subgraph or tick logs)
#    Approximation: APR = annualised_fees / TVL. Use last known: 655.91% (2026-05-14).
#    Update from: https://app.uniswap.org/explore/pools/base/0x80d995189ecc593672aD4703b250a5e82672EB1D

# 5. Aerodrome VVV/DIEM pool
cast call 0xBb345D35450Bf9EE76F3d2cE214e8e7AC5e1071d \
  "reserve0()(uint256)" --rpc-url https://mainnet.base.org  # VVV reserve
cast call 0xBb345D35450Bf9EE76F3d2cE214e8e7AC5e1071d \
  "reserve1()(uint256)" --rpc-url https://mainnet.base.org  # DIEM reserve
# APR ≈ (24h_volume × fee_rate × 365) / TVL. Last known: ~11.1% (2026-05-14).

# 6. WETH balance (how much ETH the agent already holds for x402/gas)
cast call 0x4200000000000000000000000000000000000006 \
  "balanceOf(address)(uint256)" $AGENT \
  --rpc-url https://mainnet.base.org

# 7. Venice DIEM stake (existing stake, if any)
#    Venice staking contract address: TBD (confirm from venice.ai staking UI)
#    Inference spend last 7 days: check memory/tool-routing.jsonl
```

## Scoring model

### Option A — Stake DIEM on Venice (compute credits)

```
venice_daily_roi = 1 DIEM × ($1/day Venice capacity) / (diem_usd_price)
                 = 1 / diem_usd_price  per day
                 ≈ 0.000071/day at DIEM = $1408  (≈ 26% APR)

use_case: only rational when:
  (a) agent needs Opus reasoning in build mode, AND
  (b) daily inference demand > daily FeeLocker earnings, AND
  (c) venice_daily_roi > uniswap_lp_daily_roi   ← almost never true at LP APR > 100%
```

**Verdict**: Stake only the minimum DIEM required to cover confirmed inference demand.
Do not stake speculatively. Compute any needed Opus budget from tool-routing.jsonl.

### Option B — Swap DIEM → WETH (for x402 API calls)

```
swap_cost  = price_impact(diem_amount, eth_diem_pool_tvl) + 1% fee
weth_value = diem_amount × (1 / diem_per_weth)  ×  weth_usd_price
x402_need  = estimated_x402_calls × cost_per_call_weth

swap_if:
  (a) weth_balance < x402_buffer  (buffer = 0.01 WETH default), AND
  (b) swap_cost < value of x402_calls enabled, AND
  (c) not currently in LP position with this DIEM
```

**Verdict**: Maintain a minimum 0.01 WETH buffer for gas and x402 calls.
Swap only what is needed. At current price (~1.775 DIEM/WETH), 0.02 DIEM ≈ 0.01 WETH.
Do not swap if WETH balance already covers projected x402 spend.

### Option C — LP on Uniswap ETH/DIEM v3 1%

```
uniswap_apr    = annualised(24h_pool_fees / pool_tvl)  ← last known: 655.91%
daily_roi      = uniswap_apr / 365                     ← 1.797%/day
position_type  = single-sided DIEM, tickUpper < currentTick
diem_at_risk   = full amount (no impermanent loss until tick enters range)

use_case: default capital allocation when:
  (a) diem_balance >= stake_threshold (0.1 DIEM), AND
  (b) uniswap_apr > venice_roi × 3 (3× safety margin), AND
  (c) agent is in accumulate mode OR has surplus DIEM beyond Opus budget
```

**Verdict**: Preferred destination for most DIEM. LP > staking at all realistic DIEM prices
until Venice compute demand exceeds daily FeeLocker earnings.

### Option D — LP on Aerodrome VVV/DIEM

```
aerodrome_pool = 0xBb345D35450Bf9EE76F3d2cE214e8e7AC5e1071d
aerodrome_apr  = ~11.1% (TVL $5.92M, volume $898K/day, fee 0.2%)
token_pair     = VVV (Venice governance) + DIEM (Liquid Protocol fee token)

use_case: only if:
  (a) aerodrome_apr > uniswap_apr × 0.5, AND   ← only true if Uniswap APR collapses
  (b) agent holds VVV or can acquire it cheaply, AND
  (c) Aerodrome pool has DIEM-only deposit path
```

**Verdict**: Secondary option. Uniswap ETH/DIEM v3 has 59× higher APR at current rates.
Monitor: if Uniswap APR drops below ~30% and Aerodrome stays above 10%, rebalance.

## Decision algorithm

```typescript
// Pseudocode — implement in tick.ts or a dedicated allocator module

type Allocation = {
  uniswap_lp:    bigint;  // DIEM to LP on Uniswap
  venice_stake:  bigint;  // DIEM to stake for Venice compute
  weth_swap:     bigint;  // DIEM to swap for WETH
  aerodrome_lp:  bigint;  // DIEM to LP on Aerodrome
  hold:          bigint;  // DIEM to hold (dust / below threshold)
};

function allocate(diem: bigint, wethBalance: bigint, mode: 'accumulate' | 'build'): Allocation {
  const WETH_BUFFER   = parseEther('0.01');   // ~0.018 DIEM at current price
  const THRESHOLD     = parseEther('0.1');

  // 1. Top up WETH buffer if needed
  const wethDeficit = wethBalance < WETH_BUFFER ? WETH_BUFFER - wethBalance : 0n;
  const wethSwap    = wethDeficit > 0n ? diemForWeth(wethDeficit) : 0n;
  diem -= wethSwap;

  // 2. In build mode: stake only confirmed Opus demand (from tool-routing.jsonl)
  const veniceStake = mode === 'build' ? computeRequiredStake() : 0n;
  diem -= veniceStake;

  // 3. Everything above threshold goes to Uniswap LP (highest APR)
  const uniswapLp = diem >= THRESHOLD ? diem : 0n;
  const hold      = diem <  THRESHOLD ? diem : 0n;

  return { uniswap_lp: uniswapLp, venice_stake: veniceStake,
           weth_swap: wethSwap, aerodrome_lp: 0n, hold };
}
```

## Fast-model prompt template

Use this as the `systemPrompt` when asking the fast model (llama) to make an allocation call:

```
You are the agent's capital allocator. Given the following live data, output a JSON
allocation decision for the agent's available DIEM.

Live data:
- diem_balance: {{diem_balance}} wei
- weth_balance: {{weth_balance}} wei  
- diem_per_weth: {{diem_per_weth}} (from pool slot0)
- uniswap_eth_diem_apr: {{uniswap_apr}}%
- aerodrome_vvv_diem_apr: {{aerodrome_apr}}%
- venice_stake_daily_roi: {{venice_roi}}% (= 1 / diem_usd × 100)
- agent_mode: {{mode}}
- opus_calls_last_7d: {{opus_calls}}
- x402_calls_planned: {{x402_planned}}

Rules:
1. Maintain 0.01 WETH minimum for gas/x402. Swap DIEM only if below that.
2. In accumulate mode: all DIEM ≥ 0.1 threshold goes to Uniswap LP.
3. In build mode: stake minimum DIEM for confirmed Opus demand; LP the rest.
4. Never stake DIEM speculatively — Venice staking ROI < Uniswap LP APR unless
   LP APR drops below ~30%.
5. Aerodrome: only if Uniswap APR < Aerodrome APR × 2.

Output JSON only:
{
  "uniswap_lp_wei": "...",
  "venice_stake_wei": "...",
  "weth_swap_wei": "...",
  "aerodrome_lp_wei": "...",
  "rationale": "..."
}
```

## Key thresholds to monitor

| Signal | Action |
|--------|--------|
| Uniswap APR < 50% | Re-evaluate — compare Aerodrome |
| Uniswap APR < 11% (Aerodrome parity) | Split 50/50 or move to Aerodrome |
| DIEM price > $5000 | Venice staking ROI rises — re-score |
| x402 calls > 100/day | Increase WETH buffer to 0.05 WETH |
| Daily FeeLocker income > 0.5 DIEM/day | Promote to build mode; stake for Opus |

## Current baseline (2026-05-14)

| Option | APR | Daily ROI | Verdict |
|--------|-----|-----------|---------|
| Uniswap ETH/DIEM v3 1% | 655.91% | 1.797%/day | **Default — highest yield** |
| Venice compute stake | ~26% equiv | 0.071%/day | Only for confirmed Opus demand |
| Aerodrome VVV/DIEM | ~11.1% | 0.030%/day | Monitor; deploy if Uniswap drops |
| WETH swap (x402) | N/A | Utility | Buffer 0.01 WETH; swap minimum needed |

## Relevant contracts

| Contract | Address |
|----------|---------|
| ETH/DIEM Uniswap v3 1% | `0x80d995189ecc593672aD4703b250a5e82672EB1D` |
| Aerodrome VVV/DIEM | `0xBb345D35450Bf9EE76F3d2cE214e8e7AC5e1071d` |
| DIEM ERC-20 | `0xF4d97F2da56e8c3098f3a8D538DB630A2606a024` |
| WETH | `0x4200000000000000000000000000000000000006` |
| NFPM (Uniswap v3) | `0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1` |
| Aerodrome Router | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` |
| FeeLocker | `0xF7d3BE3FC0de76fA5550C29A8F6fa53667B876FF` |
