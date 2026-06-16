---
name: tick
description: Run one agent tick — claim FeeLocker fees, LP DIEM, run maintenance inference. The core hourly heartbeat of the agent funding loop.
---

# Agent Tick

Runs the full agent funding loop: check balances → claim DIEM → LP → Venice inference.

## Script

The tick skill maps to `harness/tick.ts`:

```bash
node --env-file=.env --import tsx harness/tick.ts
```

## What it does

1. **Check balances** — reads DIEM in wallet, FeeLocker claimable, ETH gas reserve
2. **Claim DIEM** — calls `FeeLocker.claim(feeOwner, token)` if claimable ≥ threshold (0.1 DIEM)
3. **Reinvest to LP** — calls `reinvestToLP(rpcUrl, agentAddress, diemAmount, range, txSender)` in accumulate mode
4. **Venice inference** — routes a maintenance call through Venice if DIEM staked ≥ threshold

## Env vars required

| Var | Purpose |
|-----|---------|
| `AGENT_WALLET` | Agent wallet address |
| `RPC_URL` | Base mainnet RPC |
| `PRIVY_APP_ID` / `PRIVY_APP_SECRET` / `PRIVY_WALLET_ID` | Signing (preferred) |
| `AGENT_PRIVATE_KEY` | Signing fallback (dev only) |
| `AGENT_MODE` | `accumulate` (default) or `build` |

## Aeon schedule

```yaml
tick: { enabled: true, schedule: "0 * * * *" }  # every hour UTC
```

## DRY-RUN RULE

`harness/tick.ts` executes live by default. For testing without transactions:
```bash
DRY_RUN=true node --env-file=.env --import tsx harness/tick.ts
```

## Code path

`harness/tick.ts` → `harness/providers/venice.ts` (claim + staking gate) → `harness/providers/liquidity.ts` (reinvestToLP) → `memory/tool-routing.jsonl` (inference log)
