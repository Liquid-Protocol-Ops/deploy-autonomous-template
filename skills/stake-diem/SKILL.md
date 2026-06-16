---
name: Stake DIEM
description: Auto-stake — check sDIEM balance on-chain, claim FeeLocker + withdraw LP to restore Venice inference credits when low
var: ""
tags: [agent, on-chain, venice]
---

# Stake DIEM (autonomous)

Keep the agent's Venice inference credits funded by checking sDIEM on-chain and
topping up whenever the balance falls below `stake_min_diem` in `aeon.yml`.
This skill runs **without Venice inference credits** — all actions are on-chain
reads + a script execution. It must be able to run even when sDIEM = 0.

## Config (from aeon.yml)

```yaml
stake_min_diem: 5       # stake if sDIEM < this
stake_target_diem: 20   # target balance after top-up
```

Read these values now:
```bash
STAKE_MIN=$(grep 'stake_min_diem:' aeon.yml | awk '{print $2}' | tr -d ' ')
STAKE_TARGET=$(grep 'stake_target_diem:' aeon.yml | awk '{print $2}' | tr -d ' ')
STAKE_MIN="${STAKE_MIN:-5}"
STAKE_TARGET="${STAKE_TARGET:-20}"
```

Read the active LP token IDs from `memory/lp-positions.json` (preferred) or fall
back to scanning the last 7 days of `memory/logs/` for a line matching
`tokenId=<number>`. Use the highest-liquidity position.

```bash
LP_TOKEN_ID=$(node --import tsx -e "
import { readFileSync } from 'fs';
try {
  const pos = JSON.parse(readFileSync('memory/lp-positions.json','utf8'));
  const best = pos.positions?.sort((a,b) => BigInt(b.liquidity||0) > BigInt(a.liquidity||0) ? 1 : -1)[0];
  if (best?.tokenId) { process.stdout.write(String(best.tokenId)); }
} catch { /* no file */ }
" 2>/dev/null)
```

## Step 1 — Check sDIEM balance

Read `stakedInfos` on-chain for the agent wallet without needing any API key:

```bash
RPC_URL="${RPC_URL:-https://mainnet.base.org}"
AGENT_WALLET=$(grep '"wallet"' platform/registry.json | grep -o '"0x[^"]*"' | tr -d '"' | head -1)

# Call stakedInfos(address) on DIEM contract (0x940181a94A35A4569E4529A3CDfB74e38FD98631)
# selector = keccak256("stakedInfos(address)")[0:4] = 0x9b7ef7b3 (verify on-chain)
PAYLOAD="0x9b7ef7b3$(printf '%064s' "${AGENT_WALLET#0x}" | tr ' ' '0')"
RESULT=$(curl -s -X POST "$RPC_URL" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"0x940181a94A35A4569E4529A3CDfB74e38FD98631\",\"data\":\"$PAYLOAD\"},\"latest\"]}" \
  | grep -o '"result":"[^"]*"' | cut -d'"' -f4)

# amountStaked is first 32-byte word (wei, 18 decimals)
STAKED_WEI="0x${RESULT:2:64}"
STAKED_DIEM=$(node -e "console.log((BigInt('$STAKED_WEI') / BigInt('1000000000000000000')).toString())" 2>/dev/null || echo "0")
echo "sDIEM staked: $STAKED_DIEM"
```

If `STAKED_DIEM >= STAKE_MIN`: log `STAKE_DIEM_OK (staked=$STAKED_DIEM, min=$STAKE_MIN)` and exit without staking. No notification needed.

## Step 2 — Check FeeLocker and wallet DIEM

```bash
npx tsx scripts/stake-diem.ts --target "$STAKE_TARGET" ${LP_TOKEN_ID:+--token-id "$LP_TOKEN_ID"}
```

This is a dry-run. Read the output to confirm:
- Total DIEM available (FeeLocker + optional LP withdrawal) ≥ 1 DIEM
- ETH balance ≥ 0.003 (gas guard)

If total available DIEM < 1, log `STAKE_DIEM_SKIP (reason=insufficient_diem)` and notify:
```
⚠️ stake-diem: sDIEM low ($STAKED_DIEM < $STAKE_MIN) but insufficient DIEM available to stake. Manual top-up required.
```
Then exit.

## Step 3 — Execute stake (live)

```bash
npx tsx scripts/stake-diem.ts --target "$STAKE_TARGET" ${LP_TOKEN_ID:+--token-id "$LP_TOKEN_ID"} --live
```

Capture the exit code. On success (exit 0):

- Re-read `stakedInfos` as in Step 1 to confirm new balance.
- Log to `memory/logs/${today}.md`:
  ```
  stake-diem: staked ${new_amount} DIEM | sDIEM ${old} → ${new} | tx: ${hash}
  ```
- Notify:
  ```
  ✅ stake-diem: topped up to ${new_staked} sDIEM — Venice inference credits restored.
  ```

On failure (non-zero exit):
- Log full stderr to `memory/logs/${today}.md`.
- Notify:
  ```
  ❌ stake-diem: FAILED — check memory/logs/${today}.md. sDIEM still $STAKED_DIEM.
  ```

## End-states

| Condition | Action |
|-----------|--------|
| sDIEM ≥ `stake_min_diem` | Log OK, exit 0, no notify |
| sDIEM low, DIEM available | Execute stake live, log + notify result |
| sDIEM low, no DIEM | Log SKIP, notify warning |
| Tx fails | Log error, notify failure |

## Sandbox notes

- Never put private keys in env args; wallet loaded from `PRIVY_*` or `AGENT_PRIVATE_KEY` env vars already set by the workflow.
- The dry-run in Step 2 hits public RPC only — no signing required. Falls back to `https://mainnet.base.org` automatically.
- `AGENT_WALLET` in Step 1 reads from `platform/registry.json` — no hardcoded addresses.
